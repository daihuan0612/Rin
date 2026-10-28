import { Hono } from "hono";
import { isProxiedMediaHost } from "@rin/api";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";

/**
 * 外链媒体代理（图片 + 视频） —— 2026-10-28
 *
 * 背景（用户实拍 iPhone Safari）：正文里的图和列表封面全部变成"破图小问号"，
 * 同一份内容在电脑 Chrome 上是好的。查下来图床本身完全正常（200 / image/jpeg /
 * CORS 全开 / 证书链完整），差别只在**手机那条网络连不到那个第三方域名**。
 *
 * 所以不要在样式上做文章，而是换一条路：让**服务端**（Cloudflare 内部）去取，
 * 再把字节从本站域名吐给浏览器。手机只连 `llx.de5.net`，就一定显示得出来。
 *
 * 视频：上游回的是 `Cache-Control: private` + `cf-cache-status: BYPASS`，CDN 不缓存，
 * 每次播放都回源。所以这里要**透传 Range**，否则进度条拖不动、每次从头下。
 *
 * 边缘缓存：`cf.cacheTtl` 实测不生效（上游 private），改成自己用 Cache API 显式存。
 * 图片整份存一年；视频的 206 分片存不了，靠响应头的 `immutable` 让浏览器缓存。
 */
/** 边缘缓存 1 年 */
const PROXY_CACHE_TTL = 60 * 60 * 24 * 365;
const MAX_URL_LENGTH = 2048;
/**
 * Cache API 的 key 前缀。
 * ⚠️ 用内部假域名，别用本站域名 —— `caches.default` 的 key 是 URL 字符串，用真域名有概率跟站内资源撞车。
 * ⚠️ 带 `/v1/` 版本段：代理逻辑或缓存语义变了就升版本，旧缓存自然失效
 *    （`caches.default` 没有按前缀批量清的能力，只能靠换 key）。
 */
const CACHE_API_PREFIX = "https://rin-media-cache.internal/v1/";
/** Range 相关的头必须原样带回去，否则 <video> 拖不动进度 */
const PASSTHROUGH_HEADERS = [
    "content-range",
    "content-length",
    "content-encoding",
    "accept-ranges",
    "etag",
    "last-modified",
];
/** 上游不给 content-type 时，靠扩展名兜底判断是不是媒体 */
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|mp4|webm|mov|m4v|mp3|m4a|ogg)$/i;

export type ProxyTargetResult =
    | { ok: true; url: URL }
    | { ok: false; status: 400 | 403; message: string };

/**
 * 校验待代理的地址。抽出来单独测，不在路由里内联判断。
 * 只放行：https + 默认端口 + 无凭据 + 白名单主机 + 长度合理。
 */
export function resolveProxyTarget(raw: string | undefined): ProxyTargetResult {
    if (!raw || !raw.trim()) {
        return { ok: false, status: 400, message: "url is required" };
    }
    if (raw.length > MAX_URL_LENGTH) {
        return { ok: false, status: 400, message: "url is too long" };
    }

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, status: 400, message: "url is invalid" };
    }

    if (url.protocol !== "https:") {
        return { ok: false, status: 400, message: "only https is allowed" };
    }
    // 非默认端口可以指向任意后端；带凭据的 URL 会把账号密码卷进缓存键和回源请求
    if (url.port !== "") {
        return { ok: false, status: 400, message: "custom port is not allowed" };
    }
    if (url.username || url.password) {
        return { ok: false, status: 400, message: "credentials are not allowed" };
    }
    if (!isProxiedMediaHost(url.hostname)) {
        return { ok: false, status: 403, message: "host is not allowed" };
    }

    return { ok: true, url };
}

/**
 * 上游可能是 `application/octet-stream`（有些图床对 jpg 就这么回），
 * 这时靠路径扩展名兜底，避免把正常图片一律判成非媒体。
 */
export function isAllowedMedia(contentType: string, sourceUrl: string) {
    const value = (contentType || "").toLowerCase();
    if (value.startsWith("image/") || value.startsWith("video/")) {
        return true;
    }
    if (value.startsWith("application/octet-stream")) {
        try {
            return MEDIA_EXT_RE.test(new URL(sourceUrl).pathname);
        } catch {
            return false;
        }
    }
    return false;
}

/** 边缘缓存句柄。bun test 环境没有 `caches` 全局，这里要防御。 */
function getEdgeCache(): Cache | undefined {
    try {
        // `caches.default` 是 Workers 的扩展，TS 自带的是 Service Worker 那份类型
        return typeof caches !== "undefined"
            ? (caches as unknown as { default?: Cache }).default
            : undefined;
    } catch {
        return undefined;
    }
}

function buildCacheKey(url: string) {
    return new Request(`${CACHE_API_PREFIX}${encodeURIComponent(url)}`, { method: "GET" });
}

