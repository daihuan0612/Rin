import type { ReactNode } from "react";

/**
 * 列表摘要里的隐藏段：服务端发来的是**假字**，外面套两个哨兵字符
 * （`\u0001` 注册后可读 / `\u0003` 仅作者 / `\u0002` 收尾）。
 *
 * 这里把哨兵换成 `<span class="glass"><span class="glass-text">假字</span></span>`，
 * 复用正文那套毛玻璃样式，所以列表和详情页看起来是同一个东西。
 *
 * ⚠️ 原文一个字都不会到浏览器（服务端已经换成同字数的假字），前端只负责"罩子"。
 */
const MASK_OPEN = "\u0001";
const MASK_CLOSE = "\u0002";
const MASK_OPEN_OWNER = "\u0003";

export interface GlassSegment {
    text: string;
    masked: boolean;
    /** `[owner]` 段：只有作者能看，罩子颜色跟 `[glass]` 不一样 */
    ownerOnly: boolean;
}

/** 摘要里有没有隐藏段（给外面决定要不要加别的样式） */
export function hasMaskedSegment(text: string): boolean {
    return text.includes(MASK_OPEN) || text.includes(MASK_OPEN_OWNER);
}

/** 去掉哨兵，用于复制 / 纯文本场景 */
export function stripGlassMarks(text: string): string {
    return text.split(MASK_OPEN).join("").split(MASK_OPEN_OWNER).join("").split(MASK_CLOSE).join("");
}

/**
 * 把带哨兵的摘要切成"普通文字 / 打码段"两种片段。
 * 服务端漏了收尾哨兵（截断）时，剩下的也算打码段 —— 宁可多罩一层，不许把假字漏成正文样式。
 */
export function splitGlassSegments(text: string): GlassSegment[] {
    const segments: GlassSegment[] = [];
    let plain = "";
    let masked: string | null = null;
    let ownerOnly = false;

    const flushPlain = () => {
        if (plain) {
            segments.push({ text: plain, masked: false, ownerOnly: false });
            plain = "";
        }
    };

    const flushMasked = () => {
        if (masked === null) return;
        segments.push({ text: masked, masked: true, ownerOnly });
        masked = null;
    };

    for (const ch of text) {
        if (ch === MASK_OPEN || ch === MASK_OPEN_OWNER) {
            flushPlain();
            flushMasked();
            masked = "";
            ownerOnly = ch === MASK_OPEN_OWNER;
            continue;
        }
        if (ch === MASK_CLOSE) {
            flushMasked();
            continue;
        }
        if (masked !== null) {
            masked += ch;
        } else {
            plain += ch;
        }
    }
    flushMasked();
    flushPlain();

    return segments;
}

/**
 * 把文本里的 `\n` 换成真正的 `<br>` —— 2026-10-29
 *
 * ⚠️ 不能只靠外层的 `whitespace-pre-line`：摘要容器同时挂着 `line-clamp-*`
 * （`display: -webkit-box`），那个布局下换行符会被吃掉，段落就挤成一大坨、
 * 缩进也跟着没了。表现就是"同一页里有的摘要分段、有的不分段，文字对不齐"。
 * 换成 `<br>` 后不依赖任何 CSS 就能断行。
 */
function withLineBreaks(text: string, keyPrefix: string): ReactNode {
    if (!text.includes("\n")) {
        return text;
    }

    const parts: ReactNode[] = [];
    text.split("\n").forEach((line, index) => {
        if (index > 0) {
            parts.push(<br key={`${keyPrefix}-br-${index}`} />);
        }
        if (line) {
            parts.push(line);
        }
    });
    return parts;
}

export function GlassSummary({ text }: { text: string }) {
    const nodes: ReactNode[] = splitGlassSegments(text).map((segment, index) =>
        segment.masked ? (
            <span key={index} className={segment.ownerOnly ? "glass glass-owner" : "glass"}>
                <span className="glass-text">{withLineBreaks(segment.text, `m${index}`)}</span>
            </span>
        ) : (
            <span key={index}>{withLineBreaks(segment.text, `p${index}`)}</span>
        ),
    );

    return <>{nodes}</>;
}
