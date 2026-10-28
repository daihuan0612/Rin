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

afterEach(() => {
    globalThis.fetch = realFetch;
});

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
        expect(res.headers.get("cache-control")).toContain("max-age=2592000");
        expect(res.headers.get("x-rin-image-proxy")).toBe("1");
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
});
