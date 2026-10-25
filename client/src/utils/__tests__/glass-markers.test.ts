import { describe, expect, it } from "vitest";
import { unwrapHiddenMarkers } from "../glass-markers";

const T1 = "前[glass]秘密[/glass]后"; // 前=0..1  [glass]=1..8  秘密=8..10  [/glass]=10..18  后=18

describe("unwrapHiddenMarkers（取消打码）", () => {
    it("整段选中（含标记）⇒ 标记去掉，文字留着，新选区罩住解开的文字", () => {
        const r = unwrapHiddenMarkers(T1, 0, T1.length);
        expect(r).not.toBeNull();
        expect(r!.text).toBe("前秘密后");
        expect(r!.removed).toBe(2);
        expect(r!.text.slice(r!.start, r!.end)).toBe("秘密");
    });

    it("光标停在段里（没选区）⇒ 整段的标记都去掉", () => {
        const r = unwrapHiddenMarkers(T1, 9, 9);
        expect(r!.text).toBe("前秘密后");
        expect(r!.removed).toBe(2);
        expect(r!.text.slice(r!.start, r!.end)).toBe("秘密");
    });

    it("只选中段里的一部分 ⇒ 也整段取消（不留下半截标记）", () => {
        const r = unwrapHiddenMarkers(T1, 9, 10);
        expect(r!.text).toBe("前秘密后");
        expect(r!.text.slice(r!.start, r!.end)).toBe("秘密");
    });

    it("选区完全在外面 ⇒ 什么都不做", () => {
        expect(unwrapHiddenMarkers(T1, 0, 1)).toBeNull();
        expect(unwrapHiddenMarkers("没有标记的正文", 0, 3)).toBeNull();
    });

    it("两个段一起选中 ⇒ 两个都取消", () => {
        const text = "[glass]甲[/glass][owner]乙[/owner]";
        const r = unwrapHiddenMarkers(text, 0, text.length);
        expect(r!.text).toBe("甲乙");
        expect(r!.removed).toBe(4);
    });

    it("`[owner]` 段同样能取消", () => {
        const text = "头[owner]只有我能看[/owner]尾";
        const r = unwrapHiddenMarkers(text, 1, text.length - 1);
        expect(r!.text).toBe("头只有我能看尾");
        expect(r!.removed).toBe(2);
    });

    it("配对不上的孤立标记（手改坏过）⇒ 选中范围内的也清掉", () => {
        const r = unwrapHiddenMarkers("前[glass]后", 0, 10);
        expect(r!.text).toBe("前后");
        expect(r!.removed).toBe(1);

        const r2 = unwrapHiddenMarkers("前[/glass]后", 0, 11);
        expect(r2!.text).toBe("前后");
    });

    it("跨行的隐藏段也能取消", () => {
        const text = "开头[glass]第一行\n第二行[/glass]结尾";
        const r = unwrapHiddenMarkers(text, text.indexOf("第二行"), text.indexOf("第二行"));
        expect(r!.text).toBe("开头第一行\n第二行结尾");
        expect(r!.removed).toBe(2);
    });
});
