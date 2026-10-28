import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ImageProxyService, resolveProxyTarget } from "../image-proxy";

const realFetch = globalThis.fetch;

function createApp() {
    const app = new Hono();
    app.route("/img-proxy", ImageProxyService());
    return app;
}

const external = "https://pan.xfl.cc.cd/file/ai/DTfuLPoP.jpg";
const externalVideo = "https://pan.xfl.cc.cd/file/tucao/1784189263473_video_1784189387631.mp4";

afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as { caches?: unknown }).caches;
});

/** 造一个最小的 Cache API 假实现，用来验证"命中边缘缓存就不再回源" */
function installFakeCaches() {
    const store = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = {
        default: {
            match: async (request: Request) => {
                const hit = store.get(request.url);
                return hit ? hit.clone() : undefined;
            },
            put: async (request: Request, response: Response) => {
                store.set(request.url, response.clone());
            },
        },
    };
    return store;
}

describe("resolveProxyTarget", () => {
    it("rejects empty url", () => {
        expect(resolveProxyTarget(undefined)).toMatchObject({ ok: false, status: 400 });
        expect(resolveProxyTarget("  ")).toMatchObject({ ok: false, status: 400 });
    });

    it("rejects non-https", () => {
        expect(resolveProxyTarget("http://pan.xfl.cc.cd/file/ai/DTfuLPoP.jpg"))
            .toMatchObject({ ok: false, status: 400 });
    });

    it("rejects hosts outside the whitelist", () => {
        expect(resolveProxyTarget("https://example.com/a.jpg"))
            .toMatchObject({ ok: false, status: 403 });
        // 不能因为是子域就放行
        expect(resolveProxyTarget("https://evil.pan.xfl.cc.cd/a.jpg"))
            .toMatchObject({ ok: false, status: 403 });
    });

    it("accepts whitelisted image hosts", () => {
        const result = resolveProxyTarget(external);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.url.hostname).toBe("pan.xfl.cc.cd");
        }
    });

    it("rejects custom ports and embedded credentials", () => {
        expect(resolveProxyTarget("https://pan.xfl.cc.cd:8443/file/a.jpg"))
            .toMatchObject({ ok: false, status: 400 });
        expect(resolveProxyTarget("https://user:pass@pan.xfl.cc.cd/file/a.jpg"))
            .toMatchObject({ ok: false, status: 400 });
    });
});

describe("GET /img-proxy", () => {
    it("streams the upstream image with a long cache header", async () => {
        globalThis.fetch = (async () =>
            new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { "content-type": "image/jpeg" },
            })) as typeof fetch;

        const res = await createApp().request(`/img-proxy?url=${encodeURIComponent(external)}`);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/jpeg");
        expect(res.headers.get("cache-control")).toContain("max-age=31536000");
        expect(res.headers.get("x-rin-proxy-cache")).toBe("MISS");
    });

    it("refuses to pass through a non-image response", async () => {
        globalThis.fetch = (async () =>
            new Response("<html>login</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            })) as typeof fetch;

        const res = await createApp().request(`/img-proxy?url=${encodeURIComponent(external)}`);

        expect(res.status).toBe(502);
    });

    it("reports upstream failures as 502", async () => {
        globalThis.fetch = (async () =>
            new Response("nope", { status: 404 })) as typeof fetch;

        const res = await createApp().request(`/img-proxy?url=${encodeURIComponent(external)}`);

        expect(res.status).toBe(502);
    });

    it("rejects a non-whitelisted host without touching the network", async () => {
        let called = false;
        globalThis.fetch = (async () => {
            called = true;
            return new Response("x");
        }) as typeof fetch;

        const res = await createApp().request(
            `/img-proxy?url=${encodeURIComponent("https://example.com/a.jpg")}`,
        );

        expect(res.status).toBe(403);
        expect(called).toBe(false);
    });

    it("writes images into the edge cache and serves later hits without refetching", async () => {
        const store = installFakeCaches();
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response(new Uint8Array([7, 7, 7]), {
                status: 200,
                headers: { "content-type": "image/jpeg" },
            });
        }) as typeof fetch;

        const app = createApp();
        const first = await app.request(`/img-proxy?url=${encodeURIComponent(external)}`);
        expect(first.status).toBe(200);
        expect(first.headers.get("x-rin-proxy-cache")).toBe("MISS");

        // putCache 是异步写（Worker 里走 waitUntil），等它写完
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(store.size).toBe(1);

        const second = await app.request(`/img-proxy?url=${encodeURIComponent(external)}`);
        expect(second.status).toBe(200);
        expect(second.headers.get("x-rin-proxy-cache")).toBe("HIT");
        expect(calls).toBe(1);
    });

    it("proxies video and passes the Range request through", async () => {
        const seen: { range: string | null } = { range: null };
        globalThis.fetch = (async (_input: any, init?: any) => {
            seen.range = new Headers(init?.headers).get("range");
            return new Response(new Uint8Array([9, 9]), {
                status: 206,
                headers: {
                    "content-type": "video/mp4",
                    "content-range": "bytes 0-1/1000000",
                    "accept-ranges": "bytes",
                },
            });
        }) as typeof fetch;

        const res = await createApp().request(
            `/img-proxy?url=${encodeURIComponent(externalVideo)}`,
            { headers: { range: "bytes=0-1" } },
        );

        expect(seen.range).toBe("bytes=0-1");
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 0-1/1000000");
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(res.headers.get("content-type")).toBe("video/mp4");
    });

    it("passes 416 through instead of turning it into 502", async () => {
        globalThis.fetch = (async () =>
            new Response(null, {
                status: 416,
                headers: { "content-range": "bytes */20240963" },
            })) as typeof fetch;

        const res = await createApp().request(
            `/img-proxy?url=${encodeURIComponent(externalVideo)}`,
            { headers: { range: "bytes=99999999-" } },
        );

        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe("bytes */20240963");
    });

    it("accepts octet-stream when the path looks like a real image", async () => {
        globalThis.fetch = (async () =>
            new Response(new Uint8Array([1]), {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
            })) as typeof fetch;

        const res = await createApp().request(`/img-proxy?url=${encodeURIComponent(external)}`);
        expect(res.status).toBe(200);
    });

    it("still rejects octet-stream for a non-media path", async () => {
        globalThis.fetch = (async () =>
            new Response(new Uint8Array([1]), {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
            })) as typeof fetch;

        const res = await createApp().request(
            `/img-proxy?url=${encodeURIComponent("https://pan.xfl.cc.cd/login")}`,
        );
        expect(res.status).toBe(502);
    });
});
