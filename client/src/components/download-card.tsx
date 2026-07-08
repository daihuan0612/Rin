import { useState } from "react";
import { useTranslation } from "react-i18next";

interface DownloadCardProps {
  url: string;
  filename?: string;
  password?: string;
}

export function DownloadCard({ url, filename, password }: DownloadCardProps) {
  const { t } = useTranslation();
  const [inputPassword, setInputPassword] = useState("");
  const [unlocked, setUnlocked] = useState(!password);
  const [error, setError] = useState(false);
  const displayName = filename || url.split("/").pop() || t("download.default_filename");

  const handleUnlock = () => {
    if (!password) return;
    try {
      const decoded = atob(password);
      if (inputPassword === decoded) {
        setUnlocked(true);
        setError(false);
      } else {
        setError(true);
      }
    } catch (_e) {
      setError(true);
    }
  };

  const handleDownload = () => {
    if (!unlocked) return;
    const link = document.createElement("a");
    link.href = url;
    if (filename) {
      link.download = filename;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="my-4 rounded-xl border border-black/10 dark:border-white/10 bg-w overflow-hidden">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4">
        <div className="w-12 h-12 rounded-xl bg-theme/10 flex items-center justify-center flex-shrink-0">
          <i className="ri-download-2-line text-xl text-theme" />
        </div>
        <div className="flex-grow min-w-0">
          <div className="font-medium t-primary truncate">{displayName}</div>
        </div>
        {unlocked ? (
          <button
            onClick={handleDownload}
            className="bg-theme text-white rounded-full px-5 py-2 h-min text-sm font-medium hover:bg-theme-hover active:bg-theme-active transition-colors flex-shrink-0 w-full sm:w-auto"
          >
            <span className="flex flex-row items-center justify-center gap-1.5">
              <i className="ri-download-line" />
              {t("download.button")}
            </span>
          </button>
        ) : (
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <input
              type="password"
              value={inputPassword}
              onChange={(e) => {
                setInputPassword(e.target.value);
                setError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleUnlock();
                }
              }}
              placeholder={t("download.password_placeholder")}
              className={`px-3 py-2 rounded-full border text-sm bg-transparent t-primary focus:outline-none focus:ring-2 focus:ring-theme flex-grow sm:w-40 ${
                error ? "border-red-400" : "border-black/10 dark:border-white/10"
              }`}
            />
            <button
              onClick={handleUnlock}
              className="bg-theme text-white rounded-full px-5 py-2 h-min text-sm font-medium hover:bg-theme-hover active:bg-theme-active transition-colors flex-shrink-0"
            >
              {t("download.unlock")}
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="px-4 pb-3 text-sm text-red-500">
          {t("download.password_error")}
        </div>
      )}
    </div>
  );
}
