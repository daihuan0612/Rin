import { and, asc, count, desc, eq, gt, like, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { feeds, visits, visitStats } from "../db/schema";
import { HyperLogLog } from "../utils/hyperloglog";
import { extractImageWithMetadata } from "../utils/image";
import { balanceGlassTags, hasGlass, hasOwner, maskGlassTagged, renderGlass, type GlassViewer } from "../utils/glass";
import { deleteOrphanImagesFromText } from "../utils/feed-images";
import { makeSummary, stripMarkdown } from "../utils/markdown";
import { syncFeedAISummaryQueueState } from "./feed-ai-summary";
import { bindTagToPost } from "./tag";
import { clearFeedCache } from "./clear-feed-cache";
export { clearFeedCache } from "./clear-feed-cache";
import { purgeCache } from "../utils/purge-cache";


function parseFeedId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

function buildApiUrl(host: string, path: string) {
    return `https://${host}/api${path}`;
}

/** 这次请求算哪一档视角：作者 / 登录用户 / 游客 */
function viewerOf(admin: boolean, uid: number | undefined): GlassViewer {
    if (admin) return 'owner';
    return typeof uid === 'number' ? 'member' : 'guest';
}

/**
 * AI 摘要闸门。
 * 摘要是"整篇正文生成的一句话"，库里存的是纯文本、标记早没了，`maskGlassPlain` 拦不住，
 * 所以按正文里的标记分档给：含 `[owner]` ⇒ 只有作者有；含 `[glass]` ⇒ 游客没有。
 */
function gateAiSummary(content: string, aiSummary: string, admin: boolean, uid: number | undefined): string {
    if (admin) return aiSummary;
    if (hasOwner(content)) return '';
    if (hasGlass(content) && typeof uid !== 'number') return '';
    return aiSummary;
}

/**
 * 带隐藏段的响应**不能进公共缓存**：登录用户拿到的是原文，一旦标成 `public`，
 * CDN 就会把那份原文发给游客。游客才允许 `public`。
 */
function applyCacheControl(c: any, uid: number | undefined, sMaxAge: number) {
    if (typeof uid === 'number') {
        c.header('cache-control', 'private, no-store');
    } else {
        c.header('cache-control', `public, max-age=0, must-revalidate, s-maxage=${sMaxAge}`);
    }
}

async function purgeCdnForFeed(env: any, host: string, id: number, alias: string | null) {
    const paths = [buildApiUrl(host, `/feed/${id}`)];
    if (alias) {
        paths.push(buildApiUrl(host, `/feed/${alias}`));
    }
    await purgeCache(env, paths);
}

export function FeedService(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /feed - List feeds
    app.get('/', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const page = c.req.query('page');
        const limit = c.req.query('limit');
        const type = c.req.query('type');

        if ((type === 'draft' || type === 'unlisted') && !admin) {
            return c.text('Permission denied', 403);
        }

        const page_num = (page ? parseInt(page) > 0 ? parseInt(page) : 1 : 1) - 1;
        const limit_num = limit ? parseInt(limit) > 50 ? 50 : parseInt(limit) : 20;
        const viewer = viewerOf(admin, uid);
        const cacheKey = `feeds_${type}_${page_num}_${limit_num}`;
        const cached = await profileAsync(c, 'feed_list_cache_get', () => cache.get(cacheKey));

        // 缓存里存的是**游客版**（面向所有人公开的那份）；登录用户/作者要按自己视角算，不吃这份缓存
        if (cached && typeof uid !== 'number') {
            return c.json(cached);
        }

        const where = type === 'draft'
            ? eq(feeds.draft, 1)
            : type === 'unlisted'
                ? and(eq(feeds.draft, 0), eq(feeds.listed, 0))
                : and(eq(feeds.draft, 0), eq(feeds.listed, 1));

        const size = await profileAsync(c, 'feed_list_count', () => db.select({ count: count() }).from(feeds).where(where));

        if (size[0].count === 0) {
            return c.json({ size: 0, data: [], hasNext: false });
        }

        const feed_list = (await profileAsync(c, 'feed_list_db', () => db.query.feeds.findMany({
            where: where,
            columns: admin ? undefined : { draft: false, listed: false },
            with: {
                hashtags: {
                    columns: {},
                    with: {
                        hashtag: { columns: { id: true, name: true } }
                    }
                },
                user: { columns: { id: true, username: true, avatar: true } }
            },
            orderBy: [desc(feeds.top), desc(feeds.createdAt), desc(feeds.updatedAt)],
            offset: page_num * limit_num,
            limit: limit_num + 1,
        }))).map(({ content, hashtags, summary, ai_summary, ...other }: any) => {
            const avatar = extractImageWithMetadata(content);
            const plainText = stripMarkdown(maskGlassTagged(content, viewer));
            const taggedSummary = maskGlassTagged(summary, viewer);
            return {
                // 打码段用哨兵夹着假字，前端据此套毛玻璃罩子（见 FeedCard）
                summary: balanceGlassTags(taggedSummary.length > 0 ? taggedSummary : makeSummary(plainText, 100)),
                hashtags: hashtags.map(({ hashtag }: any) => hashtag),
                ai_summary: gateAiSummary(content, ai_summary, admin, uid),
                avatar,
                ...other
            };
        });

        let hasNext = false;
        if (feed_list.length === limit_num + 1) {
            feed_list.pop();
            hasNext = true;
        }

        const data = { size: size[0].count, data: feed_list, hasNext };

        if (type === undefined || type === 'normal' || type === '') {
            // 只有游客版可以进公共缓存
            if (typeof uid !== 'number') {
                await profileAsync(c, 'feed_list_cache_set', () => cache.set(cacheKey, data));
            }
        }

        applyCacheControl(c, uid, 300);

        return c.json(data);
    });

    // GET /feed/timeline
    app.get('/timeline', async (c) => {
        const db = c.get('db');
        const where = and(eq(feeds.draft, 0), eq(feeds.listed, 1));
        const data = await profileAsync(c, 'feed_timeline_db', () => db.query.feeds.findMany({
            where: where,
            columns: { id: true, title: true, createdAt: true },
            orderBy: [desc(feeds.createdAt), desc(feeds.updatedAt)],
        }));
        c.header('cache-control', 'public, max-age=0, must-revalidate, s-maxage=600');
        return c.json(data);
    });

    // POST /feed - Create feed
    app.post('/', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const serverConfig = c.get('serverConfig');
        const env = c.get('env');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const body = await profileAsync(c, 'feed_create_parse', () => c.req.json());
        const { title, alias, listed, content, summary, draft, tags, createdAt, show_toc } = body;

        if (!admin) {
            return c.text('Permission denied', 403);
        }

        if (!title) {
            return c.text('Title is required', 400);
        }
        if (!content) {
            return c.text('Content is required', 400);
        }

        const exist = await profileAsync(c, 'feed_create_existing', () => db.query.feeds.findFirst({
            where: eq(feeds.content, content)
        }));

        if (exist) {
            return c.text('Content already exists', 400);
        }

        const date = createdAt ? new Date(createdAt) : new Date();

        if (!uid) {
            return c.text('User ID is required', 400);
        }

        const result = await profileAsync(c, 'feed_create_insert', () => db.insert(feeds).values({
            title,
            content,
            summary,
            ai_summary: "",
            ai_summary_status: "idle",
            ai_summary_error: "",
            uid,
            alias,
            listed: listed ? 1 : 0,
            draft: draft ? 1 : 0,
            show_toc: show_toc ? 1 : 0,
            createdAt: date,
            updatedAt: date
        }).returning({ insertedId: feeds.id }));

        await profileAsync(c, 'feed_create_tags', () => bindTagToPost(db, result[0].insertedId, tags));
        await profileAsync(c, 'feed_create_ai_queue', () => syncFeedAISummaryQueueState(db, serverConfig, env, result[0].insertedId, {
            draft: Boolean(draft),
            updatedAt: date,
            resetSummary: true,
        }));
        await profileAsync(c, 'feed_create_cache_invalidate', () => cache.deletePrefix('feeds_'));
        await profileAsync(c, 'feed_create_cdn_purge', () => purgeCdnForFeed(env, c.req.header('host') || '', result[0].insertedId, alias || null));

        if (result.length === 0) {
            return c.text('Failed to insert', 500);
        } else {
            return c.json(result[0]);
        }
    });

    // GET /feed/:id
    app.get('/:id', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const clientConfig = c.get('clientConfig');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const id = c.req.param('id');
        const id_num = parseFeedId(id);
        const cacheKey = id_num === null ? `feed_alias_${id}` : `feed_id_${id_num}`;
        const where = id_num === null ? eq(feeds.alias, id) : eq(feeds.id, id_num);

        const feed = await profileAsync(c, 'feed_detail_cache_db', () => cache.getOrSet(cacheKey, () => db.query.feeds.findFirst({
            where,
            with: {
                hashtags: {
                    columns: {},
                    with: {
                        hashtag: { columns: { id: true, name: true } }
                    }
                },
                user: { columns: { id: true, username: true, avatar: true } }
            }
        })));

        if (!feed) {
            return c.text('Not found', 404);
        }

        if (feed.draft && feed.uid !== uid && !admin) {
            return c.text('Permission denied', 403);
        }

        const { hashtags, ...other } = feed;
        const hashtags_flatten = hashtags.map((f: any) => f.hashtag);

        // update visits using HyperLogLog for efficient UV estimation
        const enableVisit = await profileAsync(c, 'feed_detail_counter_flag', () => clientConfig.getOrDefault('counter.enabled', true));
        let pv = 0;
        let uv = 0;

        if (enableVisit) {
            const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || "UNK";
            const visitorKey = `${ip}`;

            // Get or create visit stats for this feed
            let stats = await profileAsync(c, 'feed_detail_stats_lookup', () => db.query.visitStats.findFirst({
                where: eq(visitStats.feedId, feed.id)
            }));

            if (!stats) {
                // Create new stats record
                await profileAsync(c, 'feed_detail_stats_insert', () => db.insert(visitStats).values({
                    feedId: feed.id,
                    pv: 1,
                    hllData: new HyperLogLog().serialize()
                }));
                pv = 1;
                uv = 1;
            } else {
                // Update existing stats
                const hll = new HyperLogLog(stats.hllData);
                hll.add(visitorKey);
                const newHllData = hll.serialize();
                const newPv = stats.pv + 1;

                await profileAsync(c, 'feed_detail_stats_update', () => db.update(visitStats)
                    .set({
                        pv: newPv,
                        hllData: newHllData,
                        updatedAt: new Date()
                    })
                    .where(eq(visitStats.feedId, feed.id)));

                pv = newPv;
                uv = Math.round(hll.count());
            }

            // Keep recording to visits table for backup/history
            await profileAsync(c, 'feed_detail_visit_insert', () => db.insert(visits).values({ feedId: feed.id, ip: ip }));
        }

        // 隐藏段：作者看原文、登录用户看 `[glass]` 原文、游客全打码。
        // ⚠️ 必须写在 `cache.getOrSet`（上面取 feed 那里）之外：缓存里存的是数据库原始行、
        // 所有人共用，只有这里组装给响应的 content 才能按视角区分。
        const viewer = viewerOf(admin, uid);
        const result = {
            ...other,
            content: renderGlass(other.content, viewer),
            // 摘要也要挡：详情页自己不显示摘要，但摘要里可能抄了隐藏段原话，
            // 直接发原文等于给 F12 留了个后门。作者仍拿原文（写作页要用它还原）
            summary: viewer === 'owner'
                ? other.summary
                : balanceGlassTags(maskGlassTagged(other.summary ?? '', viewer)),
            hashtags: hashtags_flatten,
            pv,
            uv,
        };

        // AI 摘要按标记分档（详见 `gateAiSummary`）
        result.ai_summary = gateAiSummary(other.content, other.ai_summary, admin, uid);

        // 登录用户看到的是原文 ⇒ 这份响应绝不能进 CDN；草稿一律不缓存
        if (feed.draft) {
            c.header('cache-control', 'private, no-store');
        } else {
            applyCacheControl(c, uid, 60);
        }

        return c.json(result);
    });

    // GET /feed/adjacent/:id
    app.get("/adjacent/:id", async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const admin = c.get('admin');
        const uid = c.get('uid');
        // 卡片摘要按视角算 ⇒ 缓存键必须带视角，否则游客版会把登录用户的原文顶掉（反之亦然）
        const viewer = viewerOf(admin, uid);
        const id = c.req.param('id');
        let id_num = parseFeedId(id);

        if (id_num === null) {
            const aliasRecord = await profileAsync(c, 'feed_adjacent_alias_lookup', () => db.select({ id: feeds.id }).from(feeds).where(eq(feeds.alias, id)));
            if (aliasRecord.length === 0) {
                return c.text("Not found", 404);
            }
            id_num = aliasRecord[0].id;
        }

        const feed = await profileAsync(c, 'feed_adjacent_current', () => db.query.feeds.findFirst({
            where: eq(feeds.id, id_num),
            columns: { createdAt: true },
        }));

        if (!feed) {
            return c.text("Not found", 404);
        }

        const created_at = feed.createdAt;

        function formatAndCacheData(feed: any, feedDirection: "previous_feed" | "next_feed") {
            if (feed) {
                const hashtags_flatten = feed.hashtags.map((f: any) => f.hashtag);
                const plainText = stripMarkdown(maskGlassTagged(feed.content, viewer));
                const taggedSummary = maskGlassTagged(feed.summary, viewer);
                const summary = balanceGlassTags(taggedSummary.length > 0
                    ? taggedSummary
                    : makeSummary(plainText, 50));
                const cacheKey = `${feed.id}_${feedDirection}_${id_num}_${viewer}`;
                const cacheData = {
                    id: feed.id,
                    title: feed.title,
                    summary: summary,
                    hashtags: hashtags_flatten,
                    createdAt: feed.createdAt,
                    updatedAt: feed.updatedAt,
                };
                cache.set(cacheKey, cacheData);
                return cacheData;
            }
            return null;
        }

        const getPreviousFeed = async () => {
            const previousFeedCached = await profileAsync(c, 'feed_adjacent_prev_cache', () => cache.getBySuffix(`previous_feed_${id_num}_${viewer}`));
            if (previousFeedCached && previousFeedCached.length > 0) {
                return previousFeedCached[0];
            } else {
                const tempPreviousFeed = await profileAsync(c, 'feed_adjacent_prev_db', () => db.query.feeds.findFirst({
                    where: and(and(eq(feeds.draft, 0), eq(feeds.listed, 1)), lt(feeds.createdAt, created_at)),
                    orderBy: [desc(feeds.createdAt)],
                    with: {
                        hashtags: {
                            columns: {},
                            with: { hashtag: { columns: { id: true, name: true } } }
                        },
                        user: { columns: { id: true, username: true, avatar: true } }
                    },
                }));
                return formatAndCacheData(tempPreviousFeed, "previous_feed");
            }
        };

        const getNextFeed = async () => {
            const nextFeedCached = await profileAsync(c, 'feed_adjacent_next_cache', () => cache.getBySuffix(`next_feed_${id_num}_${viewer}`));
            if (nextFeedCached && nextFeedCached.length > 0) {
                return nextFeedCached[0];
            } else {
                const tempNextFeed = await profileAsync(c, 'feed_adjacent_next_db', () => db.query.feeds.findFirst({
                    where: and(and(eq(feeds.draft, 0), eq(feeds.listed, 1)), gt(feeds.createdAt, created_at)),
                    orderBy: [asc(feeds.createdAt)],
                    with: {
                        hashtags: {
                            columns: {},
                            with: { hashtag: { columns: { id: true, name: true } } }
                        },
                        user: { columns: { id: true, username: true, avatar: true } }
                    },
                }));
                return formatAndCacheData(tempNextFeed, "next_feed");
            }
        };

        const [previousFeed, nextFeed] = await Promise.all([getPreviousFeed(), getNextFeed()]);
        // 登录用户/作者拿到的摘要含隐藏段原文 ⇒ 不能标 public，否则 CDN 会把原文发给游客
        applyCacheControl(c, uid, 600);
        return c.json({ previousFeed, nextFeed });
    });

    // POST /feed/:id - Update feed
    app.post('/:id', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const serverConfig = c.get('serverConfig');
        const env = c.get('env');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const id = c.req.param('id');
        const body = await profileAsync(c, 'feed_update_parse', () => c.req.json());
        const { title, listed, content, summary, alias, draft, top, tags, createdAt, show_toc } = body;

        const id_num = parseInt(id);
        const feed = await profileAsync(c, 'feed_update_lookup', () => db.query.feeds.findFirst({ where: eq(feeds.id, id_num) }));

        if (!feed) {
            return c.text('Not found', 404);
        }

        if (feed.uid !== uid && !admin) {
            return c.text('Permission denied', 403);
        }

        const contentChanged = content && content !== feed.content;
        const isDraft = draft !== undefined ? draft : (feed.draft === 1);
        const shouldQueueAISummary = (contentChanged && !isDraft) || (!isDraft && feed.draft === 1 && !feed.ai_summary);
        const updateTime = new Date();

        await profileAsync(c, 'feed_update_db', () => db.update(feeds).set({
            title,
            content,
            summary,
            ai_summary: shouldQueueAISummary ? "" : undefined,
            ai_summary_status: isDraft ? "idle" : undefined,
            ai_summary_error: shouldQueueAISummary || isDraft ? "" : undefined,
            alias,
            top,
            listed: listed ? 1 : 0,
            draft: draft === undefined ? undefined : draft ? 1 : 0,
            show_toc: show_toc === undefined ? undefined : show_toc ? 1 : 0,
            createdAt: createdAt ? new Date(createdAt) : undefined,
            updatedAt: updateTime
        }).where(eq(feeds.id, id_num)));

        if (tags) {
            await profileAsync(c, 'feed_update_tags', () => bindTagToPost(db, id_num, tags));
        }

        if (shouldQueueAISummary || isDraft) {
            await profileAsync(c, 'feed_update_ai_queue', () => syncFeedAISummaryQueueState(db, serverConfig, env, id_num, {
                draft: Boolean(isDraft),
                updatedAt: updateTime,
                resetSummary: shouldQueueAISummary,
            }));
        }

        await profileAsync(c, 'feed_update_cache_invalidate', () => clearFeedCache(cache, id_num, feed.alias, alias || null));
        await profileAsync(c, 'feed_update_cdn_purge', () => purgeCdnForFeed(env, c.req.header('host') || '', id_num, alias || null));
        return c.text('Updated');
    });

    // POST /feed/top/:id
    app.post('/top/:id', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const env = c.get('env');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const id = c.req.param('id');
        const body = await profileAsync(c, 'feed_top_parse', () => c.req.json());
        const { top } = body;

        const id_num = parseInt(id);
        const feed = await profileAsync(c, 'feed_top_lookup', () => db.query.feeds.findFirst({ where: eq(feeds.id, id_num) }));

        if (!feed) {
            return c.text('Not found', 404);
        }

        if (feed.uid !== uid && !admin) {
            return c.text('Permission denied', 403);
        }

        await profileAsync(c, 'feed_top_db', () => db.update(feeds).set({ top }).where(eq(feeds.id, feed.id)));
        await profileAsync(c, 'feed_top_cache_invalidate', () => clearFeedCache(cache, feed.id, feed.alias, feed.alias));
        await profileAsync(c, 'feed_top_cdn_purge', () => purgeCdnForFeed(env, c.req.header('host') || '', feed.id, feed.alias));
        return c.text('Updated');
    });

    // DELETE /feed/:id
    app.delete('/:id', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const env = c.get('env');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const id = c.req.param('id');

        const id_num = parseInt(id);
        const feed = await profileAsync(c, 'feed_delete_lookup', () => db.query.feeds.findFirst({ where: eq(feeds.id, id_num) }));

        if (!feed) {
            return c.text('Not found', 404);
        }

        if (feed.uid !== uid && !admin) {
            return c.text('Permission denied', 403);
        }

        await profileAsync(c, 'feed_delete_db', () => db.delete(feeds).where(eq(feeds.id, id_num)));

        // 图片跟着文章走：只有"全站再也没人引用"的那些才删（同一张图可能被别的文章用着）
        // ⚠️ 必须在上面那行**之后**：文章还在库里的时候，「还有人引用吗」永远为真
        await profileAsync(c, 'feed_delete_images', () =>
            deleteOrphanImagesFromText(db, env, `${feed.content}\n${feed.summary ?? ''}`),
        );

        await profileAsync(c, 'feed_delete_cache_invalidate', () => clearFeedCache(cache, id_num, feed.alias, null));
        await profileAsync(c, 'feed_delete_cdn_purge', () => purgeCdnForFeed(env, c.req.header('host') || '', id_num, feed.alias));
        return c.text('Deleted');
    });
    return app;
}

