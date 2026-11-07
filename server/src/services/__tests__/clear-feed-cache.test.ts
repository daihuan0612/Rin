import { describe, expect, it } from 'bun:test';

import { clearFeedCache } from '../clear-feed-cache';

/**
 * 2026-11-07：CacheImpl.save() 不再做"内存里没有就删"的差集兜底
 * （那个差集在每请求新建实例的场景下会把别人刚写的键抹掉），
 * 所以详情键必须走 `delete(key)` 让持久层一起删，末尾也不再需要补一次 save。
 */
describe('clearFeedCache', () => {
    it('deletes alias cache when alias is unchanged', async () => {
        const deletedPrefixes: string[] = [];
        const deletedKeys: Array<{ key: string; save: boolean | undefined }> = [];
        const cache = {
            async deletePrefix(prefix: string) {
                deletedPrefixes.push(prefix);
            },
            async delete(key: string, save?: boolean) {
                deletedKeys.push({ key, save });
            },
            async save() {}
        } as any;

        await clearFeedCache(cache, 42, 'about', 'about');

        expect(deletedPrefixes).toEqual([
            'feeds_',
            'search_',
            '42_previous_feed',
            '42_next_feed'
        ]);
        expect(deletedKeys).toEqual([
            { key: 'feed_42', save: undefined },
            { key: 'feed_id_42', save: undefined },
            { key: 'feed_about', save: undefined },
            { key: 'feed_alias_about', save: undefined }
        ]);
    });

    it('deletes both old and new alias cache keys when alias changes', async () => {
        const deletedKeys: Array<{ key: string; save: boolean | undefined }> = [];
        const cache = {
            async deletePrefix() {},
            async delete(key: string, save?: boolean) {
                deletedKeys.push({ key, save });
            },
            async save() {}
        } as any;

        await clearFeedCache(cache, 42, 'about', 'about-us');

        expect(deletedKeys).toEqual([
            { key: 'feed_42', save: undefined },
            { key: 'feed_id_42', save: undefined },
            { key: 'feed_about', save: undefined },
            { key: 'feed_alias_about', save: undefined },
            { key: 'feed_about-us', save: undefined },
            { key: 'feed_alias_about-us', save: undefined }
        ]);
    });

    it('每个详情键都要真正落库删除，不再靠末尾 save 的差集', async () => {
        const operations: string[] = [];
        const cache = {
            async deletePrefix(prefix: string) {
                operations.push(`prefix:${prefix}`);
            },
            async delete(key: string, save?: boolean) {
                operations.push(`delete:${key}:${save === false ? 'memory-only' : 'persist'}`);
            },
            async save() {
                operations.push('save');
            }
        } as any;

        await clearFeedCache(cache, 42, 'about', 'about');

        expect(operations).toEqual([
            'prefix:feeds_',
            'prefix:search_',
            'delete:feed_42:persist',
            'delete:feed_id_42:persist',
            'delete:feed_about:persist',
            'delete:feed_alias_about:persist',
            'prefix:42_previous_feed',
            'prefix:42_next_feed'
        ]);
    });
});
