export function stripMarkdown(content: string): string {
    let text = content;

    text = text.replace(/<!--[\s\S]*?-->/g, "");
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
    text = text.replace(/<pre[\s\S]*?<\/pre>/gi, "");

    text = text.replace(/!\[.*?\]\(.*?\)/g, "");
    text = text.replace(/\[([^\]]*)\]\(.*?\)/g, "$1");
    text = text.replace(/^#{1,6}\s+/gm, "");
    text = text.replace(/^>\s+/gm, "");
    text = text.replace(/^(\s*)- \[[ x]\]\s+/gm, "$1");
    text = text.replace(/^[-*+]\s+/gm, "");
    text = text.replace(/^\d+\.\s+/gm, "");
    text = text.replace(/`{3}[\s\S]*?`{3}/g, "");
    text = text.replace(/`([^`]+)`/g, "$1");
    text = text.replace(/\*\*(.+?)\*\*/g, "$1");
    text = text.replace(/__(.+?)__/g, "$1");
    text = text.replace(/\*(.+?)\*/g, "$1");
    text = text.replace(/_(.+?)_/g, "$1");
    text = text.replace(/~~(.+?)~~/g, "$1");
    text = text.replace(/<[^>]+>/g, "");
    text = text.replace(/\[.*?\]\[.*?\]/g, "");
    text = text.replace(/^\[.*?\]:\s+.*$/gm, "");
    text = text.replace(/^---+$/gm, "");
    text = text.replace(/\|\s*[-:]+\s*\|/g, "");
    text = text.replace(/\|/g, " ");
    text = text.replace(/---+$/gm, "");
    text = text.replace(/\$\$[\s\S]*?\$\$/g, "");
    text = text.replace(/\$([^$]+)\$/g, "$1");
    text = text.replace(/:\w+:/g, "");
    text = text.replace(/^> \[!\w+\]/gm, "");

    text = text.trim();

    return text;
}

/** 句末标点（中英文都算）—— 摘要要在这里收口，别把"。"切掉 */
const SENTENCE_END_RE = /[。！？；…!?;]/;

/**
 * 生成摘要：**优先在句末标点处收口**，绝不留下"半句话、连句号都没有"的观感。
 * 背景（用户真机反馈："就差一个句号就不显示"）：原来是 `plainText.slice(0, 100)` 硬切，
 * 正好把最后一个句号切在窗口外面 ⇒ 卡片预览看起来像句子没写完。
 *
 * 规则：
 *   1. `maxLen` 以内出现过句末标点 ⇒ 截到**最后一个**标点（含它）；
 *   2. 一句里没有任何句末标点 ⇒ 硬切到 `maxLen` 并**补省略号**（明确告诉读者这里断了）；
 *   3. 本来就不超长 ⇒ 原样返回（保留换行，卡片靠 `whitespace-pre-line` 分段）。
 */
export function makeSummary(content: string, maxLen = 100): string {
    const text = stripMarkdown(content);
    if (text.length <= maxLen) return text;
    const window = text.slice(0, maxLen);
    for (let i = window.length - 1; i >= 0; i -= 1) {
        if (SENTENCE_END_RE.test(window[i])) return window.slice(0, i + 1);
    }
    return text.slice(0, maxLen).trimEnd() + "…";
}