export function ImageProxyService(): Hono {
    const app = new Hono();

    // GET / HEAD /api/img-proxy?url=<encoded>（图片、视频共用；名字保留是为了老页面不 404）
    app.on(["GET", "HEAD"], "/", async (c: AppContext) => {
        const target = resolveProxyTarget(c.req.query("url"));
        if (!target.ok) {
            return c.text(target.message, target.status);
        }

        const method = c.req.method === "HEAD" ? "HEAD" : "GET";
        const range = c.req.header("range");
        const sourceUrl = target.url.toString();
        const cacheKey = buildCacheKey(sourceUrl);
        const edgeCache = getEdgeCache();

        // 图片（不带 Range）先查边缘缓存：命中就直接吐，不回源
        if (method === "GET" && !range && edgeCache) {
            try {
                const hit = await edgeCache.match(cacheKey);
                if (hit) {
                    const headers = new Headers(hit.headers);
                    headers.set("X-Rin-Proxy-Cache", "HIT");
                    return new Response(hit.body, { status: 200, headers });
                }
            } catch (error) {
                // 缓存读挂了就降级回源，不能让整个代理 500
                console.error("Edge cache match failed:", error);
            }
        }

        try {
            const upstreamHeaders: Record<string, string> = {
                // 图床可能按 Referer 防盗链，代理这一脚不带来源最稳
                accept: "*/*",
            };
            if (range) {
                upstreamHeaders.range = range;
            }

            /**
             * ⚠️ 这里**不要**再加 `cf: { cacheEverything: true, cacheTtl }`：
             * 实测那条路根本不生效，反而会让 CF 把「非媒体响应」（上游登录页/错误页）
             * 也按一年缓存。缓存由下面的 Cache API 自己管。
             */
            const upstream = await profileAsync(c, "img_proxy_fetch", () =>
                fetch(sourceUrl, {
                    method,
                    headers: upstreamHeaders,
                } as RequestInit),
            );

            const contentType = upstream.headers.get("content-type") || "";

            // 416 = Range 越界（播放器 seek 超出结尾），原样透传给播放器，别翻成 502
            if (upstream.status === 416) {
                const headers = new Headers();
                const contentRange = upstream.headers.get("content-range");
                if (contentRange) {
                    headers.set("Content-Range", contentRange);
                }
                return new Response(upstream.body, { status: 416, headers });
            }

            if (!upstream.ok && upstream.status !== 206) {
                await upstream.body?.cancel();
                return c.text("upstream error", 502);
            }

            // 206 分片偶尔不带 content-type，这时不该判成非媒体
            const typeOk =
                upstream.status === 206 && !contentType
                    ? true
                    : isAllowedMedia(contentType, sourceUrl);
            if (!typeOk) {
                await upstream.body?.cancel();
                return c.text("upstream is not a media file", 502);
            }

            const headers = new Headers();
            headers.set("Content-Type", contentType || "application/octet-stream");
            /**
             * 完整对象才给 immutable；206 是分片，别让浏览器把某一段当成整份长期复用。
             */
            headers.set(
                "Cache-Control",
                upstream.status === 206
                    ? `public, max-age=${PROXY_CACHE_TTL}`
                    : `public, max-age=${PROXY_CACHE_TTL}, immutable`,
            );
            headers.set("X-Rin-Proxy-Cache", "MISS");
            for (const name of PASSTHROUGH_HEADERS) {
                const value = upstream.headers.get(name);
                if (value) {
                    headers.set(name, value);
                }
            }

            const response = new Response(upstream.body, {
                // 206 必须原样带回去，否则播放器拿不到这一段的 Content-Range 会判定失败
                status: upstream.status === 206 ? 206 : 200,
                headers,
            });

            /**
             * 只有「完整图片 + GET + 无 Range」才写边缘缓存。
             * ⚠️ 必须 `await`：试过塞 `waitUntil`，部署后连测三次全 MISS —— 请求结束后写入被掐掉。
             * ⚠️ 所以首次请求会等缓存写完才返回（TTFB 变长是这一点的代价，已实测确认命中收益更大）。
             */
            const cacheable = method === "GET" && !range && upstream.status === 200 && contentType.startsWith("image/");
            if (!cacheable || !edgeCache) {
                return response;
            }

            let storeState = "stored";
            try {
                await edgeCache.put(cacheKey, response.clone());
            } catch (error) {
                // 只回一个标记，别把内部错误信息（可能含上游 URL）暴露到响应头
                storeState = "failed";
                console.error("Edge cache put failed:", error);
            }

            const outHeaders = new Headers(response.headers);
            outHeaders.set("X-Rin-Proxy-Store", storeState);
            return new Response(response.body, { status: response.status, headers: outHeaders });
        } catch (error) {
            console.error("Media proxy failed:", error);
            return c.text("Media proxy failed", 502);
        }
    });

    return app;
}
