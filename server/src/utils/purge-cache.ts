export async function purgeCache(env: { CLOUDFLARE_PURGE_TOKEN?: string; CLOUDFLARE_ZONE_ID?: string }, paths: string[]) {
  const apiToken = env.CLOUDFLARE_PURGE_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;

  if (!apiToken || !zoneId) {
    console.warn("purgeCache: CLOUDFLARE_PURGE_TOKEN or CLOUDFLARE_ZONE_ID not set, skipping cache purge");
    return;
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: paths.map((p) => (p.startsWith("https://") ? p : `https://${p}`)),
      }),
    });

    const result = await response.json<{ success: boolean }>();

    if (!result.success) {
      console.warn("purgeCache: Cloudflare API returned error", result);
    }
  } catch (e) {
    console.warn("purgeCache: Failed to purge cache", e);
  }
}
