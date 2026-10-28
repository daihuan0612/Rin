/**
 * 同源媒体代理的白名单（`/api/img-proxy`）—— 2026-10-28
 *
 * ⚠️ 前后端**必须**用这一份：前端负责把地址改写成代理地址，后端负责校验放行。
 * 两边各写一份时，改一处漏一处就会变成"前端指向代理、后端 403"的全站破图。
 *
 * 名单是扫线上文章实际出现的外链域名得出来的，多一个都不要加 ——
 * 这个端点不鉴权，放开任意 URL 就成了给全网白嫖的开放代理。
 */
export const IMAGE_PROXY_HOSTS: readonly string[] = ["pan.xfl.cc.cd", "xfl.cc.cd"];

/** hostname 是否在代理白名单里 */
export function isProxiedMediaHost(hostname: string) {
  return IMAGE_PROXY_HOSTS.includes(hostname);
}
