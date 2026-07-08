import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { getStorageObject, putStorageObject, resolveStorageTarget } from "../utils/storage";
import { createS3Client, deleteObject as deleteS3Object, listObjects as listS3Objects } from "../utils/s3";

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

export function StorageService(): Hono {
    const app = new Hono();

    // POST /storage - Upload
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');

        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const key = body.key as string;
        const file = body.file as File;

        const suffix = key.includes(".") ? key.split('.').pop() : "";
        const fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
        const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest(
            { name: 'SHA-1' },
            fileBuffer
        ));
        const hash = buf2hex(hashArray);
        const hashkey = `${hash}.${suffix}`;

        try {
            const result = await profileAsync(c, 'storage_put', () => putStorageObject(env, hashkey, file, file.type, new URL(c.req.url).origin));
            return c.json({ url: result.url });
        } catch (e: any) {
            console.error(e.message);
            const status = e.message?.includes('is not defined') ? 500 : 400;
            return c.text(e.message, status);
        }
    });

    // GET /storage/list - List all images (admin only)
    app.get('/list', async (c: AppContext) => {
        const uid = c.get('uid');
        const admin = c.get('admin');
        if (!uid || !admin) {
            return c.text('Forbidden', 403);
        }

        const env = c.get('env');
        const target = resolveStorageTarget(env);
        const folder = target.folder;

        try {
            if (env.R2_BUCKET) {
                let objects: Array<{ key: string; size: number; uploaded: Date }> = [];
                let cursor: string | undefined;
                do {
                    const list = await env.R2_BUCKET.list({ prefix: folder, cursor, limit: 1000 });
                    for (const obj of list.objects) {
                        objects.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded });
                    }
                    cursor = list.truncated ? list.cursor : undefined;
                } while (cursor);

                // Filter to only image files
                const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
                objects = objects.filter(obj => imageExts.some(ext => obj.key.toLowerCase().endsWith(ext)));

                const sorted = objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());

                return c.json({
                    items: sorted.map(obj => ({
                        key: obj.key,
                        fileName: obj.key.replace(folder, ''),
                        size: obj.size,
                        uploaded: obj.uploaded.toISOString(),
                        url: `${target.publicBaseUrl}/${obj.key}`,
                    })),
                    total: sorted.length,
                });
            } else {
                const client = createS3Client(env);
                const objects = await listS3Objects(client, env, folder);
                const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
                const images = objects.filter(obj => imageExts.some(ext => obj.key.toLowerCase().endsWith(ext)));
                const sorted = images.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

                return c.json({
                    items: sorted.map(obj => ({
                        key: obj.key,
                        fileName: obj.key.replace(folder, ''),
                        size: obj.size,
                        uploaded: obj.lastModified.toISOString(),
                        url: `${target.publicBaseUrl}/${obj.key}`,
                    })),
                    total: sorted.length,
                });
            }
        } catch (e: any) {
            console.error("Storage list failed:", e.message);
            return c.text(e.message, 500);
        }
    });

    // DELETE /storage/:key - Delete an image (admin only)
    app.delete('/:key', async (c: AppContext) => {
        const uid = c.get('uid');
        const admin = c.get('admin');
        if (!uid || !admin) {
            return c.text('Forbidden', 403);
        }

        const env = c.get('env');
        const key = c.req.param('key');

        if (!key) {
            return c.text('Key is required', 400);
        }

        try {
            if (env.R2_BUCKET) {
                await env.R2_BUCKET.delete(key);
            } else {
                const client = createS3Client(env);
                await deleteS3Object(client, env, key);
            }
            return c.json({ success: true });
        } catch (e: any) {
            console.error("Storage delete failed:", e.message);
            return c.text(e.message, 500);
        }
    });

    return app;
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const key = c.req.path.replace(/^\/blob\/?/, "");

        if (!key) {
            return c.text("Blob key is required", 400);
        }

        try {
            const response = await profileAsync(c, "blob_fetch", () => getStorageObject(env, decodeURIComponent(key)));

            if (!response) {
                return c.text("Not found", 404);
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}
