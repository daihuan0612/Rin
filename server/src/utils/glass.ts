/**
 * `[glass]…[/glass]` 隐藏段 —— 服务端打码，前端只管样式。
 *
 * 为什么必须在服务端做：正文以 markdown 存在 D1、由前端渲染，
 * 只加 CSS blur 等于把原文原样发给浏览器，F12 一看就有。
 * 所以这里在**返回 JSON 之前**就把隐藏段换掉，前端拿到的从来不是原文。
 *
 * 三方视角：
 *   - 作者（站上唯一授权账号，`c.get('admin')`）→ 原文，套 `.glass.self`（无障碍阅读，正文零提示）
 *   - 其他人（游客/未登录/搜索引擎）→ **等长的假字**，套 `.glass`（前端再模糊 + 磨砂玻璃质感）
 *
 * 为什么用假字而不是颗粒符号：
 * 一开始这里放的是 `░▒▓` 这类方块颗粒，前端模糊之后会变成一条条"蚯蚓"，
 * 不像磨砂玻璃下的文字。磨砂玻璃底下应该是**真实字形被糊住**，
 * 所以改成等长的常用汉字（真字形、假内容）：观感对，且原文一个字都不出去。
 *
 * 已知边界：
 *   - 隐藏段里**不要写 markdown 语法**（加粗/链接/列表）——它走原始 HTML 分支，`**` 会原样显示。
 *   - 站内搜索的 SQL `like` 仍按原文命中（本文件只挡"显示"）。
 *   - 只认小写 `[glass]` / `[/glass]`，没有闭合标签的按普通正文原样输出。
 */

/**
 * 假字池：常用汉字的固定序列（跟原文无关，按位置取，因此同一段每次渲染都一样）。
 * 故意不含 `[` `]` `*` `_` 等会被 markdown 当成语法的字符。
 */
const PSEUDO_POOL =
    "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题程展五果料象员位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞";

/** `maskGlassPlain` 里一段最长打多少个方块（防止整章隐藏刷出一屏 ▒） */
const PLAIN_MAX = 120;

const GLASS_RE = /\[glass\]([\s\S]*?)\[\/glass\]/g;

const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 每个非空白字符换成一个假字，长度、换行、空格全部保持 ⇒ 排版不塌。
 * 同一个位置永远取同一个假字（不用随机数），缓存/CDN 前后看到的一致。
 */
export function maskGlassText(text: string): string {
    let i = 0;
    return text.replace(/[^\s]/g, () => PSEUDO_POOL[i++ % PSEUDO_POOL.length]);
}

/**
 * 渲染用：作者看原文（`.self` 不打磨砂），其他人看假字。
 * `title` 是给访客的诚实提示：想复制/悬停时会看到"此处内容已隐藏"，而不是以为自己看到了乱码。
 */
export function renderGlass(content: string, isAuthor: boolean): string {
    if (!content) return content;
    return content.replace(GLASS_RE, (_m, inner: string) => {
        if (isAuthor) return `<span class="glass self">${escapeHtml(inner)}</span>`;
        return `<span class="glass" title="此处内容已隐藏（仅作者可见）"><span class="glass-text">${maskGlassText(inner)}</span></span>`;
    });
}

/** 摘要 / 搜索 / RSS 这类纯文本场景：整段换成一排方块 */
export function maskGlassPlain(content: string): string {
    if (!content) return content;
    return content.replace(GLASS_RE, (_m, inner: string) =>
        "▒".repeat(Math.min(inner.replace(/\s/g, "").length, PLAIN_MAX))
    );
}

/** 正文里有没有隐藏段（给"AI 摘要这类二次加工产物"当开关用） */
export function hasGlass(content: string): boolean {
    if (!content) return false;
    return /\[glass\][\s\S]*?\[\/glass\]/.test(content);
}
