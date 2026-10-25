// Hono context types for Rin server
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Context as HonoContext } from "hono";

export type DB = DrizzleD1Database<typeof import("../db/schema")>;

export interface JWTUtils {
    sign(payload: any): Promise<string>;
    verify(token: string): Promise<any | null>;
}

// GitHub OAuth 已整套删除，不再有 OAuth2Utils（原 generateState / createRedirectUrl / authorize 接口）

export interface CacheImpl {
    get(key: string): Promise<any | null>;
    set(key: string, value: any, save?: boolean): Promise<void>;
    delete(key: string, save?: boolean): Promise<void>;
    deletePrefix(prefix: string): Promise<void>;
    getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T>;
    getOrDefault<T>(key: string, defaultValue: T): Promise<T>;
    getBySuffix(suffix: string): Promise<any[]>;
    all(): Promise<Map<string, any>>;
    save(): Promise<void>;
    clear(): Promise<void>;
}

export interface Variables {
    db: DB;
    cache: CacheImpl;
    serverConfig: CacheImpl;
    clientConfig: CacheImpl;
    jwt: JWTUtils;
    uid?: number;
    admin: boolean;
    username?: string;
    env: Env;
}

export type AppContext = HonoContext<{
    Bindings: Env;
    Variables: Variables;
}>;
