/**
 * 文章删除后，把正文里那些**只被这篇文章引用**的图片一起删掉。
 *
 * 为什么要单独判断"还被别人引用吗"：
 * 上传的图片是**内容寻址**的（文件名 = SHA-1），同一张图在几篇文章里用是同一个对象。
 * 直接按正文里出现的 URL 删，会把别人文章里的图一起删掉（图片裂开，而且找不回来）。
 * 所以这里只删"全站再也没有任何地方提到它"的孤儿图。
 *
 * 扫哪些地方算"还引用着"：
 *   feeds.content / feeds.summary、moments.content、comments.content、
 *   users.avatar、friends.avatar、以及配置表（`cache` 表里 type 不是 'cache' 的行，
 *   也就是 client.config / server.config —— 站点头像、图标这类图也在里面）。
 *   ⚠️ **不扫 TTL 缓存行**（type = 'cache'）：那是接口响应的过期缓存，
 *   里面必然带着这篇文章自己的图片 URL，扫了等于永远删不掉。
 */

import { and, count, like, ne, or } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { cache, comments, feeds, friends, info, moments, users } from "../db/schema";
import { path_join } from "./path";
import { createS3Client, deleteObject as deleteS3Object, listObjects as listS3Objects } from "./s3";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"];

function trimTrailingSlash(value: string) {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 去掉查询串 / 片段，去掉 URL 编码 */
function cleanCandidate(raw: string) {
    const cut = raw.split(/[?#]/)[0];
    try {
        return decodeURIComponent(cut);
    } catch {
        return cut;
    }
}

/**
 * 从一段 markdown / HTML 里抽出"本站存储对象"的 key（相对 `S3_FOLDER`）。
 * 三条路都走：`/api/blob/<key>`、S3 公共域名下的路径、以及内容寻址文件名（sha1.ext）本身。
 * 第三条是为了兜住"URL 被改写过 / 用了自定义域名"的情况。
 */
export function extractImageKeys(content: string, env: Env): string[] {
    if (!content) return [];
    const folder = trimTrailingSlash(env.S3_FOLDER || "");
    const host = trimTrailingSlash(env.S3_ACCESS_HOST || "");
    const keys = new Set<string>();

    const push = (raw: string) => {
        const value = cleanCandidate(raw);
        if (!value || !IMAGE_EXT.test(value)) return;

        let relative = value.replace(/^\/+/, "");
        // 公共 URL 里带 folder 前缀，存储 key 里不带（删除时要再拼回去）
        if (folder && (relative === folder || relative.startsWith(`${folder}/`))) {
            relative = relative.slice(folder.length).replace(/^\/+/, "");
        }

        const segments = relative.split("/").filter(Boolean);
        if (segments.length > 1) {
            // 带子目录：只认"内容寻址文件名"（sha1.ext），避免误删别人目录里的同名文件
            const fileName = segments[segments.length - 1];
            if (/^[0-9a-f]{40}\./i.test(fileName)) keys.add(fileName);
            return;
        }
        if (relative) keys.add(relative);
    };

    for (const m of content.matchAll(/\/api\/blob\/([^\s)"'<>\]}]+)/g)) {
        push(m[1]);
    }
    if (host) {
        const re = new RegExp(`${escapeRegExp(host)}\\/([^\\s)"'<>\\]}]+)`, "g");
        for (const m of content.matchAll(re)) {
            push(m[1]);
        }
    }
    for (const m of content.matchAll(/\b([0-9a-f]{40}\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif))\b/gi)) {
        keys.add(m[1]);
    }

    return [...keys].filter(Boolean);
}

/** 全站还有没有任何地方引用这个文件（按文件名匹配，文件名本身就是内容哈希，不会误伤） */
export async function isImageStillReferenced(db: DB, fileName: string): Promise<boolean> {
    const pattern = `%${fileName}%`;
    const queries = [
        db.select({ n: count() }).from(feeds).where(or(like(feeds.content, pattern), like(feeds.summary, pattern))),
        db.select({ n: count() }).from(moments).where(like(moments.content, pattern)),
        db.select({ n: count() }).from(comments).where(like(comments.content, pattern)),
        db.select({ n: count() }).from(users).where(like(users.avatar, pattern)),
        db.select({ n: count() }).from(friends).where(like(friends.avatar, pattern)),
        db.select({ n: count() }).from(cache).where(and(ne(cache.type, "cache"), like(cache.value, pattern))),
        db.select({ n: count() }).from(info).where(like(info.value, pattern)),
    ];
    for (const query of queries) {
        const rows = await query;
        if (Number(rows?.[0]?.n ?? 0) > 0) return true;
    }
    return false;
}

/** 存储里的 key（拼上 folder）*/
export function toStorageKey(env: Env, relativeKey: string) {
    return path_join(env.S3_FOLDER || "", relativeKey);
}

/** 删一个存储对象：有 R2 绑定就走 R2，否则走 S3 */
export async function deleteStorageObject(env: Env, storageKey: string) {
    if (env.R2_BUCKET) {
        await env.R2_BUCKET.delete(storageKey);
        return;
    }
    const client = createS3Client(env);
    await deleteS3Object(client, env, storageKey);
}

/** 列出存储里所有图片对象（含 folder 前缀的完整 key） */
export async function listStorageImages(env: Env): Promise<Array<{ key: string; size: number }>> {
    const folder = env.S3_FOLDER || "";
    const items: Array<{ key: string; size: number }> = [];

    if (env.R2_BUCKET) {
        let cursor: string | undefined;
        do {
            const list = await env.R2_BUCKET.list({ prefix: folder, cursor, limit: 1000 });
            for (const obj of list.objects) {
                items.push({ key: obj.key, size: obj.size });
            }
            cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
    } else {
        const client = createS3Client(env);
        const objects = await listS3Objects(client, env, folder);
        for (const obj of objects) {
            items.push({ key: obj.key, size: obj.size });
        }
    }

    return items.filter((obj) => IMAGE_EXTS.some((ext) => obj.key.toLowerCase().endsWith(ext)));
}

/**
 * 文章删掉之后调用：把这段文本里提到、且**全站没人再引用**的图片从存储里删掉。
 * ⚠️ 必须在 `db.delete(feeds)` **之后**调用 —— 否则这篇文章自己还在库里，
 * 「还有人引用吗」永远为真，什么都不会删。
 * 返回 { candidates, deleted, kept }，方便日志和测试。
 */
export async function deleteOrphanImagesFromText(
    db: DB,
    env: Env,
    text: string,
): Promise<{ candidates: number; deleted: number; kept: number }> {
    const keys = extractImageKeys(text, env);
    let deleted = 0;
    let kept = 0;

    for (const key of keys) {
        const fileName = key.split("/").pop() || key;
        try {
            if (await isImageStillReferenced(db, fileName)) {
                kept++;
                continue;
            }
            await deleteStorageObject(env, toStorageKey(env, key));
            deleted++;
        } catch (e: any) {
            // 删图失败不能把"文章已删除"这件事搞成 500：记日志继续
            console.error(`[image-cleanup] 删除 ${key} 失败:`, e?.message ?? e);
        }
    }

    return { candidates: keys.length, deleted, kept };
}

/** 手工清理入口：把存储里所有"全站没人引用"的图片删掉 */
export async function sweepOrphanImages(env: Env, db: DB): Promise<{
    scanned: number;
    deleted: number;
    kept: number;
    freedBytes: number;
}> {
    const objects = await listStorageImages(env);
    let deleted = 0;
    let kept = 0;
    let freedBytes = 0;

    for (const obj of objects) {
        const fileName = obj.key.split("/").pop() || obj.key;
        if (!fileName) continue;
        try {
            if (await isImageStillReferenced(db, fileName)) {
                kept++;
                continue;
            }
            await deleteStorageObject(env, obj.key);
            deleted++;
            freedBytes += obj.size;
        } catch (e: any) {
            console.error(`[image-cleanup] 删除 ${obj.key} 失败:`, e?.message ?? e);
        }
    }

    return { scanned: objects.length, deleted, kept, freedBytes };
}