export function SearchService(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /search/:keyword
    app.get('/:keyword', async (c) => {
        const db = c.get('db');
        const cache = c.get('cache');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const page = c.req.query('page');
        const limit = c.req.query('limit');
        let keyword = c.req.param('keyword');

        keyword = decodeURI(keyword);
        const page_num = (page ? parseInt(page) > 0 ? parseInt(page) : 1 : 1) - 1;
        const limit_num = limit ? parseInt(limit) > 50 ? 50 : parseInt(limit) : 20;

        if (keyword === undefined || keyword.trim().length === 0) {
            return c.json({ size: 0, data: [], hasNext: false });
        }

        const cacheKey = `search_${keyword}`;
        const viewer = viewerOf(admin, uid);
        const searchKeyword = `%${keyword}%`;
        const whereClause = or(
            like(feeds.title, searchKeyword),
            like(feeds.content, searchKeyword),
            like(feeds.summary, searchKeyword),
            like(feeds.alias, searchKeyword)
        );

        const feed_list = (await profileAsync(c, 'feed_search_cache_db', () => cache.getOrSet(cacheKey, () => db.query.feeds.findMany({
            where: admin ? whereClause : and(whereClause, eq(feeds.draft, 0)),
            columns: admin ? undefined : { draft: false, listed: false },
            with: {
                hashtags: {
                    columns: {},
                    with: { hashtag: { columns: { id: true, name: true } } }
                },
                user: { columns: { id: true, username: true, avatar: true } }
            },
            orderBy: [desc(feeds.createdAt), desc(feeds.updatedAt)],
        })))).map(({ content, hashtags, summary, ai_summary, ...other }: any) => {
            const plainText = stripMarkdown(maskGlassTagged(content, viewer));
            const taggedSummary = maskGlassTagged(summary, viewer);
            return {
                summary: balanceGlassTags(taggedSummary.length > 0 ? taggedSummary : makeSummary(plainText, 100)),
                hashtags: hashtags.map(({ hashtag }: any) => hashtag),
                // 搜索也是公开出口：按标记分档给 AI 摘要
                ai_summary: gateAiSummary(content, ai_summary, admin, uid),
                ...other
            };
        });

        if (feed_list.length <= page_num * limit_num) {
            return c.json({ size: feed_list.length, data: [], hasNext: false });
        } else if (feed_list.length <= page_num * limit_num + limit_num) {
            return c.json({ size: feed_list.length, data: feed_list.slice(page_num * limit_num), hasNext: false });
        } else {
            return c.json({
                size: feed_list.length,
                data: feed_list.slice(page_num * limit_num, page_num * limit_num + limit_num),
                hasNext: true
            });
        }
    });
    return app;
}
