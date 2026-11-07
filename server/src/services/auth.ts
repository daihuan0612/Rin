import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext, Variables } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { setJWTCookie, clearJWTCookie } from "../core/hono-middleware";
import { inviteCodes, users } from "../db/schema";
import { CacheImpl } from "../utils/cache";
import { normalizeInviteCode } from "./invite";
import {
    BadRequestError,
    ForbiddenError,
    InternalServerError,
} from "../errors";

/**
 * 密码哈希（2026-11-07 交叉审查后升级）
 *
 * 原来是无盐单轮 SHA-256：同一个密码哈希永远相同、可被彩虹表/GPU 秒破。
 * 现在改成 PBKDF2-SHA256 + 每个用户独立随机盐，存成 `pbkdf2$<轮数>$<盐b64>$<哈希b64>`。
 * 轮数只给 1 万不是不够狠，是 Cloudflare 免费档的 CPU 预算有限 —— 登录接口不能因为
 * 加盐慢哈希直接超时。老库里 64 位十六进制的无盐哈希继续认（见 verifyPassword），
 * 并且**登录成功时顺手升级**，不需要谁去重设密码。
 */
const PBKDF2_ITERATIONS = 10_000;
const PBKDF2_PREFIX = "pbkdf2";

/** 登录失败限流：同 IP 10 分钟内最多 10 次失败 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" } as Pbkdf2Params,
        key,
        256,
    );
    return new Uint8Array(bits);
}

/** 老格式用到的无盐 SHA-256，只为了兼容库里已有的哈希 */
async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常数时间比较，别按字符逐位泄露前缀 */
export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

/** 认新格式，也认老的无盐 SHA-256 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) {
        return false;
    }

    if (stored.startsWith(`${PBKDF2_PREFIX}$`)) {
        const [, iterationsRaw, saltRaw, hashRaw] = stored.split("$");
        const iterations = Number(iterationsRaw);
        if (!Number.isInteger(iterations) || iterations <= 0 || !saltRaw || !hashRaw) {
            return false;
        }
        const derived = await pbkdf2(password, base64ToBytes(saltRaw), iterations);
        return timingSafeEqual(bytesToBase64(derived), hashRaw);
    }

    return timingSafeEqual(await sha256Hex(password), stored);
}

/** 老格式（无盐 SHA-256 / 空）才需要重新哈希 —— 新格式每次登录重算盐纯属浪费 */
export function needsRehash(stored: string | null | undefined): boolean {
    return !stored || !stored.startsWith(`${PBKDF2_PREFIX}$`);
}

