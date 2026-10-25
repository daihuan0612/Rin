import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cache, comments, feeds, friends, moments, users } from '../../db/schema';
import { cleanupTestDB, createMockEnv, setupTestApp } from '../../../tests/fixtures';
import {
    deleteOrphanImagesFromText,
    extractImageKeys,
    isImageStillReferenced,
    listStorageImages,
    sweepOrphanImages,
} from '../feed-images';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** 最小可用的 R2 假桶：只实现代码用到的 delete / list */
function createFakeR2(initialKeys: string[]) {
    const store = new Set(initialKeys);
    return {
        store,
        async delete(key: string | string[]) {
            for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
        },
        async put() { },
        async get() { return null; },
        async head() { return null; },
        async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
            const prefix = options.prefix ?? '';
            const limit = options.limit ?? 1000;
            const start = options.cursor ? Number(options.cursor) : 0;
            const all = [...store].filter((k) => k.startsWith(prefix)).sort();
            const page = all.slice(start, start + limit);
            const truncated = start + limit < all.length;
            return {
                objects: page.map((key) => ({ key, size: 100 })),
                truncated,
                cursor: truncated ? String(start + limit) : undefined,
            };
        },
    };
}

describe('extractImageKeys', () => {
    const env = createMockEnv();

    it('能认出 /api/blob/ 形式的图片 key', () => {
        const md = `![图](/api/blob/${SHA_A}.png)`;
        expect(extractImageKeys(md, env)).toEqual([`${SHA_A}.png`]);
    });

    it('能认出 S3 公共域名下的图片，并去掉 folder 前缀', () => {
        const md = `![图](https://test-image-domain.com/images/${SHA_A}.webp)`;
        expect(extractImageKeys(md, env)).toEqual([`${SHA_A}.webp`]);
    });

    it('裸的内容寻址文件名（sha1.ext）也认，自定义域名也能兜住', () => {
        const md = `<img src="https://my-own-cdn.example/any/${SHA_B}.jpg">`;
        expect(extractImageKeys(md, env)).toEqual([`${SHA_B}.jpg`]);
    });

    it('同一张图出现多次只算一个；非图片后缀不算', () => {
        const md = [
            `![a](https://test-image-domain.com/images/${SHA_A}.png)`,
            `![b](/api/blob/${SHA_A}.png)`,
            `[附件](https://test-image-domain.com/images/${SHA_A}.zip)`,
        ].join('\n');
        expect(extractImageKeys(md, env)).toEqual([`${SHA_A}.png`]);
    });

    it('URL 编码与查询串都能正确还原', () => {
        const md = `![a](/api/blob/images%2F${SHA_A}.png?x=1)`;
        expect(extractImageKeys(md, env)).toEqual([`${SHA_A}.png`]);
    });

    it('空内容返回空数组', () => {
        expect(extractImageKeys('', env)).toEqual([]);
    });
});

