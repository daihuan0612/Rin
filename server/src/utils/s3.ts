import { AwsClient } from "aws4fetch";
import { path_join } from "./path";

export function createS3Client(env: Env): AwsClient {
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
    
    return new AwsClient({
        accessKeyId,
        secretAccessKey,
        service: "s3",
    });
}

export async function putObject(
    client: AwsClient,
    env: Env,
    key: string,
    body: Blob | ArrayBuffer | Uint8Array | string,
    contentType?: string
) {
    const endpoint = env.S3_ENDPOINT;
    const bucket = env.S3_BUCKET;
    const forcePathStyle = env.S3_FORCE_PATH_STYLE === 'true';

    // Construct URL based on path-style or virtual-hosted style
    let url: string;
    if (forcePathStyle) {
        url = path_join(endpoint, bucket, key);
    } else {
        // Virtual-hosted style: https://bucket.endpoint/key
        const urlObj = new URL(endpoint);
        url = `${urlObj.protocol}//${bucket}.${urlObj.host}/${key}`;
    }
    
    const headers: Record<string, string> = {};
    if (contentType) {
        headers["Content-Type"] = contentType;
    }
    
    const response = await client.fetch(url, {
        method: "PUT",
        body: body as BodyInit,
        headers,
    });
    
    if (!response.ok) {
        throw new Error(`Failed to upload to S3: ${response.status} ${response.statusText}`);
    }
    
    return response;
}

export function buildS3ObjectUrl(env: Env, key: string): string {
    const endpoint = env.S3_ENDPOINT;
    const bucket = env.S3_BUCKET;
    const forcePathStyle = env.S3_FORCE_PATH_STYLE === 'true';

    if (forcePathStyle) {
        return path_join(endpoint, bucket, key);
    }

    const urlObj = new URL(endpoint);
    return `${urlObj.protocol}//${bucket}.${urlObj.host}/${key}`;
}

export function buildS3BucketUrl(env: Env): string {
    const endpoint = env.S3_ENDPOINT;
    const bucket = env.S3_BUCKET;
    const forcePathStyle = env.S3_FORCE_PATH_STYLE === 'true';

    if (forcePathStyle) {
        return path_join(endpoint, bucket);
    }

    const urlObj = new URL(endpoint);
    return `${urlObj.protocol}//${bucket}.${urlObj.host}`;
}

export async function deleteObject(client: AwsClient, env: Env, key: string) {
    const url = buildS3ObjectUrl(env, key);
    const response = await client.fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete from S3: ${response.status} ${response.statusText}`);
    }
    return response;
}

export async function listObjects(client: AwsClient, env: Env, prefix: string): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const baseUrl = buildS3BucketUrl(env);
    const url = `${baseUrl}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const response = await client.fetch(url, { method: "GET" });
    if (!response.ok) {
        throw new Error(`Failed to list S3 objects: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    // Parse simple XML response
    const results: Array<{ key: string; size: number; lastModified: Date }> = [];
    const contentMatch = text.matchAll(/<Contents>[\s\S]*?<\/Contents>/g);
    for (const match of contentMatch) {
        const key = match[0].match(/<Key>(.*?)<\/Key>/)?.[1] || "";
        const size = parseInt(match[0].match(/<Size>(.*?)<\/Size>/)?.[1] || "0", 10);
        const lastModified = new Date(match[0].match(/<LastModified>(.*?)<\/LastModified>/)?.[1] || "");
        if (key) results.push({ key, size, lastModified });
    }
    return results;
}
