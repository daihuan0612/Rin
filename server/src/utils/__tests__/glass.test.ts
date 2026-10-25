import { describe, expect, it } from 'bun:test';
import { maskGlassPlain, maskGlassText, renderGlass } from '../glass';

describe('maskGlassText', () => {
    it('可见字符全换颗粒，换行和空格保留（排版不塌）', () => {
        const out = maskGlassText('秘密 A\n第二行');
        expect(out).toHaveLength('秘密 A\n第二行'.length);
        expect(out).toContain('\n');
        expect(out).not.toContain('秘');
        expect(out).not.toContain('A');
    });
});

describe('renderGlass', () => {
    it('作者：原文 + .glass.self（无障碍阅读，方便编辑器还原标记）', () => {
        expect(renderGlass('前[glass]只有我能看[/glass]后', true)).toBe(
            '前<span class="glass self">只有我能看</span>后',
        );
    });

    it('其他人：颗粒 + .glass，原文一个字都不许留', () => {
        const out = renderGlass('前[glass]只有我能看[/glass]后', false);
        expect(out).toContain('<span class="glass">');
        expect(out).not.toContain('只有我能看');
        expect(out.startsWith('前')).toBe(true);
        expect(out.endsWith('后')).toBe(true);
    });

    it('作者分支转义 HTML，避免正文里的尖括号被当成标签', () => {
        expect(renderGlass('[glass]a<b&c[/glass]', true)).toBe(
            '<span class="glass self">a&lt;b&amp;c</span>',
        );
    });

    it('多段 / 跨行都能替换', () => {
        const out = renderGlass('[glass]一[/glass]中[glass]二\n三[/glass]', true);
        expect(out.match(/class="glass self"/g)).toHaveLength(2);
        expect(out).toContain('二\n三');
    });

    it('没有闭合标签 / 没有标记 ⇒ 原样返回', () => {
        expect(renderGlass('普通[glass]正文', true)).toBe('普通[glass]正文');
        expect(renderGlass('普通正文', false)).toBe('普通正文');
        expect(renderGlass('', false)).toBe('');
    });
});

describe('maskGlassPlain', () => {
    it('整段换成一排方块，不保留原文', () => {
        const out = maskGlassPlain('前面[glass]隐藏内容[/glass]后面');
        expect(out).toBe('前面' + '▒'.repeat(4) + '后面');
    });

    it('忽略空白计数，且最多 120 个', () => {
        expect(maskGlassPlain('[glass]字 字\n字[/glass]')).toBe('▒▒▒');
        expect(maskGlassPlain('[glass]' + '字'.repeat(500) + '[/glass]')).toBe('▒'.repeat(120));
    });

    it('没有标记 ⇒ 原样返回', () => {
        expect(maskGlassPlain('什么都没有')).toBe('什么都没有');
    });
});
