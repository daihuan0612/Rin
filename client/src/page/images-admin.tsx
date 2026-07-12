import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import type { StorageImageItem } from "@rin/api";

function ImagePreviewModal({ item, onClose }: { item: StorageImageItem; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copyUrl = () => {
    navigator.clipboard.writeText(item.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-w shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="relative flex items-center justify-between border-b border-black/10 p-4 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium t-primary" title={item.fileName}>{item.fileName}</p>
            <p className="mt-0.5 text-xs t-secondary">
              {new Date(item.uploaded).toLocaleString()} · {formatSize(item.size)}
            </p>
          </div>
          <div className="ml-4 flex items-center gap-2">
            <button
              onClick={copyUrl}
              className="flex items-center gap-1.5 rounded-xl border border-black/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-neutral-100 dark:border-white/10 dark:hover:bg-white/5"
            >
              <i className={`${copied ? "ri-check-line text-green-500" : "ri-file-copy-line"}`} />
              {copied ? t("images.admin.copied") : t("images.admin.copy_url")}
            </button>
            <button onClick={onClose} className="rounded-xl p-1.5 transition-colors hover:bg-neutral-100 dark:hover:bg-white/5">
              <i className="ri-close-line text-lg t-primary" />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-center overflow-auto p-4">
          <img src={item.url} alt={item.fileName} className="max-h-[70vh] max-w-full rounded-xl object-contain" />
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImagesAdminPage() {
  const { t } = useTranslation();
  const [images, setImages] = useState<StorageImageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<StorageImageItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  const loadImages = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.storage.list();
    if (res.error) {
      setError(res.error.value);
    } else if (res.data) {
      setImages(res.data.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  const handleDelete = async (key: string) => {
    if (!confirm(t("images.admin.confirm_delete"))) return;
    setDeleting(key);
    const res = await client.storage.delete(key);
    if (res.error) {
      alert(res.error.value);
    } else {
      setImages(prev => prev.filter(img => img.key !== key));
      setSelected(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
    setDeleting(null);
  };

  const handleBatchDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(t("images.admin.confirm_batch_delete", { count: selected.size }))) return;
    for (const key of selected) {
      const res = await client.storage.delete(key);
      if (res.error) {
        alert(`${t("images.admin.delete_failed")}: ${key} - ${res.error.value}`);
      } else {
        setImages(prev => prev.filter(img => img.key !== key));
      }
    }
    setSelected(new Set());
  };

  const toggleSelect = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === images.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(images.map(img => img.key)));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <ReactLoading type="spin" color="var(--theme)" height={32} width={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <i className="ri-error-warning-line text-4xl text-red-500" />
        <p className="mt-4 text-sm t-secondary">{error}</p>
        <button onClick={loadImages} className="mt-4 rounded-xl bg-theme px-6 py-2 text-sm font-medium text-white transition-colors hover:opacity-80">
          {t("images.admin.retry")}
        </button>
      </div>
    );
  }

  return (
    <div>
      {preview && <ImagePreviewModal item={preview} onClose={() => setPreview(null)} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-neutral-800 px-4 py-2 text-sm text-white shadow-lg dark:bg-neutral-200 dark:text-neutral-800">
          {toast}
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm t-secondary">
          {t("images.admin.total", { count: images.length })}
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={selectAll}
            className="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium t-primary transition-colors hover:bg-neutral-100 dark:border-white/10 dark:hover:bg-white/5"
          >
            {selected.size === images.length ? t("images.admin.deselect_all") : t("images.admin.select_all")}
          </button>
          {selected.size > 0 && (
            <button
              onClick={handleBatchDelete}
              className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
            >
              {t("images.admin.delete_selected", { count: selected.size })}
            </button>
          )}
        </div>
      </div>

      {images.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <i className="ri-image-line text-5xl text-neutral-300 dark:text-neutral-600" />
          <p className="mt-4 text-sm t-secondary">{t("images.admin.no_images")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {images.map(img => (
            <div
              key={img.key}
              className={`group relative overflow-hidden rounded-2xl border ${
                selected.has(img.key)
                  ? "border-theme ring-2 ring-theme/30"
                  : "border-black/10 dark:border-white/10"
              } bg-w`}
            >
              <button
                onClick={() => toggleSelect(img.key)}
                className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
                  selected.has(img.key)
                    ? "border-theme bg-theme text-white"
                    : "border-white/60 bg-black/30 text-transparent hover:border-white"
                }`}
              >
                {selected.has(img.key) && <i className="ri-check-line text-xs" />}
              </button>

              <button onClick={() => setPreview(img)} className="block w-full">
                <div className="aspect-square overflow-hidden bg-neutral-100 dark:bg-neutral-800">
                  <img
                    src={img.url}
                    alt={img.fileName}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    loading="lazy"
                  />
                </div>
              </button>

              <div className="p-3">
                <p className="truncate text-xs font-medium t-primary" title={img.fileName}>
                  {img.fileName}
                </p>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-neutral-400">{formatSize(img.size)}</span>
                    <span className="text-[10px] text-neutral-400">{new Date(img.uploaded).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); setPreview(img); }}
                      className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-white/10"
                      title={t("images.admin.preview")}
                    >
                      <i className="ri-eye-line text-sm" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(img.url).then(() => showToast(t("images.admin.copied")));
                      }}
                      className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-white/10"
                      title={t("images.admin.copy_url")}
                    >
                      <i className="ri-file-copy-line text-sm" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(img.key); }}
                      disabled={deleting === img.key}
                      className="rounded-lg p-1.5 text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
                      title={t("images.admin.delete")}
                    >
                      <i className="ri-delete-bin-line text-sm" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
