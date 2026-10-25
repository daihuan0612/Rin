import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { Variables } from '../../core/hono-types';
import { setupTestApp, createTestUser, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';
import type { TestCacheImpl } from '../../../tests/fixtures';
import { PasswordAuthService } from '../auth';
import { InviteService, normalizeInviteCode } from '../invite';

describe('邀请码注册', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let cache: TestCacheImpl;

    beforeEach(async () => {
        const ctx = await setupTestApp(() => {
            const inner = new Hono();
            inner.route('/auth', PasswordAuthService());
            inner.route('/invite', InviteService());
            return inner;
        }, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin123' } as any);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        cache = ctx.cache;
        // 测试夹具没挂全局错误处理器，这里补一个：把 ForbiddenError / BadRequestError 映射成对应状态码
        app.onError((err: any, c: any) =>
            c.json({ error: { code: err.code, message: err.message } }, (err.statusCode ?? 500) as any)
        );
        await createTestUser(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    function makeInvite(code: string, note = '') {
        sqlite.prepare("INSERT INTO invite_codes (code, note) VALUES (?, ?)").run(code, note);
    }

    function register(body: Record<string, unknown>) {
        return app.request('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, env);
    }

    it('有效邀请码：建号成功、直接返回 token、备注从码带过来、码被标记已用', async () => {
        makeInvite('AAAA-BBBB', '老王 大学同学');

        const res = await register({ username: '小明', password: 'secret123', invite: 'aaaa-bbbb' });
        expect(res.status).toBe(200);

        const data = await res.json() as any;
        expect(data.success).toBe(true);
        expect(data.token).toStartWith('mock_token_');
        expect(data.user.username).toBe('小明');
        expect(data.user.permission).toBe(false);

        const row = sqlite.prepare('SELECT username, note, signup_ip, permission, password, openid FROM users WHERE username = ?').get('小明') as any;
        expect(row.note).toBe('老王 大学同学');   // 备注跟着注册码走 —— "不管他起什么网名，我都知道他是谁"
        expect(row.permission).toBe(0);
        expect(row.password).not.toBe('secret123'); // 库里没有明文
        expect(row.openid).toBe('local:小明');

        const invite = sqlite.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get('AAAA-BBBB') as any;
        expect(invite.used_by).toBe(data.user.id);
    });

    it('注册完能用这套用户名密码登录（评论、看正文都靠它）', async () => {
        makeInvite('CCCC-DDDD', '给小李');
        await register({ username: 'xiaoli', password: 'secret123', invite: 'CCCC-DDDD' });

        const login = await app.request('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'xiaoli', password: 'secret123' }),
        }, env);

        expect(login.status).toBe(200);
        const data = await login.json() as any;
        expect(data.success).toBe(true);
        expect(data.user.permission).toBe(false);
    });

    it('同一枚码第二次用 ⇒ 拒绝，且不会建出第二个用户', async () => {
        makeInvite('EEEE-FFFF');
        const first = await register({ username: 'userA', password: 'secret123', invite: 'EEEE-FFFF' });
        expect(first.status).toBe(200);

        const second = await register({ username: 'userB', password: 'secret123', invite: 'EEEE-FFFF' });
        expect(second.status).toBe(403);

        const count = sqlite.prepare('SELECT COUNT(*) as c FROM users WHERE openid LIKE ?').get('local:%') as any;
        expect(count.c).toBe(1);
    });

    it('码不存在 / 被作废 ⇒ 拒绝', async () => {
        const missing = await register({ username: 'userC', password: 'secret123', invite: 'ZZZZ-ZZZZ' });
        expect(missing.status).toBe(403);

        makeInvite('GGGG-HHHH');
        sqlite.prepare("UPDATE invite_codes SET revoked = 1 WHERE code = 'GGGG-HHHH'").run();
        const revoked = await register({ username: 'userD', password: 'secret123', invite: 'GGGG-HHHH' });
        expect(revoked.status).toBe(403);
    });

    it('用户名重复 / 非法 / 密码太短 ⇒ 400，码不消耗', async () => {
        makeInvite('JJJJ-KKKK');

        const dup = await register({ username: 'testuser', password: 'secret123', invite: 'JJJJ-KKKK' });
        expect(dup.status).toBe(400);

        const badName = await register({ username: 'a b', password: 'secret123', invite: 'JJJJ-KKKK' });
        expect(badName.status).toBe(400);

        const shortPw = await register({ username: 'okname', password: '123', invite: 'JJJJ-KKKK' });
        expect(shortPw.status).toBe(400);

        const invite = sqlite.prepare("SELECT used_by FROM invite_codes WHERE code = 'JJJJ-KKKK'").get() as any;
        expect(invite.used_by).toBeNull(); // 失败不该把码吃掉
    });

    it('账号被停用后不能登录', async () => {
        makeInvite('LLLL-MMMM');
        await register({ username: 'banned', password: 'secret123', invite: 'LLLL-MMMM' });
        sqlite.prepare("UPDATE users SET disabled = 1 WHERE username = 'banned'").run();

        const login = await app.request('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'banned', password: 'secret123' }),
        }, env);

        expect(login.status).toBe(403);
    });

    it('同一 IP 短时间狂试会被限流', async () => {
        for (let i = 0; i < 9; i++) {
            await register({ username: `brute${i}`, password: 'secret123', invite: 'QQQQ-QQQQ' });
        }
        const res = await register({ username: 'brute9', password: 'secret123', invite: 'QQQQ-QQQQ' });
        expect(res.status).toBe(403);
    });

    it('邀请码输入容错：大小写、横杠、空格都不影响', () => {
        expect(normalizeInviteCode('k7qp-3mz9')).toBe('K7QP3MZ9');
        expect(normalizeInviteCode(' K7QP 3MZ9 ')).toBe('K7QP3MZ9');
    });

    it('生成邀请码：只有作者能调，码形如 XXXX-XXXX 且带备注', async () => {
        const denied = await app.request('/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: 1 }),
        }, env);
        expect(denied.status).toBe(403);

        const res = await app.request('/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock_token_1' },
            body: JSON.stringify({ count: 3, note: '给老张' }),
        }, env);
        expect(res.status).toBe(200);

        const data = await res.json() as any;
        expect(data.created).toHaveLength(3);
        for (const code of data.created) {
            expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        }

        const note = sqlite.prepare('SELECT note FROM invite_codes WHERE code = ?').get(data.created[0]) as any;
        expect(note.note).toBe('给老张');
    });

    it('码列表只给作者，已用的能看出是谁注册的', async () => {
        makeInvite('NNNN-PPPP', '给小王');
        await register({ username: 'wang', password: 'secret123', invite: 'NNNN-PPPP' });

        const denied = await app.request('/invite', { method: 'GET' }, env);
        expect(denied.status).toBe(403);

        const res = await app.request('/invite', {
            method: 'GET',
            headers: { Authorization: 'Bearer mock_token_1' },
        }, env);
        expect(res.status).toBe(200);

        const data = await res.json() as any;
        const used = data.list.find((item: any) => item.code === 'NNNN-PPPP');
        expect(used.usedBy).toBeGreaterThan(0);
        expect(used.usedByName).toBe('wang');
        expect(used.note).toBe('给小王');
        expect(data.summary.used).toBeGreaterThanOrEqual(1);
    });
});
