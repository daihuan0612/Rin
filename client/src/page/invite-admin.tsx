import { useEffect, useState } from "react";
import { t } from "i18next";
import { Helmet } from "react-helmet";
import { client } from "../app/runtime";
import type { InviteCodeItem, InviteListResponse } from "@rin/api";

/**
 * 邀请码管理（作者专页）
 *
 * 一次一码：每枚码带一句"给谁的"，注册成功后这句话直接变成那个用户的备注。
 * 已用过的码默认折叠起来 —— 码越攒越多，不折叠的话列表会挡事。
 */
export function InviteAdminPage() {
    const [data, setData] = useState<InviteListResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [count, setCount] = useState('1');
    const [note, setNote] = useState('');
    const [creating, setCreating] = useState(false);
    const [created, setCreated] = useState<string[]>([]);
    const [showUsed, setShowUsed] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [message, setMessage] = useState('');

    const load = async () => {
        setLoading(true);
        const { data: res } = await client.invite.list('all');
        if (res) setData(res);
        setLoading(false);
    };

    useEffect(() => {
        void load();
    }, []);

    const create = async () => {
        const n = Number(count);
        if (!Number.isFinite(n) || n < 1) {
            setMessage(t('invite.admin.invalid_count'));
            return;
        }
        setCreating(true);
        setMessage('');
        const { data: res, error } = await client.invite.create({ count: n, note });
        setCreating(false);
        if (error || !res) {
            setMessage(t('invite.admin.create_failed'));
            return;
        }
        setCreated(res.created);
        setNote('');
        await load();
    };

    const copy = async (code: string) => {
        try {
            await navigator.clipboard.writeText(code);
            setMessage(t('invite.admin.copied'));
        } catch {
            setMessage(code);
        }
    };

    const revoke = async (item: InviteCodeItem) => {
        setBusyId(item.id);
        const { error } = await client.invite.revoke(item.id);
        setBusyId(null);
        if (error) {
            setMessage(t('invite.admin.action_failed'));
            return;
        }
        await load();
    };

    const remove = async (item: InviteCodeItem) => {
        if (!confirm(t('invite.admin.delete_confirm'))) return;
        setBusyId(item.id);
        const { error } = await client.invite.remove(item.id);
        setBusyId(null);
        if (error) {
            setMessage(t('invite.admin.action_failed'));
            return;
        }
        await load();
    };

    const unused = data?.list.filter((i) => !i.usedBy && !i.revoked) ?? [];
    const used = data?.list.filter((i) => !!i.usedBy) ?? [];
    const revoked = data?.list.filter((i) => i.revoked && !i.usedBy) ?? [];

    return (
        <div className="flex flex-col gap-4">
            <Helmet>
                <title>{`${t('invite.admin.title')} - ${t('admin.title')}`}</title>
            </Helmet>

            <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-neutral-50 p-4 dark:border-white/10 dark:bg-neutral-900/40">
                <p className="text-sm t-primary font-medium">{t('invite.admin.create_title')}</p>
                <p className="text-xs t-secondary leading-5">{t('invite.admin.create_hint')}</p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={t('invite.admin.note_placeholder')}
                        className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none dark:border-white/10 sm:max-w-sm"
                    />
                    <input
                        value={count}
                        onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ''))}
                        className="w-24 rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none dark:border-white/10"
                    />
                    <button
                        onClick={() => void create()}
                        disabled={creating}
                        className="rounded-full bg-theme px-4 py-2 text-sm text-white disabled:opacity-60"
                    >
                        {creating ? t('invite.admin.creating') : t('invite.admin.create')}
                    </button>
                </div>
                {created.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                        {created.map((code) => (
                            <button
                                key={code}
                                onClick={() => void copy(code)}
                                className="rounded-lg bg-w px-2 py-1 font-mono text-xs t-primary ring-1 ring-black/10 dark:ring-white/10"
                                title={t('invite.admin.copy')}
                            >
                                {code}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {message && <p className="text-xs text-theme">{message}</p>}

            {loading && <p className="text-sm t-secondary">{t('invite.admin.loading')}</p>}

            {!loading && data && (
                <>
                    <div className="flex flex-wrap gap-4 text-xs t-secondary">
                        <span>{t('invite.admin.summary_unused', { count: data.summary.unused })}</span>
                        <span>{t('invite.admin.summary_used', { count: data.summary.used })}</span>
                        <span>{t('invite.admin.summary_total', { count: data.summary.total })}</span>
                    </div>

                    <div className="flex flex-col gap-2">
                        <p className="text-sm font-medium t-primary">{t('invite.admin.unused_title')}</p>
                        {unused.length === 0 && <p className="text-xs t-secondary">{t('invite.admin.empty_unused')}</p>}
                        {unused.map((item) => (
                            <div
                                key={item.id}
                                className="flex flex-col gap-2 rounded-2xl border border-black/10 bg-w p-3 dark:border-white/10 sm:flex-row sm:items-center"
                            >
                                <button
                                    onClick={() => void copy(item.code)}
                                    className="font-mono text-sm t-primary hover:underline"
                                    title={t('invite.admin.copy')}
                                >
                                    {item.code}
                                </button>
                                <span className="text-xs t-secondary sm:ml-2">{item.note || '-'}</span>
                                <div className="flex gap-2 sm:ml-auto">
                                    <button
                                        onClick={() => void revoke(item)}
                                        disabled={busyId === item.id}
                                        className="rounded-full border border-black/10 px-3 py-1 text-xs t-primary hover:bg-neutral-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                                    >
                                        {t('invite.admin.revoke')}
                                    </button>
                                    <button
                                        onClick={() => void remove(item)}
                                        disabled={busyId === item.id}
                                        className="rounded-full border border-black/10 px-3 py-1 text-xs t-primary hover:bg-neutral-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                                    >
                                        {t('invite.admin.delete')}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="flex flex-col gap-2">
                        <button
                            onClick={() => setShowUsed(!showUsed)}
                            className="flex items-center gap-2 self-start text-sm font-medium t-primary"
                        >
                            <i className={showUsed ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} />
                            {t('invite.admin.used_title', { count: used.length })}
                        </button>
                        {showUsed && used.length === 0 && (
                            <p className="text-xs t-secondary">{t('invite.admin.empty_used')}</p>
                        )}
                        {showUsed &&
                            used.map((item) => (
                                <div
                                    key={item.id}
                                    className="flex flex-col gap-1 rounded-2xl border border-black/10 bg-neutral-50 p-3 text-xs t-secondary dark:border-white/10 dark:bg-neutral-900/40 sm:flex-row sm:items-center"
                                >
                                    <span className="font-mono line-through opacity-60">{item.code}</span>
                                    <span className="sm:ml-2">{item.note || '-'}</span>
                                    <span className="sm:ml-auto">
                                        {t('invite.admin.used_by', {
                                            name: item.usedByName || '-',
                                            date: item.usedAt ? new Date(item.usedAt).toLocaleString() : '',
                                        })}
                                    </span>
                                </div>
                            ))}
                    </div>

                    {revoked.length > 0 && (
                        <p className="text-xs t-secondary">
                            {t('invite.admin.revoked_title', { count: revoked.length })}
                        </p>
                    )}
                </>
            )}
        </div>
    );
}
