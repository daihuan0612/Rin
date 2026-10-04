import { describe, expect, it } from 'bun:test';
import { makeSummary, stripMarkdown } from '../markdown';

describe('stripMarkdown', () => {
    it('removes media and code from summary text', () => {
        const result = stripMarkdown([
            '# Title',
            '<iframe src="https://example.com/embed"></iframe>',
            '```ts',
            'const hidden = true;',
            '```',
            '![cover](https://example.com/cover.png)',
            '[Read more](https://example.com)',
        ].join('\n'));

        expect(result).toContain('Title');
        expect(result).toContain('Read more');
        expect(result).not.toContain('iframe');
        expect(result).not.toContain('hidden');
        expect(result).not.toContain('cover.png');
    });

    it('strips task markers before generic list markers', () => {
        expect(stripMarkdown('- [x] Done\n- [ ] Todo')).toBe('Done\nTodo');
    });
});

describe('makeSummary', () => {
    it('在句末标点处收口：不许把最后的句号切掉（用户真机反馈）', () => {
        const body = "从道家角度看，你驾驭不住的东西才会显相。情绪驾驭不住，则怒气挂脸。财富驾驭不住，则铜锈外露。权力驾驭不住，则盛气凌人。所以真正的贵人没有骄奢气，真正的高手没有刀剑气，真正的美人也没有造作态，这一点古今皆然。";
        const summary = makeSummary(body, 100);
        expect(summary.length).toBeLessThanOrEqual(100);
        expect(summary.endsWith('。')).toBe(true);
    });

    it('一句里没有句末标点 ⇒ 硬切并补省略号（明确告诉读者断了）', () => {
        expect(makeSummary('啊'.repeat(200), 20)).toBe('啊'.repeat(20) + '…');
    });

    it('本来就不超长 ⇒ 原样返回（换行保留）', () => {
        expect(makeSummary('第一段。\n第二段。', 100)).toBe('第一段。\n第二段。');
    });

    it('先剥 markdown 再收口（图片不该占摘要的字数）', () => {
        const summary = makeSummary('![图](https://x/y.png)第一句。第二句。第三句。', 8);
        expect(summary.startsWith('第一句。')).toBe(true);
    });
});