/** 取客户端 IP：优先 Cloudflare 的头，别信 x-forwarded-for 的第一段以外的东西 */
function clientIp(c: AppContext): string {
    return c.req.header('cf-connecting-ip')
        || c.req.header('x-real-ip')
        || (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
        || '';
}

/**
 * 限流专用存储。
 * ⚠️ 不能复用 `c.get('cache')`：那是公共内容缓存，`cache.enabled=false` 时 get/set 直接空转
 * （cache.ts 的 isEnabled 只 gate type === 'cache'），限流会连带失效。
 * 用独立 type 就绕开了那道开关，也不会被文章失效时的 deletePrefix 顺手清掉。
 */
function rateLimitStore(c: AppContext): CacheImpl {
    // ⚠️ storageMode 必须钉死 'database'：不传就跟着 env.CACHE_STORAGE_MODE 走，
    // 而它的默认值是 's3'。S3 不可用时 S3StorageProvider 只打日志、把异常吞掉，
    // 计数永远为空 —— 安全计数不能挂在一个"失败即静默清空"的存储上。
    return new CacheImpl(c.get('db'), c.get('env'), 'ratelimit', 'database');
}

export function PasswordAuthService(): Hono<{
        Bindings: Env;
        Variables: Variables;
    }> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    // Login with username and password
    app.post("/login", async (c: AppContext) => {
        const jwt = c.get('jwt');
        const db = c.get('db');
        const env = c.env;

        // Check if admin credentials are configured
        const adminUsername = env.ADMIN_USERNAME;
        const adminPassword = env.ADMIN_PASSWORD;

        if (!adminUsername || !adminPassword) {
            throw new BadRequestError('Admin credentials not configured');
        }

        const { username, password } = await profileAsync(c, 'auth_login_parse', () => c.req.json()) as { username: string; password: string };

        if (!username || !password) {
            throw new BadRequestError('Username and password are required');
        }

        // 登录失败限流：挡在线爆破（以前登录接口完全没有限流，只有注册有）
        const limiter = rateLimitStore(c);
        const failKey = `login_fail_${clientIp(c)}`;
        const now = Date.now();
        const rawFailures = await profileAsync(c, 'auth_login_rate_get', () => limiter.get(failKey));
        const failureHits: number[] = Array.isArray((rawFailures as any)?.hits) ? (rawFailures as any).hits : [];
        const recentFailures = failureHits.filter((t) => typeof t === 'number' && now - t < LOGIN_WINDOW_MS);
        if (recentFailures.length >= LOGIN_MAX_FAILURES) {
            throw new ForbiddenError('Too many attempts, try again later');
        }

        // 记一次失败再抛：写成 `throw await fail(...)` 是为了让 TS 认出这条分支不会继续往下走
        const fail = async (message: string): Promise<ForbiddenError> => {
            recentFailures.push(Date.now());
            await profileAsync(c, 'auth_login_rate_set', () => limiter.set(failKey, { hits: recentFailures }));
            return new ForbiddenError(message);
        };

        // Check if this is the admin login
        if (username === adminUsername) {
            // 管理员是 env 里的密码，直接比明文；库里那份哈希只是给"普通用户登录"路径用的缓存
            if (!timingSafeEqual(password, adminPassword)) {
                throw await fail('Invalid credentials');
            }

            // Find or create admin user
            let user = await profileAsync(c, 'auth_admin_lookup', () => db.query.users.findFirst({ 
                where: eq(users.openid, "admin") 
            }));

            if (!user) {
                // Create admin user if not exists
                const adminPasswordHash = await hashPassword(adminPassword);
                const result = await profileAsync(c, 'auth_admin_insert', () => db.insert(users).values({
                    username: adminUsername,
                    openid: "admin",
                    avatar: "",
                    permission: 1,
                    password: adminPasswordHash,
                }).returning({ insertedId: users.id }));

                if (!result || result.length === 0) {
                    throw new InternalServerError('Failed to create admin user');
                }

                user = await profileAsync(c, 'auth_admin_reload', () => db.query.users.findFirst({ 
                    where: eq(users.id, result[0].insertedId) 
                }));
            }

            if (!user) {
                throw new InternalServerError('Failed to get admin user');
            }

            // env 里的密码改了、或者库里还是老的 SHA-256，就在这里同步一次
            if (needsRehash(user.password) || user.username !== adminUsername) {
                const nextHash = needsRehash(user.password)
                    ? await hashPassword(adminPassword)
                    : user.password;
                await profileAsync(c, 'auth_admin_sync', () => db.update(users)
                    .set({ password: nextHash, username: adminUsername })
                    .where(eq(users.id, user.id)));
            }

            await profileAsync(c, 'auth_login_rate_clear', () => limiter.delete(failKey));

            // Generate JWT token
            const token = await profileAsync(c, 'auth_admin_token', () => jwt.sign({ id: user.id }));

            // Set JWT cookie using Hono helper
            setJWTCookie(c, token);

            return c.json({
                success: true,
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar,
                    permission: user.permission === 1,
                }
            });
        }

        // Regular user login (if we want to support multiple users with passwords in the future)
        const user = await profileAsync(c, 'auth_user_lookup', () => db.query.users.findFirst({ 
            where: eq(users.username, username) 
        }));

        if (!user || !user.password) {
            throw await fail('Invalid credentials');
        }

        // 被作者停用的账号：能验证密码，但不给登录
        if (user.disabled === 1) {
            throw await fail('Account disabled');
        }

        if (!(await verifyPassword(password, user.password))) {
            throw await fail('Invalid credentials');
        }

        // 老的无盐哈希：这次密码刚好是对的，就地升级成 PBKDF2
        if (needsRehash(user.password)) {
            const upgraded = await hashPassword(password);
            await profileAsync(c, 'auth_user_rehash', () => db.update(users)
                .set({ password: upgraded })
                .where(eq(users.id, user.id)));
        }

        await profileAsync(c, 'auth_login_rate_clear', () => limiter.delete(failKey));

        // Generate JWT token
        const token = await profileAsync(c, 'auth_user_token', () => jwt.sign({ id: user.id }));

        // Set JWT cookie using Hono helper
        setJWTCookie(c, token);

        return c.json({
            success: true,
            token: token,
            user: {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                permission: user.permission === 1,
            }
        });
    });

    /**
     * POST /auth/register —— 邀请码注册（一次一码），注册成功直接登录
     *
     * 为什么没有"申请 → 审核"这一步：作者发码给谁，谁就能自己注册完。
     * 码上那句备注会写进用户的 `note`，所以"码 → 人 → 用户名"永远对得上。
     * 密码只存哈希（和 admin 同一套），库里没有明文。
     */
    app.post("/register", async (c: AppContext) => {
        const db = c.get('db');
        const jwt = c.get('jwt');
        // ⚠️ 限流不能用 c.get('cache')：那是公共内容缓存，`cache.enabled` 关掉后
        // get 恒 null / set 直接 return，限流会跟着失效（见 rateLimitStore 注释）
        const limiter = rateLimitStore(c);

        if (!jwt) {
            throw new InternalServerError('Auth is not configured');
        }

        const ip = clientIp(c);

        // 简单限流：同一 IP 10 分钟内最多 8 次注册尝试（邀请码本身已经是主要防线，这层挡脚本）
        const rateKey = `reg_try_${ip}`;
        const now = Date.now();
        const windowMs = 10 * 60 * 1000;
        const raw = await profileAsync(c, 'auth_register_rate_get', () => limiter.get(rateKey));
        const hits: number[] = Array.isArray((raw as any)?.hits) ? (raw as any).hits : [];
        const recent = hits.filter((t) => typeof t === 'number' && now - t < windowMs);
        if (recent.length >= 8) {
            throw new ForbiddenError('Too many attempts, try again later');
        }
        recent.push(now);
        await profileAsync(c, 'auth_register_rate_set', () => limiter.set(rateKey, { hits: recent }));

        const body = await profileAsync(c, 'auth_register_parse', () => c.req.json()) as {
            username?: string;
            password?: string;
            invite?: string;
            signupNote?: string;
        };

        const username = (body.username || '').trim();
        const password = body.password || '';
        const signupNote = (body.signupNote || '').trim().slice(0, 200);

        if (!/^[\w\u4e00-\u9fa5]{2,20}$/u.test(username)) {
            throw new BadRequestError('Invalid username');
        }
        if (password.length < 6 || password.length > 72) {
            throw new BadRequestError('Invalid password');
        }

        // 邀请码：忽略大小写/空格/横杠
        const normalized = normalizeInviteCode(body.invite || '');
        if (normalized.length !== 8) {
            throw new BadRequestError('Invalid invite code');
        }
        const code = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

        const invite = await profileAsync(c, 'auth_register_invite', () =>
            db.query.inviteCodes.findFirst({ where: eq(inviteCodes.code, code) })
        );
        if (!invite || invite.revoked || invite.used_by) {
            throw new ForbiddenError('Invalid invite code');
        }

        const exists = await profileAsync(c, 'auth_register_username', () =>
            db.query.users.findFirst({ where: eq(users.username, username) })
        );
        if (exists) {
            throw new BadRequestError('Username already taken');
        }

        const hashedPassword = await profileAsync(c, 'auth_register_hash', () => hashPassword(password));

        /**
         * ⚠️ 顺序：**先建用户 → 再用条件更新抢码（同时写 used_by）**。
         *
         * 旧写法是「先抢码，`set({ used_at })`，条件 `isNull(used_by)`」，而 `used_by`
         * 要等建完用户才写 —— 并发时两个请求的条件同时成立，两次更新都成功、两个用户都建出来，
         * 一枚码注册出两个人，后写的 used_by 还把先注册者的对应关系顶掉。
         *
         * 现在把 `used_by` 一起写进条件更新：只有一条能命中；没抢到的把刚建的用户删掉。
         */
        let insertedId: number | null = null;
        try {
            const result = await profileAsync(c, 'auth_register_insert', () =>
                db.insert(users).values({
                    username,
                    // password 用户没有 GitHub 身份，用 local: 前缀合成一个，满足 NOT NULL
                    openid: `local:${username}`,
                    avatar: '',
                    password: hashedPassword,
                    permission: 0,
                    // 备注跟着邀请码走：码上写"给老王的"，这个用户的备注就是"老王"
                    note: invite.note || '',
                    signup_note: signupNote,
                    signup_ip: ip,
                    disabled: 0,
                }).returning({ insertedId: users.id })
            );
            if (!result || result.length === 0) {
                throw new InternalServerError('Failed to create user');
            }
            insertedId = result[0].insertedId;
        } catch (error) {
            // 注意：库里 `users.username` **没有**唯一约束（schema.ts），并发同名这一层
            // 目前其实挡不住；这里留着只是兜住"以后加了唯一索引"的情况。跟本次修复无关。
            if (String((error as any)?.message || '').toUpperCase().includes('UNIQUE')) {
                throw new BadRequestError('Username already taken');
            }
            throw error;
        }

        if (insertedId === null) {
            throw new InternalServerError('Failed to create user');
        }
        const newUserId = insertedId;

        const claimed = await profileAsync(c, 'auth_register_claim', () =>
            db.update(inviteCodes)
                .set({ used_at: new Date(), used_by: newUserId })
                .where(and(eq(inviteCodes.id, invite.id), isNull(inviteCodes.used_by)))
                .returning({ id: inviteCodes.id })
        );
        if (!claimed || claimed.length === 0) {
            // 码在这中间被别人抢走了：把这次建出来的账号删掉，别留下"没花钱就进站"的用户
            await profileAsync(c, 'auth_register_rollback', () =>
                db.delete(users).where(eq(users.id, newUserId))
            ).catch(() => undefined);
            throw new ForbiddenError('Invalid invite code');
        }

        const token = await profileAsync(c, 'auth_register_token', () => jwt.sign({ id: newUserId }));
        setJWTCookie(c, token);

        return c.json({
            success: true,
            token,
            user: {
                id: newUserId,
                username,
                avatar: '',
                permission: false,
            },
        });
    });

    // 进站方式：只有「密码登录（作者）」和「邀请码注册（读者）」
    // 原先这里还会返回 github 字段，GitHub OAuth 已整套删掉，不再有第二种登录方式
    app.get("/status", async (c: AppContext) => {
        const env = c.env;

        return c.json({
            password: !!(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
        });
    });
    return app;
}
