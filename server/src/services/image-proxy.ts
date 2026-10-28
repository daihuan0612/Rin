import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";

/**
 * 外链图片代理 —— 2026-10-28
 *
 * 背景（用户实拍 iPhone Safari）：文正里的图和列表封面全部变成"破图小问号"，
 * 但同一份内容在电脑 Chrome 上是好的。查下来图床本身完全正常（200 / image/jpeg /
 * CORS 全开 / 证书链完整），差别只在**手机那条网络连不到那个第三方域名**。
 *
 * 所以不要在样式上做文章，而是换一条路：让**服务端**（Cloudflare 内部）去取图，
 * 再把字节从本站域名吐给浏览器。手机只连 `llx.de5.net`，就一定显示得出来。
 *
 * 只代理下面这几个已知图床（不开放任意 URL，否则就成了给全网白嫖的开放代理）：
 * 白名单是用线上 6 篇文章里实际出现的外链域名统计出来的，多了不要加。
 */
export const IMAGE_PROXY_HOSTS: ReadonlySet<string> = new Set([
    "pan.xfl.cc.cd",
    "xfl.cc.cd",
]);

/** 边缘缓存 30 天：同一张图第二次请求不再回源，省 Worker 额度 */
const PROXY_CACHE_TTL = 60 * 60 * 24 * 30;
const MAX_URL_LENGTH = 2048;

export type ProxyTargetResult =
    | { ok: true; url: URL }
    | { ok: false; status: 400 | 403; message: string };

/**
 * 校验待代理的地址。抽出来单独测，不在路由里内联判断。
 * 只放行：https + 白名单主机 + 长度合理。
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
    if (!IMAGE_PROXY_HOSTS.has(url.hostname)) {
        return { ok: false, status: 403, message: "host is not allowed" };
    }

    return { ok: true, url };
}

export function ImageProxyService(): Hono {
    const app = new Hono();

    // GET /api/img-proxy?url=<encoded>
    app.get("/", async (c: AppContext) => {
        const target = resolveProxyTarget(c.req.query("url"));
        if (!target.ok) {
            return c.text(target.message, target.status);
        }

        try {
            const upstream = await profileAsync(c, "img_proxy_fetch", () =>
                fetch(target.url.toString(), {
                    headers: {
                        // 图床可能按 Referer 防盗链，代理这一脚不带来源最稳
                        accept: "image/*",
                    },
                    cf: {
                        cacheEverything: true,
                        cacheTtl: PROXY_CACHE_TTL,
                    },
                } as RequestInit),
            );

            const contentType = upstream.headers.get("content-type") || "";
            if (!upstream.ok) {
                return c.text(`upstream ${upstream.status}`, 502);
            }
            // 只回图片；万一上游返回了登录页/错误页，别把它当图片喂给 <img>
            if (!contentType.startsWith("image/")) {
                return c.text(`upstream is not an image (${contentType || "unknown"})`, 502);
            }

            return new Response(upstream.body, {
                status: 200,
                headers: {
                    "Content-Type": contentType,
                    "Cache-Control": `public, max-age=${PROXY_CACHE_TTL}, immutable`,
                    "X-Rin-Image-Proxy": "1",
                },
            });
        } catch (error) {
            console.error("Image proxy failed:", error);
            return c.text("Image proxy failed", 502);
        }
    });

    return app;
}
