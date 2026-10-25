/**
 * `[glass]…[/glass]` 隐藏段 —— 服务端打码，前端只管样式。
 *
 * 为什么必须在服务端做：正文以 markdown 存在 D1、由前端渲染，
 * 只加 CSS blur 等于把原文原样发给浏览器，F12 一看就有。
 * 所以这里在**返回 JSON 之前**把隐藏段换成颗粒字符，前端拿到的就是颗粒。
 *
 * 三方视角：
 *   - 作者（站上唯一授权账号，`c.get('admin')`）→ 原文，套 `.glass.self`（无障碍阅读，正文零提示）
 *   - 其他人（游客/未登录/搜索引擎）→ 随机颗粒，套 `.glass`（毛玻璃质感，读不出、复制出也是颗粒）
 *
 * 已知边界：
 *   - 隐藏段里**不要写 markdown 语法**（加粗/链接/列表）——它走原始 HTML 分支，`**` 会原样显示。
 *   - 站内搜索的 SQL `like` 仍按原文命中（本文件只挡"显示"）。
 *   - 只认小写 `[glass]` / `[/glass]`，没有闭合标签的按普通正文原样输出。
 */

const GRAIN = ["░", "▒", "▓", "▚", "▞", "▪"];

/** `maskGlassPlain` 里一段最长打多少个方块（防止整章隐藏刷出一屏 ▒） */
const PLAIN_MAX = 120;

const GLASS_RE = /\[glass\]([\s\S]*?)\[\/glass\]/g;

const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 每个可见字符换成一个随机颗粒字符，保留换行和空格，排版不塌 */
export function maskGlassText(text: string): string {
    return text.replace(/[^\s]/g, () => GRAIN[(Math.random() * GRAIN.length) | 0]);
}

/** 渲染用：作者看原文（`.self` 不打磨砂），其他人看颗粒 */
export function renderGlass(content: string, isAuthor: boolean): string {
    if (!content) return content;
    return content.replace(GLASS_RE, (_m, inner: string) => {
        if (isAuthor) return `<span class="glass self">${escapeHtml(inner)}</span>`;
        return `<span class="glass">${maskGlassText(inner)}</span>`;
    });
}

/** 摘要 / 搜索 / RSS 这类纯文本场景：整段换成一排方块 */
export function maskGlassPlain(content: string): string {
    if (!content) return content;
    return content.replace(GLASS_RE, (_m, inner: string) =>
        "▒".repeat(Math.min(inner.replace(/\s/g, "").length, PLAIN_MAX))
    );
}
