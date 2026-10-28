import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { FeedService } from '../feed';
import { buildQueueStatusResponse } from '../config-queue-status';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, createTestUser, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';
import type { TestCacheImpl } from '../../../tests/fixtures';

describe('FeedService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let cache: TestCacheImpl;
    let serverConfig: TestCacheImpl;
    let clientConfig: TestCacheImpl;

    beforeEach(async () => {
        const ctx = await setupTestApp(FeedService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        cache = ctx.cache;
        serverConfig = ctx.serverConfig;
        clientConfig = ctx.clientConfig;
        
        // Create test user
        await createTestUser(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });



    describe('GET / - List feeds', () => {
        it('should list published feeds', async () => {
            // Create feeds via API
            const res1 = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Test Feed 1',
                    content: 'Content 1',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            expect(res1.status).toBe(200);
            
            const res2 = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Test Feed 2',
                    content: 'Content 2',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            expect(res2.status).toBe(200);
            
            const listRes = await app.request('/?page=1&limit=10', { method: 'GET' }, env);
            
            expect(listRes.status).toBe(200);
            const data = await listRes.json() as any;
            expect(data.size).toBe(2);
            expect(data.data).toBeArray();
        });

        it('should return empty list when no feeds exist', async () => {
            const res = await app.request('/', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.size).toBe(0);
            expect(data.data).toEqual([]);
        });

        it('should filter drafts for non-admin users', async () => {
            // Create a draft feed
            await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Draft Feed',
                    content: 'Draft Content',
                    listed: true,
                    draft: true,
                    tags: [],
                }),
            }, env);
            
            const res = await app.request('/?type=draft', { method: 'GET' }, env);
            
            expect(res.status).toBe(403);
        });

        it('should allow admin to view drafts', async () => {
            // Create a draft feed
            await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Draft Feed',
                    content: 'Draft Content',
                    listed: true,
                    draft: true,
                    tags: [],
                }),
            }, env);
            
            const res = await app.request('/?type=draft', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.size).toBe(1);
        });

        it('列表摘要也按视角：注册读者在首页能看到 [glass] 原文，游客仍打码', async () => {
            // 注册读者（permission 0）
            sqlite.prepare("INSERT INTO users (id, username, openid, permission) VALUES (9, 'lister', 'lister-openid', 0)").run();

            await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'List tiering',
                    content: '公开开头[glass]给注册读者看的摘要内容[/glass]中间[owner]只有作者能看的摘要内容[/owner]结尾',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            // 游客：两种标记都打码（假字夹在哨兵里，前端据此套毛玻璃），原文一个字都不出去
            const guestRes = await app.request('/', { method: 'GET' }, env);
            const guest = await guestRes.json() as any;
            const guestSummary = guest.data[0].summary as string;
            expect(guestSummary).toContain('公开开头');
            expect(guestSummary).not.toContain('给注册读者看的摘要内容');
            expect(guestSummary).not.toContain('只有作者能看的摘要内容');
            // 不再是一排 `▒` 方块，而是「哨兵 + 假字 + 哨兵」，哨兵是单个控制字符
            expect(guestSummary).not.toContain('▒');
            expect(guestSummary).toContain('\u0001');
            expect(guestSummary).toContain('\u0002');
            expect(guestSummary).toContain('\u0003');
            // 哨兵必须成对：开合数量一致
            expect((guestSummary.match(/\u0001|\u0003/g) ?? []).length).toBe(
                (guestSummary.match(/\u0002/g) ?? []).length,
            );

            // 注册读者：吃不到游客那份缓存，[glass] 是原文，[owner] 仍然打码
            const memberRes = await app.request('/', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_9' },
            }, env);
            const member = await memberRes.json() as any;
            const memberSummary = member.data[0].summary as string;
            expect(memberSummary).toContain('给注册读者看的摘要内容');
            expect(memberSummary).not.toContain('只有作者能看的摘要内容');
            expect(memberRes.headers.get('cache-control')).toContain('private');
            expect(memberRes.headers.get('cache-control')).toContain('no-store');

            // 作者：两段都是原文
            const ownerRes = await app.request('/', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            const owner = await ownerRes.json() as any;
            const ownerSummary = owner.data[0].summary as string;
            expect(ownerSummary).toContain('给注册读者看的摘要内容');
            expect(ownerSummary).toContain('只有作者能看的摘要内容');
        });
    });

    describe('GET /:id - Get single feed', () => {
        it('should return feed by id', async () => {
            // Create a feed first
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Test Feed',
                    content: 'Test Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            
            expect(createRes.status).toBe(200);
            const createData = await createRes.json() as any;
            const feedId = createData.insertedId;
            
            const getRes = await app.request(`/${feedId}`, { method: 'GET' }, env);
            
            expect(getRes.status).toBe(200);
            const data = await getRes.json() as any;
            expect(data.title).toBe('Test Feed');
        });

        it('详情接口的 summary 也按视角给：游客拿不到隐藏段原文，作者拿原文（写作页要还原标记）', async () => {
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Summary leak check',
                    content: '正文',
                    summary: '摘要开头[glass]摘要里的隐藏话[/glass]结尾',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            expect(createRes.status).toBe(200);
            const feedId = (await createRes.json() as any).insertedId;

            // 游客：摘要里不能出现隐藏段原话（F12 / 网络面板也看不到）
            const guestRes = await app.request(`/${feedId}`, { method: 'GET' }, env);
            const guest = await guestRes.json() as any;
            expect(guest.summary).toContain('摘要开头');
            expect(guest.summary).not.toContain('摘要里的隐藏话');
            expect(guest.summary).toContain('\u0001');

            // 作者：原文 + 标记都在（写作页靠它把编辑框还原成 [glass]…[/glass]）
            const ownerRes = await app.request(`/${feedId}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            const owner = await ownerRes.json() as any;
            expect(owner.summary).toContain('[glass]摘要里的隐藏话[/glass]');
        });

        it('should prefer a numeric feed id over another feed numeric alias', async () => {
            const firstRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Previous Feed',
                    alias: '2',
                    content: 'Previous Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            expect(firstRes.status).toBe(200);

            const secondRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Target Feed',
                    content: 'Target Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            expect(secondRes.status).toBe(200);
            const secondData = await secondRes.json() as any;

            const getRes = await app.request(`/${secondData.insertedId}`, { method: 'GET' }, env);

            expect(getRes.status).toBe(200);
            const data = await getRes.json() as any;
            expect(data.id).toBe(secondData.insertedId);
            expect(data.title).toBe('Target Feed');
            expect(data.content).toBe('Target Content');
        });

        it('should return feed by non-numeric alias', async () => {
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Alias Feed',
                    alias: 'custom-slug',
                    content: 'Alias Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            expect(createRes.status).toBe(200);

            const getRes = await app.request('/custom-slug', { method: 'GET' }, env);

            expect(getRes.status).toBe(200);
            const data = await getRes.json() as any;
            expect(data.title).toBe('Alias Feed');
        });

        it('should return AI summary generation status for a queued feed', async () => {
            await serverConfig.set('ai_summary.enabled', 'true', false);
            await serverConfig.set('ai_summary.provider', 'worker-ai', false);
            await serverConfig.set('ai_summary.model', 'llama-3-8b', false);

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Queued AI Feed',
                    content: 'Queued AI content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            const createData = await createRes.json() as any;
            const getRes = await app.request(`/${createData.insertedId}`, { method: 'GET' }, env);

            expect(getRes.status).toBe(200);
            const data = await getRes.json() as any;
            expect(data.ai_summary_status).toBe('pending');
            expect(data.ai_summary_error).toBe('');
        });

        it('删掉的文章不会继续留在 AI 摘要队列状态里', async () => {
            env.TASK_QUEUE = {
                send: async () => {},
                sendBatch: async () => {},
            } as unknown as Queue<any>;
            await serverConfig.set('ai_summary.enabled', 'true');

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Queue cleanup check',
                    content: '排队中的正文',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            expect(createRes.status).toBe(200);
            const feedId = (await createRes.json() as any).insertedId;

            // 建完就该进队列状态（pending）
            const before = await buildQueueStatusResponse(db, env);
            expect(before.items.some((item) => item.id === feedId)).toBe(true);
            expect(before.summary.pending).toBe(1);

            await app.request(`/${feedId}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            // 文章没了 ⇒ 队列状态里也不能再有它（也不能剩一条没标题的孤儿记录）
            const after = await buildQueueStatusResponse(db, env);
            expect(after.items.some((item) => item.id === feedId)).toBe(false);
            expect(after.items.length).toBe(0);
            expect(after.summary.pending).toBe(0);
        });

        it('should return 404 for non-existent feed', async () => {
            const res = await app.request('/9999', { method: 'GET' }, env);
            
            expect(res.status).toBe(404);
        });

        it('should blank ai_summary for non-author when content has a glass block', async () => {
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Glass Summary Feed',
                    content: '前面[glass]只有作者能看的秘密[/glass]后面',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            const createData = await createRes.json() as any;
            // 模拟"在隐藏段生效之前就生成好并落库"的 AI 摘要：纯文本、没有标记，maskGlassPlain 拦不到
            sqlite.prepare("UPDATE feeds SET ai_summary = ?, ai_summary_status = 'completed' WHERE id = ?")
                .run('只有作者能看的秘密被总结出来了', createData.insertedId);

            const guestRes = await app.request(`/${createData.insertedId}`, { method: 'GET' }, env);
            const guest = await guestRes.json() as any;
            expect(guest.ai_summary).toBe('');
            expect(guest.content).not.toContain('只有作者能看的秘密');

            const adminRes = await app.request(`/${createData.insertedId}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            const admin = await adminRes.json() as any;
            expect(admin.ai_summary).toBe('只有作者能看的秘密被总结出来了');
            expect(admin.content).toContain('只有作者能看的秘密');
        });

        it('三视角：游客全打码、注册读者看到 [glass] 原文但看不到 [owner]、缓存头按登录态分流', async () => {
            // 注册读者（permission 0）：评论、看 [glass] 都靠它
            sqlite.prepare("INSERT INTO users (id, username, openid, permission) VALUES (2, 'reader', 'reader-openid', 0)").run();

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Two tiers',
                    content: '公开开头[glass]给注册读者看的[/glass]中间[owner]只有作者能看[/owner]结尾',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            const createData = await createRes.json() as any;

            // 游客：两段都打码，且允许 CDN 缓存
            const guestRes = await app.request(`/${createData.insertedId}`, { method: 'GET' }, env);
            const guest = await guestRes.json() as any;
            expect(guest.content).not.toContain('给注册读者看的');
            expect(guest.content).not.toContain('只有作者能看');
            expect(guest.content).toContain('公开开头');
            expect(guestRes.headers.get('cache-control')).toContain('public');

            // 注册读者：[glass] 原文给了，[owner] 仍然是假字；响应绝不能被公共缓存
            const memberRes = await app.request(`/${createData.insertedId}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_2' },
            }, env);
            const member = await memberRes.json() as any;
            expect(member.content).toContain('给注册读者看的');
            expect(member.content).not.toContain('只有作者能看');
            expect(member.content).toContain('class="glass member"');
            expect(memberRes.headers.get('cache-control')).toContain('private');
            expect(memberRes.headers.get('cache-control')).toContain('no-store');

            // 作者：两段都原文
            const ownerRes = await app.request(`/${createData.insertedId}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            const owner = await ownerRes.json() as any;
            expect(owner.content).toContain('给注册读者看的');
            expect(owner.content).toContain('只有作者能看');
            expect(ownerRes.headers.get('cache-control')).toContain('private');
        });

        it('[owner] 段的 AI 摘要：连注册读者也不给', async () => {
            sqlite.prepare("INSERT INTO users (id, username, openid, permission) VALUES (3, 'reader2', 'reader2-openid', 0)").run();

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Owner only summary',
                    content: '开头[owner]只有作者知道的私事[/owner]结尾',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            const createData = await createRes.json() as any;
            sqlite.prepare("UPDATE feeds SET ai_summary = ?, ai_summary_status = 'completed' WHERE id = ?")
                .run('把私事复述出来的摘要', createData.insertedId);

            const memberRes = await app.request(`/${createData.insertedId}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env);
            const member = await memberRes.json() as any;
            expect(member.ai_summary).toBe('');

            const ownerRes = await app.request(`/${createData.insertedId}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);
            const owner = await ownerRes.json() as any;
            expect(owner.ai_summary).toBe('把私事复述出来的摘要');
        });

        it('should bypass stale public cache when cache is disabled', async () => {
            await clientConfig.set('cache.enabled', false);
            await clientConfig.set('counter.enabled', false);

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Fresh Feed',
                    content: 'Fresh Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            const createData = await createRes.json() as any;
            await cache.set(`feed_${createData.insertedId}`, {
                id: createData.insertedId,
                title: 'Stale Feed',
                content: 'stale',
                summary: '',
                ai_summary: '',
                ai_summary_status: 'idle',
                ai_summary_error: '',
                draft: 0,
                listed: 1,
                uid: 1,
                alias: null,
                hashtags: [],
                user: { id: 1, username: 'testuser', avatar: 'avatar.png' },
            });

            const getRes = await app.request(`/${createData.insertedId}`, { method: 'GET' }, env);
            const data = await getRes.json() as any;

            expect(data.title).toBe('Fresh Feed');
        });
    });

    describe('POST / - Create feed', () => {
        it('should create feed with admin permission', async () => {
            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'New Test Feed',
                    content: 'This is a new test feed content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.insertedId).toBeDefined();
        });

        it('单篇关了 AI 摘要：全局开着也不入队，状态留在 idle', async () => {
            const sent: any[] = [];
            env.TASK_QUEUE = {
                send: async (msg: any) => { sent.push(msg); },
                sendBatch: async () => {},
            } as unknown as Queue<any>;
            await serverConfig.set('ai_summary.enabled', 'true');

            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: '纯视频文章',
                    content: '<video controls><source src="https://example.com/a.mp4"></video>',
                    listed: true,
                    draft: false,
                    tags: [],
                    ai_summary_enabled: false,
                }),
            }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;

            // 关键：一条任务都不该发出去
            expect(sent.length).toBe(0);
            const row = sqlite
                .prepare("SELECT ai_summary_enabled, ai_summary_status, ai_summary FROM feeds WHERE id = ?")
                .get(data.insertedId) as any;
            expect(row.ai_summary_enabled).toBe(0);
            expect(row.ai_summary_status).toBe('idle');
            expect(row.ai_summary).toBe('');
        });

        it('没传 ai_summary_enabled 时默认开启（老行为不变）', async () => {
            const sent: any[] = [];
            env.TASK_QUEUE = {
                send: async (msg: any) => { sent.push(msg); },
                sendBatch: async () => {},
            } as unknown as Queue<any>;
            await serverConfig.set('ai_summary.enabled', 'true');

            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: '普通文章',
                    content: '一段普通正文',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;

            expect(sent.length).toBe(1);
            const row = sqlite
                .prepare("SELECT ai_summary_enabled, ai_summary_status FROM feeds WHERE id = ?")
                .get(data.insertedId) as any;
            expect(row.ai_summary_enabled).toBe(1);
            expect(row.ai_summary_status).toBe('pending');
        });

        it('should require admin permission', async () => {
            // Create app without admin permission
            const res = await app.request('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Test',
                    content: 'Test',
                    tags: [],
                    draft: false,
                    listed: true,
                }),
            }, env);

            expect(res.status).toBe(403);
        });

        it('should require title', async () => {
            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    content: 'Content without title',
                    tags: [],
                    draft: false,
                    listed: true,
                }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should require content', async () => {
            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Test',
                    content: '',
                    tags: [],
                }),
            }, env);

            expect(res.status).toBe(400);
        });
    });

    describe('POST /:id - Update feed', () => {
        it('should update feed with admin permission', async () => {
            // Create feed first
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Original Title',
                    content: 'Original Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            
            expect(createRes.status).toBe(200);
            const createData = await createRes.json() as any;
            const feedId = createData.insertedId;
            
            const updateRes = await app.request(`/${feedId}`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Updated Title',
                    content: 'Updated content',
                    listed: true,
                }),
            }, env);

            expect(updateRes.status).toBe(200);
            
            // Verify update
            const getRes = await app.request(`/${feedId}`, { method: 'GET' }, env);
            const data = await getRes.json() as any;
            expect(data.title).toBe('Updated Title');
        });

        it('把单篇 AI 摘要关掉时，已有摘要一起清空、也不再入队', async () => {
            const sent: any[] = [];
            env.TASK_QUEUE = {
                send: async (msg: any) => { sent.push(msg); },
                sendBatch: async () => {},
            } as unknown as Queue<any>;
            await serverConfig.set('ai_summary.enabled', 'true');

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: '视频文章',
                    content: '<video controls></video>',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            const feedId = (await createRes.json() as any).insertedId;
            // 默认是开的，所以建完就该有一条任务
            expect(sent.length).toBe(1);

            // 模拟这篇以前生成过摘要
            sqlite
                .prepare("UPDATE feeds SET ai_summary = '旧的AI摘要', ai_summary_status = 'completed' WHERE id = ?")
                .run(feedId);

            const sentBefore = sent.length;
            const updateRes = await app.request(`/${feedId}`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ listed: true, ai_summary_enabled: false }),
            }, env);

            expect(updateRes.status).toBe(200);
            // 关掉不该产生新任务
            expect(sent.length).toBe(sentBefore);

            const row = sqlite
                .prepare("SELECT ai_summary, ai_summary_status, ai_summary_enabled FROM feeds WHERE id = ?")
                .get(feedId) as any;
            expect(row.ai_summary_enabled).toBe(0);
            expect(row.ai_summary).toBe('');
            expect(row.ai_summary_status).toBe('idle');
        });

        it('should return updated content through unchanged alias after edit', async () => {
            await clientConfig.set('counter.enabled', false);

            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Alias Title',
                    alias: 'alias-post',
                    content: 'Original alias content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);

            expect(createRes.status).toBe(200);
            const createData = await createRes.json() as any;
            const feedId = createData.insertedId;

            const cachedAliasRes = await app.request('/alias-post', { method: 'GET' }, env);
            expect(cachedAliasRes.status).toBe(200);
            expect(((await cachedAliasRes.json()) as any).content).toBe('Original alias content');

            const updateRes = await app.request(`/${feedId}`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Alias Title Updated',
                    alias: 'alias-post',
                    content: 'Updated alias content',
                    listed: true,
                }),
            }, env);

            expect(updateRes.status).toBe(200);

            const aliasRes = await app.request('/alias-post', { method: 'GET' }, env);
            expect(aliasRes.status).toBe(200);
            const aliasData = await aliasRes.json() as any;
            expect(aliasData.title).toBe('Alias Title Updated');
            expect(aliasData.content).toBe('Updated alias content');

            const idRes = await app.request(`/${feedId}`, { method: 'GET' }, env);
            expect(idRes.status).toBe(200);
            expect(((await idRes.json()) as any).content).toBe('Updated alias content');
        });

        it('should require admin permission to update', async () => {
            // Create feed first
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Original',
                    content: 'Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            
            expect(createRes.status).toBe(200);
            const createData = await createRes.json() as any;
            const feedId = createData.insertedId;
            
            const updateRes = await app.request(`/${feedId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'New Title',
                    listed: true,
                }),
            }, env);

            expect(updateRes.status).toBe(403);
        });
    });

    describe('DELETE /:id - Delete feed', () => {
        it('should delete feed with admin permission', async () => {
            // Create feed first
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'To Delete',
                    content: 'Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            
            expect(createRes.status).toBe(200);
            const createData = await createRes.json() as any;
            const feedId = createData.insertedId;
            
            const deleteRes = await app.request(`/${feedId}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(deleteRes.status).toBe(200);
            
            // Verify deletion
            const getRes = await app.request(`/${feedId}`, { method: 'GET' }, env);
            expect(getRes.status).toBe(404);
        });

        it('删除文章时把只被它引用的图片一起删掉，共用的图保留', async () => {
            const SHA_OWN = 'c'.repeat(40);
            const SHA_SHARED = 'd'.repeat(40);
            const store = new Set([`images/${SHA_OWN}.png`, `images/${SHA_SHARED}.png`]);
            // 这个用例要一个带 R2 绑定的环境，所以单独起一套 ctx（fixture 的中间件是从闭包里取 env 的）
            const ctx = await setupTestApp(FeedService, {
                R2_BUCKET: {
                    async delete(key: string | string[]) {
                        for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
                    },
                    async list() {
                        return { objects: [...store].map((key) => ({ key, size: 10 })), truncated: false };
                    },
                    async put() { },
                    async get() { return null; },
                    async head() { return null; },
                } as any,
            });
            await createTestUser(ctx.sqlite);
            const testApp = ctx.app;
            const testEnv = ctx.env;

            const imageMd = (sha: string) => `![图](https://test-image-domain.com/images/${sha}.png)`;
            const headers = { 'Authorization': 'Bearer mock_token_1', 'Content-Type': 'application/json' };

            try {
                const createA = await testApp.request('/', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        title: '只有自己的图',
                        content: `${imageMd(SHA_OWN)}\n${imageMd(SHA_SHARED)}`,
                        listed: true,
                        draft: false,
                        tags: [],
                    }),
                }, testEnv);
                const idA = (await createA.json() as any).insertedId;

                await testApp.request('/', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        title: '共用同一张图',
                        content: imageMd(SHA_SHARED),
                        listed: true,
                        draft: false,
                        tags: [],
                    }),
                }, testEnv);

                const deleteRes = await testApp.request(`/${idA}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer mock_token_1' },
                }, testEnv);
                expect(deleteRes.status).toBe(200);

                expect(store.has(`images/${SHA_OWN}.png`)).toBe(false);
                expect(store.has(`images/${SHA_SHARED}.png`)).toBe(true);
            } finally {
                cleanupTestDB(ctx.sqlite);
            }
        });

        it('should require admin permission to delete', async () => {
            // Create feed first
            const createRes = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: 'Test',
                    content: 'Content',
                    listed: true,
                    draft: false,
                    tags: [],
                }),
            }, env);
            
            expect(createRes.status).toBe(200);
            const createData = await createRes.json() as any;
            const feedId = createData.insertedId;
            
            const deleteRes = await app.request(`/${feedId}`, { method: 'DELETE' }, env);

            expect(deleteRes.status).toBe(403);
        });

        it('should return 404 for non-existent feed', async () => {
            const res = await app.request('/9999', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(404);
        });
    });
});
