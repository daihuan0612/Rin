// Hono middleware for Rin server
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import type { AppContext, Variables, JWTUtils } from "./hono-types";
import { eq } from "drizzle-orm";
import { profileAsync } from "./server-timing";

// Lazy initialization container
class LazyInitContainer {
    private env: Env;
    private instances: Map<string, any> = new Map();
    private initializing: Map<string, Promise<any>> = new Map();

    constructor(env: Env) {
        this.env = env;
    }

    async get<T>(key: string, factory: () => Promise<T>): Promise<T> {
        if (this.instances.has(key)) {
            return this.instances.get(key);
        }

        if (this.initializing.has(key)) {
            return this.initializing.get(key);
        }

        const initPromise = factory().then(instance => {
            this.instances.set(key, instance);
            this.initializing.delete(key);
            return instance;
        });

        this.initializing.set(key, initPromise);
        return initPromise;
    }
}

// Create container per request
export const initContainerMiddleware = createMiddleware<{
    Bindings: Env;
    Variables: Variables;
}>(async (c, next) => {
    await profileAsync(c, "init_container", async () => {
        const container = new LazyInitContainer(c.env);

        const db = await container.get('db', async () => profileAsync(c, "init_db", async () => {
            const schema = await import('../db/schema');
            return drizzle(c.env.DB, { schema });
        }));

        const cache = await container.get('cache', async () => profileAsync(c, "init_cache", async () => {
            const { CacheImpl } = await import('../utils/cache');
            const clientConfig = await container.get('clientConfig', async () => profileAsync(c, "init_client_config", async () => {
                const { CacheImpl } = await import('../utils/cache');
                return new CacheImpl(db, c.env, "client.config");
            }));
            return new CacheImpl(db, c.env, "cache", undefined, clientConfig);
        }));

        const serverConfig = await container.get('serverConfig', async () => profileAsync(c, "init_server_config", async () => {
                const { CacheImpl } = await import('../utils/cache');
                return new CacheImpl(db, c.env, "server.config", "database");
            }));

        const clientConfig = await container.get('clientConfig', async () => profileAsync(c, "init_client_config", async () => {
                const { CacheImpl } = await import('../utils/cache');
                return new CacheImpl(db, c.env, "client.config");
            }));

        const jwt = await container.get('jwt', async () => profileAsync(c, "init_jwt", async () => {
            const { default: createJWT } = await import('../utils/jwt');
            const secret = c.env.JWT_SECRET;
            if (!secret) {
                throw new Error('JWT_SECRET is not set');
            }
            return createJWT(secret);
        }));

        // ⚠️ GitHub OAuth 已整套删除（用户要求「完全删掉，后台设置里也别看到」）：
        // 不再初始化 oauth2、也不再往 context 里塞。真要恢复，需要同时恢复
        // utils/oauth.ts、user.ts 的两条路由、auth.ts 的 status 字段和前端登录入口。

        c.set('db', db);
        c.set('cache', cache);
        c.set('serverConfig', serverConfig);
        c.set('clientConfig', clientConfig);
        c.set('jwt', jwt);
        c.set('admin', false);
        c.set('env', c.env);
    });

    await next();
});

// Auth middleware - derive user from JWT
export const authMiddleware = createMiddleware<{
    Bindings: Env;
    Variables: Variables;
}>(async (c, next) => {
    await profileAsync(c, "auth_middleware", async () => {
        const jwt = c.get('jwt');
        const db = c.get('db');

        const token = await profileAsync(c, "auth_token", () => {
            const authHeader = c.req.header('authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                return authHeader.substring(7);
            }
            return getCookie(c, 'token');
        });

        if (token && jwt) {
            const profile = await profileAsync(c, "auth_verify", () => jwt.verify(token));
            if (profile) {
                const { users } = await import("../db/schema");
                const user = await profileAsync(c, "auth_user_lookup", () => db.query.users.findFirst({
                    where: eq(users.id, profile.id)
                }));

                // 被作者停用的账号当作未登录：拿不到隐藏段、也不能评论
                if (user && user.disabled !== 1) {
                    c.set('uid', user.id);
                    c.set('username', user.username);
                    c.set('admin', user.permission === 1);
                }
            }
        }
    });

    await next();
});

// Helper to set JWT cookie
export function setJWTCookie(c: AppContext, token: string) {
    setCookie(c, 'token', token, {
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
    });
}

// Helper to clear JWT cookie
export function clearJWTCookie(c: AppContext) {
    setCookie(c, 'token', '', {
        expires: new Date(0),
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
    });
}
