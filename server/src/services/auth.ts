import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext, Variables } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { setJWTCookie, clearJWTCookie } from "../core/hono-middleware";
import { inviteCodes, users } from "../db/schema";
import { normalizeInviteCode } from "./invite";
import {
    BadRequestError,
    ForbiddenError,
    InternalServerError,
} from "../errors";

// Hash password using SHA-256
async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
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

        // Hash the provided password
        const hashedPassword = await profileAsync(c, 'auth_login_hash', () => hashPassword(password));

        // Check if this is the admin login
        if (username === adminUsername) {
            const expectedHash = await profileAsync(c, 'auth_admin_hash', () => hashPassword(adminPassword));
            
            if (hashedPassword !== expectedHash) {
                throw new ForbiddenError('Invalid credentials');
            }

            // Find or create admin user
            let user = await profileAsync(c, 'auth_admin_lookup', () => db.query.users.findFirst({ 
                where: eq(users.openid, "admin") 
            }));

            if (!user) {
                // Create admin user if not exists
                const result = await profileAsync(c, 'auth_admin_insert', () => db.insert(users).values({
                    username: adminUsername,
                    openid: "admin",
                    avatar: "",
                    permission: 1,
                    password: expectedHash,
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

            if (user.password !== expectedHash) {
                // Update admin password if changed
                await profileAsync(c, 'auth_admin_sync', () => db.update(users)
                    .set({ password: expectedHash, username: adminUsername })
                    .where(eq(users.id, user.id)));
            }

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
            throw new ForbiddenError('Invalid credentials');
        }

        // 被作者停用的账号：能验证密码，但不给登录
        if (user.disabled === 1) {
            throw new ForbiddenError('Account disabled');
        }

        if (user.password !== hashedPassword) {
            throw new ForbiddenError('Invalid credentials');
        }

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
        const cache = c.get('cache');

        if (!jwt) {
            throw new InternalServerError('Auth is not configured');
        }

        const ip = c.req.header('cf-connecting-ip')
            || c.req.header('x-real-ip')
            || (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
            || '';

        // 简单限流：同一 IP 10 分钟内最多 8 次注册尝试（邀请码本身已经是主要防线，这层挡脚本）
        const rateKey = `reg_try_${ip}`;
        const now = Date.now();
        const windowMs = 10 * 60 * 1000;
        const raw = await profileAsync(c, 'auth_register_rate_get', () => cache.get(rateKey));
        const hits: number[] = Array.isArray((raw as any)?.hits) ? (raw as any).hits : [];
        const recent = hits.filter((t) => typeof t === 'number' && now - t < windowMs);
        if (recent.length >= 8) {
            throw new ForbiddenError('Too many attempts, try again later');
        }
        recent.push(now);
        await profileAsync(c, 'auth_register_rate_set', () => cache.set(rateKey, { hits: recent }));

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

        // 先抢码（条件更新，并发下只有一个请求能成功），再建用户
        const claimed = await profileAsync(c, 'auth_register_claim', () =>
            db.update(inviteCodes)
                .set({ used_at: new Date() })
                .where(and(eq(inviteCodes.id, invite.id), isNull(inviteCodes.used_by)))
                .returning({ id: inviteCodes.id })
        );
        if (!claimed || claimed.length === 0) {
            throw new ForbiddenError('Invalid invite code');
        }

        let insertedId: number;
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
            // 建用户失败就把码放回去，别让它白白作废
            await profileAsync(c, 'auth_register_release', () =>
                db.update(inviteCodes).set({ used_at: null }).where(eq(inviteCodes.id, invite.id))
            ).catch(() => undefined);
            throw error;
        }

        await profileAsync(c, 'auth_register_bind', () =>
            db.update(inviteCodes).set({ used_by: insertedId }).where(eq(inviteCodes.id, invite.id))
        );

        const token = await profileAsync(c, 'auth_register_token', () => jwt.sign({ id: insertedId }));
        setJWTCookie(c, token);

        return c.json({
            success: true,
            token,
            user: {
                id: insertedId,
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
