import { describe, expect, it } from 'bun:test';
import { hasGlass, hasOwner, maskGlassPlain, maskGlassText, renderGlass } from '../glass';

describe('maskGlassText', () => {
    it('非空白字符全换假字，长度 / 换行 / 空格保留（排版不塌）', () => {
        const input = '秘密内容\n第二行';
        const output = maskGlassText(input);
        expect(output).toHaveLength(input.length);
        expect(output.split('\n')).toHaveLength(2);
        expect(output).not.toContain('秘');
        expect(output).not.toContain('密');
    });

    it('输出的是真汉字（磨砂玻璃下才有字形，不是颗粒符号）', () => {
        const output = maskGlassText('隐藏内容');
        expect(output).toMatch(/^[\u4e00-\u9fa5]+$/);
        expect(output).not.toMatch(/[░▒▓▚▞▪]/);
    });

    it('确定性：同一段文字每次结果一样（缓存前后一致）', () => {
        expect(maskGlassText('同一段')).toBe(maskGlassText('同一段'));
    });

    it('不含会被 markdown 当成语法的字符', () => {
        const out = maskGlassText('一段比较长的中文内容，用来检查有没有语法字符');
        expect(out).not.toMatch(/[[\]*_`<>#|-]/);
    });
});

describe('renderGlass', () => {
    it('作者：[glass] 原文 + .glass.self（无障碍阅读，方便编辑器还原标记）', () => {
        expect(renderGlass('前[glass]只有我能看[/glass]后', 'owner')).toBe(
            '前<span class="glass self">只有我能看</span>后',
        );
    });

    it('作者：[owner] 原文 + .owner.self（写作页靠这个类还原 [owner] 标记）', () => {
        expect(renderGlass('前[owner]只有我能看[/owner]后', 'owner')).toBe(
            '前<span class="owner self">只有我能看</span>后',
        );
    });

    it('登录读者：[glass] 给原文，套 .glass.member（样式等同正文）', () => {
        expect(renderGlass('前[glass]给读者看[/glass]后', 'member')).toBe(
            '前<span class="glass member">给读者看</span>后',
        );
    });

    it('登录读者：[owner] 仍是假字，原文一个字都不许留', () => {
        const out = renderGlass('前[owner]只有作者[/owner]后', 'member');
        expect(out).not.toContain('只有作者');
        expect(out).toContain('class="glass glass-owner"');
        expect(out).toContain('<span class="glass-text">');
    });

    it('游客：[glass] 和 [owner] 都是假字 + 磨砂玻璃，原文一个字都不出去', () => {
        const out = renderGlass('前[glass]读者内容[/glass]中[owner]作者内容[/owner]后', 'guest');
        expect(out).not.toContain('读者内容');
        expect(out).not.toContain('作者内容');
        expect(out.match(/class="glass"/g)).toHaveLength(1);
        expect(out.match(/class="glass glass-owner"/g)).toHaveLength(1);
        expect(out.startsWith('前')).toBe(true);
        expect(out.endsWith('</span></span>后')).toBe(true);
    });

    it('两种隐藏段的悬停提示不同（游客能分清"注册可读"和"仅作者"）', () => {
        const out = renderGlass('[glass]甲[/glass][owner]乙[/owner]', 'guest');
        expect(out).toContain('title="此处内容已隐藏（注册后可读）"');
        expect(out).toContain('title="此处内容仅作者可见"');
    });

    it('作者分支转义 HTML，避免正文里的尖括号被当成标签', () => {
        expect(renderGlass('[glass]a<b&c[/glass]', 'owner')).toBe(
            '<span class="glass self">a&lt;b&amp;c</span>',
        );
        expect(renderGlass('[owner]a<b&c[/owner]', 'owner')).toBe(
            '<span class="owner self">a&lt;b&amp;c</span>',
        );
    });

    it('多段 / 跨行都能替换', () => {
        const out = renderGlass('[glass]一[/glass]中[glass]二\n三[/glass]', 'owner');
        expect(out.match(/class="glass self"/g)).toHaveLength(2);
        expect(out).toContain('二\n三');
    });

    it('开/闭标签必须配对（[glass] 不能用 [/owner] 收尾）', () => {
        expect(renderGlass('[glass]甲[/owner]', 'guest')).toBe('[glass]甲[/owner]');
    });

    it('孤立的开标签（正文里把 [glass] 当词写出来）不会吞掉后面真正的隐藏段', () => {
        const text = '这一段是（[glass]）那种写法\n\n[glass]真正要藏的内容[/glass]';
        const out = renderGlass(text, 'guest');
        expect(out).toContain('这一段是（[glass]）那种写法');
        expect(out).not.toContain('真正要藏的内容');
        expect(out.match(/class="glass"/g)).toHaveLength(1);
    });

    it('没有闭合标签 / 没有标记 ⇒ 原样返回', () => {
        expect(renderGlass('普通[glass]正文', 'owner')).toBe('普通[glass]正文');
        expect(renderGlass('普通正文', 'guest')).toBe('普通正文');
        expect(renderGlass('', 'guest')).toBe('');
    });
});

describe('maskGlassPlain', () => {
    it('整段换成一排方块，不保留原文', () => {
        const out = maskGlassPlain('前面[glass]隐藏内容[/glass]后面');
        expect(out).toBe('前面' + '▒'.repeat(4) + '后面');
    });

    it('[owner] 也一样打码（摘要 / RSS 走纯文本出口时不能漏）', () => {
        const out = maskGlassPlain('前[owner]私密[/owner]后');
        expect(out).toBe('前' + '▒'.repeat(2) + '后');
    });

    it('忽略空白计数，且最多 120 个', () => {
        expect(maskGlassPlain('[glass]字 字\n字[/glass]')).toBe('▒▒▒');
        expect(maskGlassPlain('[glass]' + '字'.repeat(500) + '[/glass]')).toBe('▒'.repeat(120));
    });

    it('没有标记 ⇒ 原样返回', () => {
        expect(maskGlassPlain('什么都没有')).toBe('什么都没有');
    });
});

describe('hasGlass / hasOwner', () => {
    it('分别识别两种标记', () => {
        expect(hasGlass('[glass]甲[/glass]')).toBe(true);
        expect(hasGlass('[owner]甲[/owner]')).toBe(false);
        expect(hasOwner('[owner]甲[/owner]')).toBe(true);
        expect(hasOwner('[glass]甲[/glass]')).toBe(false);
    });

    it('没闭合 / 空内容都不算', () => {
        expect(hasGlass('[glass]甲')).toBe(false);
        expect(hasOwner('[owner]甲')).toBe(false);
        expect(hasGlass('')).toBe(false);
        expect(hasOwner('')).toBe(false);
    });
});
