import { describe, expect, it } from "vitest";
import { hasMaskedSegment, splitGlassSegments, stripGlassMarks } from "../glass-summary";

const OPEN = "\u0001";
const CLOSE = "\u0002";
const OPEN_OWNER = "\u0003";

describe("splitGlassSegments（列表摘要的毛玻璃分段）", () => {
    it("没有哨兵 ⇒ 整段当普通文字", () => {
        expect(splitGlassSegments("普通摘要")).toEqual([
            { text: "普通摘要", masked: false, ownerOnly: false },
        ]);
    });

    it("普通文字 / 打码段 / 普通文字 三段切开，顺序不变", () => {
        expect(splitGlassSegments(`前${OPEN}假字假字${CLOSE}后`)).toEqual([
            { text: "前", masked: false, ownerOnly: false },
            { text: "假字假字", masked: true, ownerOnly: false },
            { text: "后", masked: false, ownerOnly: false },
        ]);
    });

    it("`[owner]` 段标成 ownerOnly（前端用另一种罩子颜色）", () => {
        expect(splitGlassSegments(`${OPEN_OWNER}只给作者${CLOSE}`)).toEqual([
            { text: "只给作者", masked: true, ownerOnly: true },
        ]);
    });

    it("服务端截断漏了收尾哨兵 ⇒ 剩下的一段照样算打码", () => {
        expect(splitGlassSegments(`前${OPEN}假字`)).toEqual([
            { text: "前", masked: false, ownerOnly: false },
            { text: "假字", masked: true, ownerOnly: false },
        ]);
    });

    it("空串 / 只有哨兵都不炸", () => {
        expect(splitGlassSegments("")).toEqual([]);
        expect(splitGlassSegments(OPEN + CLOSE)).toEqual([
            { text: "", masked: true, ownerOnly: false },
        ]);
    });
});

describe("hasMaskedSegment / stripGlassMarks", () => {
    it("能判断有没有隐藏段", () => {
        expect(hasMaskedSegment(`前${OPEN}假${CLOSE}`)).toBe(true);
        expect(hasMaskedSegment(`前${OPEN_OWNER}假${CLOSE}`)).toBe(true);
        expect(hasMaskedSegment("普通摘要")).toBe(false);
    });

    it("去哨兵后只剩文字（复制 / 纯文本用）", () => {
        expect(stripGlassMarks(`前${OPEN}假字${CLOSE}后${OPEN_OWNER}乙${CLOSE}`)).toBe("前假字后乙");
    });
});