describe('图片清理（文章删除 / 手工清理）', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setupTestApp(() => new Hono(), { R2_BUCKET: createFakeR2([]) as any });
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;

        // 建一个作者
        await db.insert(users).values({ id: 1, username: 'owner', openid: 'gh1', permission: 1 });
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it('文章里引用、全站没人再引用的图 → 删掉', async () => {
        const bucket = env.R2_BUCKET as any;
        bucket.store.add(`images/${SHA_A}.png`);

        const md = `![图](https://test-image-domain.com/images/${SHA_A}.png)`;
        await db.insert(feeds).values({ id: 1, title: 'A', content: md, uid: 1, draft: 0, listed: 1 });
        await db.delete(feeds).where(eq(feeds.id, 1));

        const result = await deleteOrphanImagesFromText(db, env, md);

        expect(result).toEqual({ candidates: 1, deleted: 1, kept: 0 });
        expect(bucket.store.has(`images/${SHA_A}.png`)).toBe(false);
    });

    it('同一张图还被别的文章用着 → 保留（不能把别人文章里的图删了）', async () => {
        const bucket = env.R2_BUCKET as any;
        bucket.store.add(`images/${SHA_A}.png`);

        const md = `![图](https://test-image-domain.com/images/${SHA_A}.png)`;
        await db.insert(feeds).values([
            { id: 1, title: 'A', content: md, uid: 1, draft: 0, listed: 1 },
            { id: 2, title: 'B', content: md, uid: 1, draft: 0, listed: 1 },
        ]);
        // 删掉 1 号，2 号还在用这张图
        await db.delete(feeds).where(eq(feeds.id, 1));

        const result = await deleteOrphanImagesFromText(db, env, md);

        expect(result).toEqual({ candidates: 1, deleted: 0, kept: 1 });
        expect(bucket.store.has(`images/${SHA_A}.png`)).toBe(true);
    });

    it('动态 / 评论 / 头像 / 配置里引用着，也不能删', async () => {
        const bucket = env.R2_BUCKET as any;
        bucket.store.add(`images/${SHA_A}.png`);

        await db.insert(moments).values({ id: 1, content: `![m](/${SHA_A}.png)`, uid: 1 });
        expect(await isImageStillReferenced(db, `${SHA_A}.png`)).toBe(true);

        await db.delete(moments).where(eq(moments.id, 1));
        await db.insert(feeds).values({ id: 10, title: 'C', content: '没有图', uid: 1, draft: 0, listed: 1 });
        await db.insert(comments).values({ id: 1, feedId: 10, content: `见 ${SHA_A}.png` });
        expect(await isImageStillReferenced(db, `${SHA_A}.png`)).toBe(true);

        await db.delete(comments).where(eq(comments.id, 1));
        await db.update(users).set({ avatar: `/api/blob/${SHA_A}.png` }).where(eq(users.id, 1));
        expect(await isImageStillReferenced(db, `${SHA_A}.png`)).toBe(true);

        await db.update(users).set({ avatar: '' }).where(eq(users.id, 1));
        await db.insert(friends).values({ id: 1, name: 'f', avatar: `${SHA_A}.png`, url: 'https://x', uid: 1 });
        expect(await isImageStillReferenced(db, `${SHA_A}.png`)).toBe(true);

        await db.delete(friends).where(eq(friends.id, 1));
        // 站点头像这类配置也算引用
        await db.insert(cache).values({ key: 'site.avatar', value: `/api/blob/${SHA_A}.png`, type: 'client.config' });
        expect(await isImageStillReferenced(db, `${SHA_A}.png`)).toBe(true);

        // TTL 缓存行（type='cache'）不算：那是接口响应的过期缓存，算进去就永远删不掉
        await db.delete(cache).where(eq(cache.key, 'site.avatar'));
        await db.insert(cache).values({ key: 'feed_1', value: `${SHA_A}.png`, type: 'cache' });
        expect(await isImageStillReferenced(db, `${SHA_A}.png`)).toBe(false);
    });

    it('手工清理：只删孤儿，保留在用的，并统计释放空间', async () => {
        const bucket = env.R2_BUCKET as any;
        bucket.store.add(`images/${SHA_A}.png`);
        bucket.store.add(`images/${SHA_B}.png`);
        bucket.store.add('images/not-image.txt');

        await db.insert(feeds).values({
            id: 1,
            title: 'A',
            content: `![a](https://test-image-domain.com/images/${SHA_A}.png)`,
            uid: 1,
            draft: 0,
            listed: 1,
        });

        const result = await sweepOrphanImages(env, db);

        expect(result).toEqual({ scanned: 2, deleted: 1, kept: 1, freedBytes: 100 });
        expect(bucket.store.has(`images/${SHA_A}.png`)).toBe(true);
        expect(bucket.store.has(`images/${SHA_B}.png`)).toBe(false);
        // 非图片后缀不参与清理
        expect(bucket.store.has('images/not-image.txt')).toBe(true);
    });

    it('列存储时按图片后缀过滤，且能翻页取全', async () => {
        const bucket = env.R2_BUCKET as any;
        for (let i = 0; i < 5; i++) bucket.store.add(`images/${String(i).repeat(40)}.png`);
        bucket.store.add('images/readme.md');

        const items = await listStorageImages(env);

        expect(items).toHaveLength(5);
        expect(items.every((item) => item.key.endsWith('.png'))).toBe(true);
    });
});
