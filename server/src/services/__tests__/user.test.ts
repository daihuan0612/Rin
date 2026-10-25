import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { UserService } from '../user';
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Variables, JWTUtils } from "../../core/hono-types";
import { setupTestApp, TestCacheImpl, cleanupTestDB, createMockEnv } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

describe('UserService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;

    beforeEach(async () => {
        const ctx = await setupTestApp(UserService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        
        // Add error handler
        app.onError((err, c) => {
            const error = err as any;
            if (error.code && error.statusCode) {
                return c.json({
                    success: false,
                    error: {
                        code: error.code,
                        message: error.message,
                        details: error.details,
                    },
                }, error.statusCode as any);
            }
            return c.json({
                success: false,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: err.message || 'An unexpected error occurred',
                },
            }, 500);
        });
        
        // Seed test data
        await seedTestData(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function seedTestData(sqlite: Database) {
        sqlite.exec(`
            INSERT INTO users (id, username, avatar, permission, openid) VALUES 
                (1, 'user1', 'avatar1.png', 0, 'gh_123'),
                (2, 'admin', 'admin.png', 1, 'gh_456')
        `);
    }

    // GitHub OAuth 路由已删除（作者不需要 GitHub 登录），对应的两条 describe 一并移除。

    describe('GET /profile - Get user profile', () => {
        it('should return user profile', async () => {
            const res = await app.request('/profile', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' }
            }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.id).toBe(1);
            expect(data.username).toBe('user1');
            expect(data.avatar).toBe('avatar1.png');
            expect(data.permission).toBe(false);
        });

        it('should return admin permission for admin user', async () => {
            const res = await app.request('/profile', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_2' }
            }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.permission).toBe(true);
        });

        it('should require authentication', async () => {
            const res = await app.request('/profile', { method: 'GET' }, env);
            
            expect(res.status).toBe(403);
        });
    });

    describe('PUT /profile - Update profile', () => {
        it('should update username', async () => {
            const res = await app.request('/profile', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username: 'newname' }),
            }, env);
            
            expect(res.status).toBe(200);
            
            // Verify update
            const dbResult = sqlite.prepare(`SELECT username FROM users WHERE id = 1`).all() as any[];
            expect(dbResult[0]?.username).toBe('newname');
        });

        it('should update avatar', async () => {
            const res = await app.request('/profile', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ avatar: 'https://new-avatar.png' }),
            }, env);
            
            expect(res.status).toBe(200);
            
            const dbResult = sqlite.prepare(`SELECT avatar FROM users WHERE id = 1`).all() as any[];
            expect(dbResult[0]?.avatar).toBe('https://new-avatar.png');
        });

        it('should require authentication', async () => {
            const res = await app.request('/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'test' }),
            }, env);
            
            expect(res.status).toBe(403);
        });

        it('should require at least one field', async () => {
            const res = await app.request('/profile', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({}),
            }, env);
            
            expect(res.status).toBe(400);
        });
    });

    describe('POST /logout - Logout', () => {
        it('should clear token cookie', async () => {
            const res = await app.request('/logout', { method: 'POST' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toBeDefined();
        });
    });
});
