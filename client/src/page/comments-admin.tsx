import { SettingsCard, SettingsCardBody, SettingsCardHeader, SettingsBadge } from "@rin/ui";
import { client } from "../app/runtime";
import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { useSiteConfig } from "../hooks/useSiteConfig";
import type { Comment } from "@rin/api";

type CommentStatus = "all" | "pending" | "approved";

function CommentItem({ comment, onApprove, onDelete, onRefresh }: {
  comment: Comment;
  onApprove: (id: number, approved: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const authorName = comment.user?.username || comment.guestName || t("comment.guest");
  const authorEmail = comment.guestEmail || "";
  const authorWebsite = comment.guestWebsite || "";

  const handleApprove = async () => {
    setActionLoading("approve");
    try {
      await onApprove(comment.id, 1);
      onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnapprove = async () => {
    setActionLoading("unapprove");
    try {
      await onApprove(comment.id, 0);
      onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm(t("comment.delete_confirm"))) return;
    setActionLoading("delete");
    try {
      await onDelete(comment.id);
      onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <SettingsCard>
      <SettingsCardHeader
        title={authorName}
        description={
          <div className="flex flex-col gap-1">
            {comment.feed && (
              <a href={`/feed/${comment.feed.id}`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                {comment.feed.title}
              </a>
            )}
            {authorEmail && <span className="text-xs">📧 {authorEmail}</span>}
            {authorWebsite && (
              <a href={authorWebsite} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                🌐 {authorWebsite}
              </a>
            )}
            <span className="text-xs">
              {new Date(comment.createdAt).toLocaleString()}
            </span>
          </div>
        }
        badge={
          comment.approved
            ? <SettingsBadge tone="success">{t("comment.status.approved")}</SettingsBadge>
            : <SettingsBadge tone="warning">{t("comment.status.pending")}</SettingsBadge>
        }
      />
      <SettingsCardBody>
        <div className="whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300 mb-4">
          {comment.content}
        </div>
        <div className="flex gap-2">
          {comment.approved ? (
            <button
              className="px-3 py-1 text-sm rounded-full border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
              onClick={handleUnapprove}
              disabled={actionLoading !== null}
            >
              {actionLoading === "unapprove" ? (
                <ReactLoading width="1em" height="1em" type="spin" color="currentColor" />
              ) : t("comment.action.unapprove")}
            </button>
          ) : (
            <button
              className="px-3 py-1 text-sm rounded-full bg-green-500 text-white hover:bg-green-600"
              onClick={handleApprove}
              disabled={actionLoading !== null}
            >
              {actionLoading === "approve" ? (
                <ReactLoading width="1em" height="1em" type="spin" color="white" />
              ) : t("comment.action.approve")}
            </button>
          )}
          <button
            className="px-3 py-1 text-sm rounded-full bg-red-500 text-white hover:bg-red-600"
            onClick={handleDelete}
            disabled={actionLoading !== null}
          >
            {actionLoading === "delete" ? (
              <ReactLoading width="1em" height="1em" type="spin" color="white" />
            ) : t("comment.action.delete")}
          </button>
        </div>
      </SettingsCardBody>
    </SettingsCard>
  );
}

export function CommentsAdminPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [status, setStatus] = useState<CommentStatus>("all");

  const loadComments = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await client.comment.adminList({ page, pageSize, status });
      if (error) {
        setError(error.value);
        return;
      }
      if (data) {
        setComments(data.list);
        setTotal(data.total);
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadComments();
  }, [page, status]);

  const handleApprove = async (id: number, approved: number) => {
    const { error } = await client.comment.approve(id, approved);
    if (error) throw new Error(error.value);
  };

  const handleDelete = async (id: number) => {
    const { error } = await client.comment.delete(id);
    if (error) throw new Error(error.value);
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="flex w-full flex-col gap-4">
      <Helmet>
        <title>{`${t("comment.admin.title")} - ${siteConfig.name}`}</title>
      </Helmet>

      <div className="grid gap-4 md:grid-cols-3">
        <SettingsCard>
          <SettingsCardHeader title={String(total)} description={t("comment.admin.total")} />
        </SettingsCard>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          className={`px-4 py-2 rounded-full text-sm ${
            status === "all"
              ? "bg-theme text-white"
              : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
          }`}
          onClick={() => { setStatus("all"); setPage(1); }}
        >
          {t("comment.status.all")}
        </button>
        <button
          className={`px-4 py-2 rounded-full text-sm ${
            status === "pending"
              ? "bg-yellow-500 text-white"
              : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
          }`}
          onClick={() => { setStatus("pending"); setPage(1); }}
        >
          {t("comment.status.pending")}
        </button>
        <button
          className={`px-4 py-2 rounded-full text-sm ${
            status === "approved"
              ? "bg-green-500 text-white"
              : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
          }`}
          onClick={() => { setStatus("approved"); setPage(1); }}
        >
          {t("comment.status.approved")}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 py-8 text-sm text-neutral-500 dark:text-neutral-400">
          <ReactLoading width="1.25em" height="1.25em" type="spin" color="#FC466B" />
          <span>{t("comment.admin.loading")}</span>
        </div>
      ) : null}

      {error ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader title={t("comment.admin.load_failed")} description={error} />
        </SettingsCard>
      ) : null}

      {!loading && !error && comments.length === 0 ? (
        <SettingsCard>
          <SettingsCardHeader title={t("comment.admin.empty")} description={t("comment.admin.empty_desc")} />
        </SettingsCard>
      ) : null}

      {!loading && !error && comments.length > 0 ? (
        <div className="space-y-4">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              onApprove={handleApprove}
              onDelete={handleDelete}
              onRefresh={loadComments}
            />
          ))}
        </div>
      ) : null}

      {!loading && !error && totalPages > 1 ? (
        <div className="flex justify-center gap-2">
          <button
            className="px-4 py-2 rounded-full bg-gray-100 dark:bg-gray-700 disabled:opacity-50"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            {t("comment.admin.prev")}
          </button>
          <span className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-400">
            {t("comment.admin.page_info", { page, total: totalPages })}
          </span>
          <button
            className="px-4 py-2 rounded-full bg-gray-100 dark:bg-gray-700 disabled:opacity-50"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            {t("comment.admin.next")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
