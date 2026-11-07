/**
 * 分页参数解析。
 *
 * 老写法是 `parseInt(limit) > 50 ? 50 : parseInt(limit)`：
 * `parseInt('abc')` 得 NaN，`NaN > 50` 为 false，NaN 就这么进了 SQL 的 limit/offset，
 * SQLite 直接报 `datatype mismatch` → 接口 500（`?limit=abc` 就能打挂列表页）。
 * 0 和负数同样没意义。
 *
 * 这里统一：解析不出整数 / 小于 1 ⇒ 回退默认值；超过上限 ⇒ 夹到上限。
 */
export function parsePageParam(
    value: string | null | undefined,
    fallback: number,
    max: number,
): number {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }

    return Math.min(parsed, max);
}
