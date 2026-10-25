import { useEffect, useMemo, useState } from "react";
import { t } from "i18next";
import { Helmet } from "react-helmet";
import { client } from "../app/runtime";
import type { AdminUserItem } from "@rin/api";

/**
 * 用户管理（作者专页）
 *
 * 这张表的重点不是"改权限"，而是**认人**：每行都带注册时用的邀请码、那枚码上写的备注、
 * 他自己填的一句"你是谁"、注册 IP。备注可以改，停用可以一键。
 */
export function UsersAdminPage() {
    const [users, setUsers] = useState<AdminUserItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [keyword, setKeyword] = useState('');
    const [onlyReaders, setOnlyReaders] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
    const [message, setMessage] = useState('');

    const load = async () => {
        setLoading(true);
        const { data } = await client.user.adminList();
        if (data) {
            setUsers(data);
            setNoteDraft(Object.fromEntries(data.map((u) => [u.id, u.note])));
        }
        setLoading(false);
    };

    useEffect(() => {
        void load();
    }, []);

    const filtered = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        return users.filter((u) => {
            if (onlyReaders && u.permission) return false;
            if (!kw) return true;
            return (
                u.username.toLowerCase().includes(kw) ||
                u.note.toLowerCase().includes(kw) ||
                u.signupNote.toLowerCase().includes(kw) ||
                u.inviteCode.toLowerCase().includes(kw)
            );
        });
    }, [users, keyword, onlyReaders]);

    const saveNote = async (user: AdminUserItem) => {
        const draft = (noteDraft[user.id] ?? '').trim();
        if (draft === user.note) return;
        setBusyId(user.id);
        const { error } = await client.user.adminUpdate(user.id, { note: draft });
        setBusyId(null);
        if (error) {
            setMessage(t('user.admin.save_failed'));
            return;
        }
        setMessage(t('user.admin.saved'));
        await load();
    };

    const toggleDisabled = async (user: AdminUserItem) => {
        setBusyId(user.id);
        const { error } = await client.user.adminUpdate(user.id, { disabled: !user.disabled });
        setBusyId(null);
        if (error) {
            setMessage(t('user.admin.save_failed'));
            return;
        }
        await load();
    };

    return (
        <div className="flex flex-col gap-4">
            <Helmet>
                <title>{`${t('user.admin.title')} - ${t('admin.title')}`}</title>
            </Helmet>

            <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-neutral-50 p-4 dark:border-white/10 dark:bg-neutral-900/40 sm:flex-row sm:items-center">
                <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder={t('user.admin.search_placeholder')}
                    className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none dark:border-white/10 sm:max-w-xs"
                />
                <label className="flex items-center gap-2 text-sm t-secondary">
                    <input
                        type="checkbox"
                        checked={onlyReaders}
                        onChange={(e) => setOnlyReaders(e.target.checked)}
                    />
                    {t('user.admin.only_readers')}
                </label>
                <span className="text-xs t-secondary sm:ml-auto">
                    {t('user.admin.count', { count: filtered.length })}
                </span>
            </div>

            {message && <p className="text-xs text-theme">{message}</p>}

            {loading && <p className="text-sm t-secondary">{t('user.admin.loading')}</p>}

            {!loading && filtered.length === 0 && (
                <p className="text-sm t-secondary">{t('user.admin.empty')}</p>
            )}

            <div className="flex flex-col gap-3">
                {filtered.map((user) => (
                    <div
                        key={user.id}
                        className={`rounded-2xl border p-4 ${
                            user.disabled
                                ? 'border-red-200 bg-red-50/40 dark:border-red-500/30 dark:bg-red-500/5'
                                : 'border-black/10 bg-w dark:border-white/10'
                        }`}
                    >
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-base font-semibold t-primary">{user.username}</span>
                            {user.permission ? (
                                <span className="rounded-full bg-theme px-2 py-0.5 text-[11px] text-white">
                                    {t('user.admin.role_owner')}
                                </span>
                            ) : (
                                <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-white/10 dark:text-neutral-300">
                                    {t('user.admin.role_reader')}
                                </span>
                            )}
                            {user.disabled && (
                                <span className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] text-white">
                                    {t('user.admin.disabled')}
                                </span>
                            )}
                            <span className="text-xs t-secondary">
                                {t('user.admin.registered_at', {
                                    date: user.createdAt ? new Date(user.createdAt).toLocaleString() : '',
                                })}
                            </span>
                        </div>

                        <div className="mt-3 grid gap-2 text-xs t-secondary sm:grid-cols-2">
                            <p>
                                <span className="opacity-70">{t('user.admin.invite_code')}: </span>
                                <span className="font-mono">{user.inviteCode || '-'}</span>
                                {user.inviteNote ? ` · ${user.inviteNote}` : ''}
                            </p>
                            <p>
                                <span className="opacity-70">{t('user.admin.signup_note')}: </span>
                                {user.signupNote || '-'}
                            </p>
                            <p>
                                <span className="opacity-70">{t('user.admin.signup_ip')}: </span>
                                <span className="font-mono">{user.signupIp || '-'}</span>
                            </p>
                        </div>

                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                            <input
                                value={noteDraft[user.id] ?? ''}
                                onChange={(e) => setNoteDraft({ ...noteDraft, [user.id]: e.target.value })}
                                placeholder={t('user.admin.note_placeholder')}
                                className="w-full rounded-xl border border-black/10 bg-w px-3 py-2 text-sm t-primary outline-none dark:border-white/10 sm:max-w-sm"
                            />
                            <button
                                onClick={() => void saveNote(user)}
                                disabled={busyId === user.id}
                                className="rounded-full border border-black/10 px-3 py-1.5 text-xs t-primary hover:bg-neutral-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                            >
                                {t('user.admin.save_note')}
                            </button>
                            {!user.permission && (
                                <button
                                    onClick={() => void toggleDisabled(user)}
                                    disabled={busyId === user.id}
                                    className="rounded-full border border-black/10 px-3 py-1.5 text-xs t-primary hover:bg-neutral-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                                >
                                    {user.disabled ? t('user.admin.enable') : t('user.admin.disable')}
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
