import i18n from "i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { listenSystemMode } from "../utils/darkModeUtils";

let bootstrapped = false;

export function bootstrapApp() {
  if (bootstrapped) {
    return;
  }

  listenSystemMode();

  i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      backend: {
        loadPath: "/locales/{{lng}}/{{ns}}.json",
      },
      // 本站只有简体中文和英文（client/public/locales 里只留这两个）
      supportedLngs: ["zh-CN", "en"],
      // 只按完整语言码加载：否则 i18next 会把 zh-CN 简化成 zh 去找 /locales/zh/（不存在），
      // 中文界面会整片塌成翻译 key
      load: "currentOnly",
      // 浏览器是 zh / zh-TW / zh-HK 时都落到中文，不要掉到英文去
      fallbackLng: "zh-CN",
      interpolation: {
        escapeValue: false,
      },
    });

  bootstrapped = true;
}
