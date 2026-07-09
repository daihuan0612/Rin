import { getApp } from "./app-instance";

const ROOT_FEED_PATTERN = /^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/;
const APP_PUBLIC_ROUTE_PATTERN = /^\/(favicon|favicon\.ico)(?:\/|$)/;

const CRAWLER_UA_PATTERNS = [
  /googlebot/i,
  /bingbot/i,
  /msnbot/i,
  /baiduspider/i,
  /yandex/i,
  /duckduckbot/i,
  /yahoo/i,
  /sogou/i,
  /haosou/i,
  /360spider/i,
  /youdaobot/i,
  /easouspider/i,
  /qihoobot/i,
  /facebookexternalhit/i,
  /facebot/i,
  /twitterbot/i,
  /tweetmemebot/i,
  /pinterest/i,
  /linkedinbot/i,
  /slurp/i,
  /applebot/i,
  /semrush/i,
  /ahrefs/i,
  /mj12bot/i,
  /dotbot/i,
  /rogerbot/i,
  /grapeshot/i,
  /searchmetricsbot/i,
  /seznambot/i,
  /spbot/i,
  /blexbot/i,
  /gigabot/i,
  /yacy/i,
  /yeti/i,
  /yodaobot/i,
  /yolink/i,
  /nutch/i,
  /jyxobot/i,
  /webzip/i,
  /webcollage/i,
  /copernic/i,
  /teleport/i,
  /vci/i,
  /snoopy/i,
  /moma/i,
  /luna/i,
  /emailcollector/i,
  /emailsiphon/i,
  /emailwolf/i,
  /extractor/i,
  /harvest/i,
  /hloader/i,
  /httplib/i,
  /mauibot/i,
  /nazer/i,
  /searchbots/i,
  /siphon/i,
  /webbandit/i,
  /webcopier/i,
  /webmirror/i,
  /webvac/i,
  /wcollector/i,
  /webdownloader/i,
  /xenu/i,
  /zeus/i,
  /scrapy/i,
  /httrack/i,
  /python-requests/i,
  /python-urllib/i,
  /aiohttp/i,
  /guzzlehttp/i,
  /headless/i,
  /phantom/i,
  /selenium/i,
  /puppeteer/i,
  /playwright/i,
  /wget/i,
  /curl/i,
  /go-http-client/i,
  /httpclient/i,
  /okhttp/i,
  /http\.rb/i,
  /faraday/i,
  /httpunit/i,
  /reqwest/i,
  /rest-client/i,
  /simplepie/i,
  /magpie-crawler/i,
  /feedparser/i,
  /universalfeedparser/i,
  /rssowl/i,
  /ming/i,
  /panscient/i,
  /pingdom/i,
  /statuscake/i,
  /uptrends/i,
  /site24x7/i,
  /newrelic/i,
  /datadog/i,
  /uptimerobot/i,
  /sitemap/i,
];

function isCrawler(ua: string): boolean {
  if (!ua) return false;
  return CRAWLER_UA_PATTERNS.some(pattern => pattern.test(ua));
}

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function rewriteApiRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

function isRootFeedRequest(pathname: string) {
  return ROOT_FEED_PATTERN.test(pathname);
}

function isAppPublicRoute(pathname: string) {
  return APP_PUBLIC_ROUTE_PATTERN.test(pathname);
}

function isStaticAssetRequest(pathname: string) {
  return /\.\w+$/.test(pathname);
}

async function tryServeAsset(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200 || (asset.status >= 300 && asset.status < 400)) {
      return asset;
    }
  } catch {}

  return null;
}

async function serveSpaEntry(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const url = new URL(request.url);
    const indexRequest = new Request(new URL("/", url.origin), request);
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400)) {
      return indexResponse;
    }
  } catch {}

  return null;
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const userAgent = request.headers.get('user-agent') || '';

  if (isCrawler(userAgent)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (isRootFeedRequest(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isApiRequest(pathname)) {
    return getApp().fetch(rewriteApiRequest(request), env);
  }

  if (isAppPublicRoute(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isStaticAssetRequest(pathname)) {
    const asset = await tryServeAsset(request, env);
    if (asset) {
      return asset;
    }
  }

  const indexResponse = await serveSpaEntry(request, env);
  if (indexResponse) {
    return indexResponse;
  }

  return new Response("Hi", { status: 200 });
}
