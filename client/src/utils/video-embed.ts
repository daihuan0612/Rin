export type VideoPlatform = "bilibili" | "youtube" | "vimeo" | "mp4" | "unknown";

export interface ParsedVideo {
  platform: VideoPlatform;
  url: string;
  embedHtml: string;
}

function buildIframe(src: string, title = "video"): string {
  return `<iframe src="${src}" title="${title}" allowfullscreen></iframe>`;
}

function buildVideoTag(src: string): string {
  return `<video controls preload="metadata"><source src="${src}"></video>`;
}

function isVideoUrl(url: string, u: URL): boolean {
  if (/\.(mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv)(\?.*)?$/i.test(u.pathname)) {
    return true;
  }
  for (const value of u.searchParams.values()) {
    if (/\.(mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv)/i.test(value)) {
      return true;
    }
  }
  if (/video|mp4|media|stream|proxy/i.test(url)) {
    return true;
  }
  return false;
}

export function parseVideoUrl(input: string): ParsedVideo | null {
  const url = input.trim();
  if (!url) return null;

  try {
    const u = new URL(url);

    if (u.hostname.includes("bilibili.com") || u.hostname === "b23.tv") {
      let bvid = "";
      let aid = "";
      let cid = "";

      const bvMatch = url.match(/BV[a-zA-Z0-9]+/);
      if (bvMatch) bvid = bvMatch[0];

      const avMatch = url.match(/\/av(\d+)/);
      if (avMatch) aid = avMatch[1];

      const cidMatch = url.match(/[?&]cid=(\d+)/);
      if (cidMatch) cid = cidMatch[1];

      if (bvid || aid) {
        const params = new URLSearchParams();
        if (bvid) params.set("bvid", bvid);
        if (aid) params.set("aid", aid);
        if (cid) params.set("cid", cid);
        params.set("page", "1");
        const src = `//player.bilibili.com/player.html?${params.toString()}&high_quality=1&danmaku=0`;
        return {
          platform: "bilibili",
          url,
          embedHtml: buildIframe(src, "Bilibili video"),
        };
      }
    }

    if (u.hostname.includes("youtube.com") || u.hostname === "youtu.be") {
      let videoId = "";
      if (u.hostname === "youtu.be") {
        videoId = u.pathname.slice(1);
      } else if (u.pathname === "/watch") {
        videoId = u.searchParams.get("v") || "";
      } else if (u.pathname.startsWith("/embed/")) {
        videoId = u.pathname.replace("/embed/", "");
      }
      if (videoId) {
        const src = `https://www.youtube.com/embed/${videoId}`;
        return {
          platform: "youtube",
          url,
          embedHtml: buildIframe(src, "YouTube video"),
        };
      }
    }

    if (u.hostname.includes("vimeo.com")) {
      const idMatch = url.match(/vimeo\.com\/(\d+)/);
      if (idMatch) {
        const src = `https://player.vimeo.com/video/${idMatch[1]}`;
        return {
          platform: "vimeo",
          url,
          embedHtml: buildIframe(src, "Vimeo video"),
        };
      }
    }

    if (isVideoUrl(url, u)) {
      return {
        platform: "mp4",
        url,
        embedHtml: buildVideoTag(url),
      };
    }

    return {
      platform: "unknown",
      url,
      embedHtml: buildVideoTag(url),
    };
  } catch (_e) {
    if (/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(url)) {
      return {
        platform: "mp4",
        url,
        embedHtml: buildVideoTag(url),
      };
    }
    return null;
  }
}
