import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GlassSummary } from "../glass-summary";

/**
 * 2026-10-29：摘要容器同时挂着 `line-clamp-*`（`display: -webkit-box`），
 * 那个布局下 `whitespace-pre-line` 的换行符会被吃掉，段落挤成一坨、缩进也丢，
 * 表现就是"同一页里有的摘要分段、有的不分段"。
 * 这里锁住"换行必须换成 <br>"，别再退回只靠 CSS。
 */
describe("GlassSummary 换行", () => {
    it("把 \\n 渲染成 <br>", () => {
        const html = renderToStaticMarkup(<GlassSummary text={"第一段\n第二段"} />);
        expect(html).toContain("<br");
        expect(html).toContain("第一段");
        expect(html).toContain("第二段");
    });

    it("单段不加 <br>", () => {
        const html = renderToStaticMarkup(<GlassSummary text={"只有一段文字"} />);
        expect(html).not.toContain("<br");
    });

    it("打码段里的换行同样处理", () => {
        const html = renderToStaticMarkup(<GlassSummary text={"\u0001甲\n乙\u0002"} />);
        expect(html).toContain("<br");
        expect(html).toContain("glass-text");
    });
});
