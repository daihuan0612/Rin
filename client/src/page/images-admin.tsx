import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import type { StorageImageItem } from "@rin/api";

export function ImagesAdminPage() {
  const { t } = useTranslation();
  const [images, setImages] = useState<StorageImageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {images.map(img => (
            <div
              key={img.key}
              className={`group relative overflow-hidden rounded-2xl border ${
                selected.has(img.key)
                  ? "border-theme ring-2 ring-theme/30"
                  : "border-black/10 dark:border-white/10"
              } bg-neutral-50 dark:bg-neutral-900`}
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

              <a href={img.url} target="_blank" rel="noreferrer" className="block">
                <div className="aspect-square overflow-hidden">
                  <img
                    src={img.url}
                    alt={img.fileName}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    loading="lazy"
                  />
                </div>
              </a>

              <div className="p-2.5">
                <p className="truncate text-xs font-medium t-primary" title={img.fileName}>
                  {img.fileName}
                </p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[11px] text-neutral-400">{formatSize(img.size)}</span>
                  <button
                    onClick={() => handleDelete(img.key)}
                    disabled={deleting === img.key}
                    className="text-[11px] text-red-500 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100 disabled:opacity-50"
                  >
                    {deleting === img.key ? "..." : t("images.admin.delete")}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
