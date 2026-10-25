/**
 * 「取消打码」用的小工具：把 `[glass]…[/glass]` / `[owner]…[/owner]` 标记去掉，文字留着。
 *
 * 为什么单独放一个纯函数：写作页的撤销按钮要把"选区 → 新文本 + 新选区"算清楚，
 * 跟 Monaco 无关的部分全在这里，能直接单测（见 `__tests__/glass-markers.test.ts`）。
 *
 * 规则（跟用户实际会用的三种姿势对齐）：
 * 1. **整段选中**（含标记）⇒ 标记去掉；
 * 2. **光标落在段里 / 只选中一段里的一部分** ⇒ 整段的标记都去掉
 *    （不然会剩半截标记，比不打码更糟）；
 * 3. 选区里只有**孤立 / 配对不上**的标记（手改坏过）⇒ 也顺手去掉。
 */

export interface UnwrapHiddenResult {
    /** 去掉标记后的全文 */
    text: string;
    /** 取消打码后应该选中的区间（覆盖刚去掉标记的那段文字），按字符偏移 */
    start: number;
    end: number;
    /** 去掉了几个标记 */
    removed: number;
}

interface MarkerBlock {
    kind: "glass" | "owner";
    openStart: number;
    closeStart: number;
    closeEnd: number;
}

interface Span {
    start: number;
    end: number;
}

const openLength = (kind: string) => kind.length + 2; // `[glass]`
const closeLength = (kind: string) => kind.length + 3; // `[/glass]`

/** 找出成对的隐藏段（同一种标记里以最早出现的那组为准，跟服务端 `renderGlass` 的配对口径一致） */
function findBlocks(text: string): MarkerBlock[] {
    const blocks: MarkerBlock[] = [];
    for (const kind of ["glass", "owner"] as const) {
        const re = new RegExp(`\\[${kind}\\]([\\s\\S]*?)\\[\\/${kind}\\]`, "g");
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const closeStart = match.index + openLength(kind) + match[1].length;
            blocks.push({ kind, openStart: match.index, closeStart, closeEnd: closeStart + closeLength(kind) });
        }
    }
    return blocks;
}

/** 所有标记的字符区间（含配对不上的） */
function findMarkerSpans(text: string): Span[] {
    const spans: Span[] = [];
    const re = /\[(?:glass|owner)\]|\[\/(?:glass|owner)\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
}

function mergeSpans(spans: Span[]): Span[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Span[] = [];
    for (const span of sorted) {
        const last = merged[merged.length - 1];
        if (last && span.start <= last.end) {
            last.end = Math.max(last.end, span.end);
        } else {
            merged.push({ start: span.start, end: span.end });
        }
    }
    return merged;
}

/** 原文偏移 → 删掉标记后的偏移 */
function shiftOffset(removals: Span[], offset: number): number {
    let delta = 0;
    for (const span of removals) {
        if (span.end <= offset) {
            delta += span.end - span.start;
        } else if (span.start < offset) {
            delta += offset - span.start;
        }
    }
    return offset - delta;
}

export function unwrapHiddenMarkers(text: string, startOffset: number, endOffset: number): UnwrapHiddenResult | null {
    if (!/\[(?:glass|owner)\]|\[\/(?:glass|owner)\]/.test(text)) {
        return null;
    }

    const lower = Math.min(startOffset, endOffset);
    const upper = Math.max(startOffset, endOffset);
    const from = Math.max(0, Math.min(lower, text.length));
    const to = Math.max(0, Math.min(upper, text.length));

    // 选区/光标跟整块（含标记）有交集 ⇒ 这一整块的标记都去掉
    const hitBlocks = findBlocks(text).filter((block) => from < block.closeEnd && to > block.openStart);

    const removalSpans: Span[] = [];
    for (const block of hitBlocks) {
        removalSpans.push(
            { start: block.openStart, end: block.openStart + openLength(block.kind) },
            { start: block.closeStart, end: block.closeEnd },
        );
    }
    // 选区里配对不上的标记也一起清掉
    for (const span of findMarkerSpans(text)) {
        if (span.start >= from && span.end <= to) {
            removalSpans.push(span);
        }
    }

    const removals = mergeSpans(removalSpans);
    if (removals.length === 0) {
        return null;
    }
    // 去掉的标记个数按"单独的标记"算（相邻的两个标记在上面会被合并成一段，那只是切串用）
    const removedMarkers = new Set(removalSpans.map((span) => `${span.start}:${span.end}`)).size;

    let out = "";
    let cursor = 0;
    for (const span of removals) {
        out += text.slice(cursor, span.start);
        cursor = span.end;
    }
    out += text.slice(cursor);

    // 取消后把"刚解开的那段文字"选中，方便一眼确认（只选里面的正文，不含原来标记的位置）
    const regionStart = hitBlocks.length > 0
        ? Math.min(...hitBlocks.map((block) => block.openStart + openLength(block.kind)))
        : from;
    const regionEnd = hitBlocks.length > 0 ? Math.max(...hitBlocks.map((block) => block.closeStart)) : to;

    return {
        text: out,
        start: shiftOffset(removals, regionStart),
        end: shiftOffset(removals, regionEnd),
        removed: removedMarkers,
    };
}
