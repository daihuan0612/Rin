import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { editor, Range, Selection } from 'monaco-editor';
import React, { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Loading from 'react-loading';
import Modal from "react-modal";
import { FlatInset, FlatTabButton } from "@rin/ui";
import { Button } from "./button";
import { useAlert } from "./dialog";
import { useColorMode } from "../utils/darkModeUtils";
import { buildMarkdownImage, uploadImageFile } from "../utils/image-upload";
import { unwrapHiddenMarkers } from "../utils/glass-markers";
import { parseVideoUrl } from "../utils/video-embed";
import { Markdown } from "./markdown";

// 用本地已安装的 monaco-editor，不让 @monaco-editor/react 去 cdn.jsdelivr.net 下载。
// 原来那套默认行为在连不上 jsdelivr 的网络里会让编辑区永远停在 "Loading..."（本机就是这样），
// 而这个文件本来就 `import ... from 'monaco-editor'`，整包早就在 bundle 里了 —— 换成本地这份不增加体积。
loader.config({ monaco });


interface MarkdownEditorProps {
  content: string;
  setContent: (content: string) => void;
  placeholder?: string;
  height?: string;
}

type EditorPosition = {
  lineNumber: number;
  column: number;
};

function positionAfterText(startLineNumber: number, startColumn: number, text: string): EditorPosition {
  const lines = text.split("\n");

  if (lines.length === 1) {
    return {
      lineNumber: startLineNumber,
      column: startColumn + text.length,
    };
  }

  return {
    lineNumber: startLineNumber + lines.length - 1,
    column: lines[lines.length - 1].length + 1,
  };
}

function MarkdownToolButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-transparent text-lg t-secondary transition-colors hover:border-black/10 hover:bg-neutral-100 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-white/10 dark:hover:bg-neutral-700 dark:hover:text-white sm:h-10 sm:w-10"
    >
      <i className={icon} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * 两种隐藏段在**预览窗**里都显示成正常文字（作者视角，正文零提示）。
 * 编辑区（Monaco）仍然显示 `[glass]` / `[owner]` 标记 —— 那就是"这一段我打过码"的提示。
 * 真正的打码在服务端做（server/src/utils/glass.ts），这里只管预览好看。
 */
function renderGlassPreview(text: string): string {
  return text
    .replace(/\[glass\]([\s\S]*?)\[\/glass\]/g, '<span class="glass self">$1</span>')
    .replace(/\[owner\]([\s\S]*?)\[\/owner\]/g, '<span class="owner self">$1</span>');
}

export function MarkdownEditor({ content, setContent, placeholder = "> Write your content here...", height = "400px" }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const colorMode = useColorMode();
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const isComposingRef = useRef(false);
  const [preview, setPreview] = useState<'edit' | 'preview' | 'comparison'>('edit');
  const [uploading, setUploading] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFilename, setDownloadFilename] = useState("");
  const [downloadPassword, setDownloadPassword] = useState("");
  const { showAlert, AlertUI } = useAlert();

  async function insertImage(
    file: File,
    range: NonNullable<ReturnType<editor.IStandaloneCodeEditor["getSelection"]>>,
    showAlert: (msg: string) => void,
  ) {
    try {
      const result = await uploadImageFile(file);
      const editorInstance = editorRef.current;
      if (!editorInstance) return;
      editorInstance.executeEdits(undefined, [{
        range,
        text: buildMarkdownImage(file.name, result.url, {
          blurhash: result.blurhash,
          width: result.width,
          height: result.height,
        }),
      }]);
    } catch (error) {
      console.error(error);
      showAlert(error instanceof Error ? error.message : t("upload.failed"));
    }
  }

  const getEditorAndSelection = () => {
    const editorInstance = editorRef.current;
    const model = editorInstance?.getModel();
    const selection = editorInstance?.getSelection();

    if (!editorInstance || !model || !selection) {
      return null;
    }

    return { editorInstance, model, selection };
  };

  const replaceSelection = (selection: Selection, text: string, nextSelection?: Selection) => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    editorInstance.executeEdits("markdown-toolbar", [{
      range: selection,
      text,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());

    if (nextSelection) {
      editorInstance.setSelection(nextSelection);
    } else {
      const position = positionAfterText(selection.startLineNumber, selection.startColumn, text);
      editorInstance.setPosition(position);
    }

    editorInstance.focus();
  };

  const wrapSelection = (prefix: string, suffix: string, fallback: string) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const innerText = selectedText || fallback;
    const insertedText = `${prefix}${innerText}${suffix}`;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, innerText);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const nextSelection = selectedText
      ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column)
      : new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, nextSelection);
  };

  /**
   * 取消打码：把 `[glass]…[/glass]` / `[owner]…[/owner]` 的标记去掉、文字留着。
   *
   * 不用先精确选中整段：
   * - 光标停在隐藏段里 ⇒ 这一段的标记直接去掉；
   * - 选中了段里的一部分 ⇒ 也整段取消（免得剩半截标记）；
   * - 选中范围内有配对不上的孤立标记 ⇒ 一并清掉。
   * 整篇替换（而不是拼接多处小编辑）是为了让 Ctrl+Z 一步就能撤回。
   */
  const unwrapHidden = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { editorInstance, model, selection } = editorState;
    const startOffset = model.getOffsetAt(selection.getStartPosition());
    const endOffset = model.getOffsetAt(selection.getEndPosition());
    const result = unwrapHiddenMarkers(model.getValue(), startOffset, endOffset);

    if (!result) {
      showAlert(t("markdown_editor.toolbar.glass_off_empty"));
      return;
    }

    editorInstance.pushUndoStop();
    editorInstance.executeEdits("markdown-toolbar", [{
      range: model.getFullModelRange(),
      text: result.text,
      forceMoveMarkers: true,
    }]);
    editorInstance.pushUndoStop();
    setContent(result.text);

    const nextStart = model.getPositionAt(result.start);
    const nextEnd = model.getPositionAt(result.end);
    editorInstance.setSelection(new Selection(nextStart.lineNumber, nextStart.column, nextEnd.lineNumber, nextEnd.column));
    editorInstance.focus();
  };

  const insertLink = () => {    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const label = selectedText || t("markdown_editor.placeholder.link_text");
    const url = t("markdown_editor.placeholder.link_url");
    const prefix = `[${label}](`;
    const insertedText = `${prefix}${url})`;
    const urlStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const urlEnd = positionAfterText(urlStart.lineNumber, urlStart.column, url);

    replaceSelection(selection, insertedText, new Selection(urlStart.lineNumber, urlStart.column, urlEnd.lineNumber, urlEnd.column));
  };

  const insertMarkdownImage = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const alt = selectedText || t("markdown_editor.placeholder.image_alt");
    const url = t("markdown_editor.placeholder.image_url");
    const prefix = `![${alt}](`;
    const insertedText = `${prefix}${url})`;
    const urlStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const urlEnd = positionAfterText(urlStart.lineNumber, urlStart.column, url);

    replaceSelection(selection, insertedText, new Selection(urlStart.lineNumber, urlStart.column, urlEnd.lineNumber, urlEnd.column));
  };

  const insertCodeBlock = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const innerText = selectedText || t("markdown_editor.placeholder.code_block");
    const prefix = "```\n";
    const insertedText = `${prefix}${innerText}\n\`\`\``;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, innerText);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const nextSelection = selectedText
      ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column)
      : new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, nextSelection);
  };

  const insertHorizontalRule = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    replaceSelection(editorState.selection, "\n---\n");
  };

  const openVideoDialog = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;
    setVideoUrl("");
    setVideoModalOpen(true);
  };

  const handleInsertVideo = () => {
    const parsed = parseVideoUrl(videoUrl);
    if (!parsed) {
      showAlert(t("markdown_editor.video.invalid_url"));
      return;
    }
    const editorState = getEditorAndSelection();
    if (!editorState) {
      setVideoModalOpen(false);
      return;
    }
    const textToInsert = `\n${parsed.embedHtml}\n`;
    replaceSelection(editorState.selection, textToInsert);
    setVideoModalOpen(false);
    setVideoUrl("");
  };

  const openDownloadDialog = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;
    setDownloadUrl("");
    setDownloadFilename("");
    setDownloadPassword("");
    setDownloadModalOpen(true);
  };

  const handleInsertDownload = () => {
    if (!downloadUrl.trim()) {
      showAlert(t("markdown_editor.download.url_required"));
      return;
    }
    const editorState = getEditorAndSelection();
    if (!editorState) {
      setDownloadModalOpen(false);
      return;
    }
    const dataAttrs = [`class="rin-download-card"`, `data-url="${downloadUrl.trim()}"`];
    if (downloadFilename.trim()) {
      dataAttrs.push(`data-filename="${downloadFilename.trim()}"`);
    }
    if (downloadPassword.trim()) {
      const encodedPassword = btoa(downloadPassword.trim());
      dataAttrs.push(`data-password="${encodedPassword}"`);
    }
    const html = `<div ${dataAttrs.join(" ")}></div>`;
    const textToInsert = `\n${html}\n`;
    replaceSelection(editorState.selection, textToInsert);
    setDownloadModalOpen(false);
    setDownloadUrl("");
    setDownloadFilename("");
    setDownloadPassword("");
  };

  const formatSelectedLines = (
    formatter: (line: string, index: number) => string,
    emptyLineFallback: string,
  ) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { editorInstance, model, selection } = editorState;
    const startLineNumber = selection.startLineNumber;
    const endLineNumber = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
    const currentLine = model.getLineContent(startLineNumber);
    const isEmptySingleLine = selection.isEmpty() && currentLine.trim().length === 0;
    const lines = isEmptySingleLine
      ? [emptyLineFallback]
      : Array.from({ length: endLineNumber - startLineNumber + 1 }, (_, index) => {
        const lineNumber = startLineNumber + index;
        return formatter(model.getLineContent(lineNumber), index);
      });
    const targetEndLine = isEmptySingleLine ? startLineNumber : endLineNumber;
    const range = new Range(
      startLineNumber,
      1,
      targetEndLine,
      model.getLineMaxColumn(targetEndLine),
    );
    const insertedText = lines.join("\n");
    const end = positionAfterText(startLineNumber, 1, insertedText);

    editorInstance.executeEdits("markdown-toolbar", [{
      range,
      text: insertedText,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());
    editorInstance.setPosition(end);
    editorInstance.focus();
  };

  const formatHeading = () => {
    formatSelectedLines(
      (line) => line.startsWith("#") ? `## ${line.replace(/^#+\s*/, "")}` : `## ${line}`,
      `## ${t("markdown_editor.placeholder.heading")}`,
    );
  };

  const formatIndent = () => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    const selection = editorInstance.getSelection();
    if (!selection) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const lineContent = model.getLineContent(selection.startLineNumber);
    const indent = "\u3000\u3000";
    if (lineContent.startsWith(indent)) {
      replaceSelection(
        new Selection(selection.startLineNumber, 1, selection.startLineNumber, 3),
        "",
      );
    } else {
      const pos = { lineNumber: selection.startLineNumber, column: 1 };
      replaceSelection(
        new Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        indent,
      );
    }
  };

  const formatNovel = () => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const fullText = model.getValue();
    // Strip invisible Unicode characters (zero-width spaces, etc.)
    const cleaned = fullText.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u200E\u200F\u2028\u2029]/g, "");
    const lines = cleaned.split("\n");
    const indent = "\u3000\u3000";

    // Special chapter titles (no "第" prefix)
    const specialTitles = [
      '楔子', '序章', '序言', '前言', '引子', '引言',
      '尾声', '后记', '番外', '结局', '终章', '尾声',
      '第一章', '第二章', '第三章', '第四章', '第五章',
      '第六章', '第七章', '第八章', '第九章', '第十章',
    ];

    // Chapter number patterns: Chinese numerals + Arabic numerals
    const numPattern = '[零一二三四五六七八九十百千万亿\\d]+';

    // Chapter type suffixes
    const chapterTypes = ['章', '回', '节', '卷', '部', '集', '话', '篇', '册'];

    // Build regex for "第X章/回/节/..." pattern
    const chapterPattern = new RegExp(
      `^[\\s【\\[（(《]*第${numPattern}[${chapterTypes.join('')}]\\s*[】\\]）)》]?`,
      'i'
    );

    // Build regex for volume/part pattern (卷X, 第X卷)
    const volumePattern = new RegExp(
      `^[\\s【\\[（(《]*(第${numPattern}卷|[上中下]部|第${numPattern}部)\\s*[】\\]）)》]?`,
      'i'
    );

    // Special title pattern: standalone special titles (with optional brackets)
    const specialTitlePattern = new RegExp(
      `^[\\s【\\[（(《]*(${specialTitles.join('|')})\\s*[】\\]）)》]?$`,
      'i'
    );

    function isChapterTitle(line: string): boolean {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Strip markdown heading markers first
      const cleanLine = trimmed.replace(/^#+\s*/, '');
      if (chapterPattern.test(cleanLine)) return true;
      if (volumePattern.test(cleanLine)) return true;
      if (specialTitlePattern.test(cleanLine)) return true;
      return false;
    }

    function cleanTitle(line: string): string {
      let trimmed = line.trim();
      // Strip markdown heading markers
      trimmed = trimmed.replace(/^#+\s*/, '');
      // Strip surrounding brackets/书名号
      trimmed = trimmed.replace(/^[【\[（(《]+/, '').replace(/[】\]）)》]+$/, '');
      return trimmed.trim();
    }

    const result = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Fix headings without space after # (e.g. #第一集 -> # 第一集)
      const fixedLine = line.replace(/^(#+)(\S)/, "$1 $2");

      if (isChapterTitle(fixedLine)) {
        const title = cleanTitle(fixedLine);
        return `## ${title}`;
      }

      // Skip lines that already have special formatting
      if (
        fixedLine.startsWith(indent) ||
        fixedLine.startsWith("#") ||
        fixedLine.startsWith(">") ||
        fixedLine.startsWith("```") ||
        fixedLine.startsWith("- ") ||
        fixedLine.startsWith("* ") ||
        fixedLine.match(/^\d+\.\s/)
      ) {
        return fixedLine;
      }

      return indent + fixedLine;
    });

    const newText = result.join("\n");
    model.setValue(newText);
    setContent(newText);
  };

  const formatQuote = () => {
    formatSelectedLines(
      (line) => line.startsWith("> ") ? line : `> ${line}`,
      `> ${t("markdown_editor.placeholder.quote")}`,
    );
  };

  const formatUnorderedList = () => {
    formatSelectedLines(
      (line) => line.match(/^\s*[-*]\s/) ? line : `- ${line}`,
      `- ${t("markdown_editor.placeholder.list_item")}`,
    );
  };

  const formatOrderedList = () => {
    formatSelectedLines(
      (line, index) => line.match(/^\s*\d+\.\s/) ? line : `${index + 1}. ${line}`,
      `1. ${t("markdown_editor.placeholder.list_item")}`,
    );
  };

  /**
   * 图片打码：把图片包进 `[glass]` 段 —— 跟文字打码是同一个机制，这里只是替你把位置找准。
   * 不用精确拖选（拖漏一个感叹号或右括号，图片就变回一段文字了）：
   * - 选区本身就是一行完整图片 ⇒ 直接包；
   * - 光标停在图片那一行 ⇒ 自动选中整行再包；
   * - 其它情况 ⇒ 提示先选中图片，免得把标记插到随便什么地方。
   */
  const maskImage = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { editorInstance, model, selection } = editorState;
    const IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/;

    const selectedText = model.getValueInRange(selection).trim();
    if (IMAGE_LINE_RE.test(selectedText)) {
      if (/\[(glass|owner)\]/.test(selectedText)) {
        showAlert(t("markdown_editor.toolbar.image_glass_already"));
        return;
      }
      wrapSelection("[glass]", "[/glass]", "");
      return;
    }

    const lineNumber = selection.startLineNumber;
    const lineContent = model.getLineContent(lineNumber);
    if (IMAGE_LINE_RE.test(lineContent)) {
      if (/\[(glass|owner)\]/.test(lineContent)) {
        showAlert(t("markdown_editor.toolbar.image_glass_already"));
        return;
      }
      editorInstance.setSelection(
        new Selection(lineNumber, 1, lineNumber, lineContent.length + 1),
      );
      wrapSelection("[glass]", "[/glass]", "");
      return;
    }

    showAlert(t("markdown_editor.toolbar.image_glass_empty"));
  };

  const markdownActions = [
    { key: "heading", icon: "ri-heading", label: t("markdown_editor.toolbar.heading"), onClick: formatHeading },
    { key: "indent", icon: "ri-indent-increase", label: t("markdown_editor.toolbar.indent"), onClick: formatIndent },
    { key: "novel", icon: "ri-book-2-line", label: t("markdown_editor.toolbar.novel"), onClick: formatNovel },
    { key: "bold", icon: "ri-bold", label: t("markdown_editor.toolbar.bold"), onClick: () => wrapSelection("**", "**", t("markdown_editor.placeholder.bold")) },
    { key: "italic", icon: "ri-italic", label: t("markdown_editor.toolbar.italic"), onClick: () => wrapSelection("*", "*", t("markdown_editor.placeholder.italic")) },
    { key: "center", icon: "ri-align-center", label: t("markdown_editor.toolbar.center"), onClick: () => wrapSelection("<center>", "</center>", t("markdown_editor.placeholder.center")) },
    { key: "glass", icon: "ri-eye-off-line", label: t("markdown_editor.toolbar.glass"), onClick: () => wrapSelection("[glass]", "[/glass]", t("markdown_editor.placeholder.glass")) },
    { key: "owner", icon: "ri-lock-line", label: t("markdown_editor.toolbar.owner"), onClick: () => wrapSelection("[owner]", "[/owner]", t("markdown_editor.placeholder.owner")) },
    { key: "glass-off", icon: "ri-eye-line", label: t("markdown_editor.toolbar.glass_off"), onClick: unwrapHidden },
    { key: "link", icon: "ri-link", label: t("markdown_editor.toolbar.link"), onClick: insertLink },
    { key: "image", icon: "ri-image-line", label: t("markdown_editor.toolbar.image"), onClick: insertMarkdownImage },
    { key: "image-glass", icon: "ri-image-circle-line", label: t("markdown_editor.toolbar.image_glass"), onClick: maskImage },
    { key: "video", icon: "ri-video-line", label: t("markdown_editor.toolbar.insert_video"), onClick: openVideoDialog },
    { key: "download", icon: "ri-download-line", label: t("markdown_editor.toolbar.insert_download"), onClick: openDownloadDialog },
    { key: "quote", icon: "ri-double-quotes-l", label: t("markdown_editor.toolbar.quote"), onClick: formatQuote },
    { key: "unordered-list", icon: "ri-list-unordered", label: t("markdown_editor.toolbar.unordered_list"), onClick: formatUnorderedList },
    { key: "ordered-list", icon: "ri-list-ordered", label: t("markdown_editor.toolbar.ordered_list"), onClick: formatOrderedList },
    { key: "inline-code", icon: "ri-code-s-slash-line", label: t("markdown_editor.toolbar.inline_code"), onClick: () => wrapSelection("`", "`", t("markdown_editor.placeholder.code")) },
    { key: "code-block", icon: "ri-code-box-line", label: t("markdown_editor.toolbar.code_block"), onClick: insertCodeBlock },
    { key: "horizontal-rule", icon: "ri-separator", label: t("markdown_editor.toolbar.horizontal_rule"), onClick: insertHorizontalRule },
  ];

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const clipboardData = event.clipboardData;
    if (clipboardData.files.length === 1) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.trigger(undefined, "undo", undefined);
      setUploading(true);
      const myfile = clipboardData.files[0] as File;
      const selection = editor.getSelection();
      if (!selection) {
        setUploading(false);
        return;
      }
      void insertImage(myfile, selection, showAlert).finally(() => {
        setUploading(false);
      });
    }
  };

  function UploadImageButton() {
    const uploadRef = useRef<HTMLInputElement>(null);
    const label = t("markdown_editor.toolbar.upload_image");
    
    const upChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.currentTarget.files;
      if (!files) return;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size > 5 * 1024000) {
          showAlert(t("upload.failed$size", { size: 5 }));
          uploadRef.current!.value = "";
        } else {
          const editor = editorRef.current;
          if (!editor) return;
          const selection = editor.getSelection();
          if (!selection) return;
          setUploading(true);
          void insertImage(file, selection, showAlert).finally(() => {
            setUploading(false);
          });
        }
      }
    };
    
    return (
      <>
        <input
          ref={uploadRef}
          onChange={upChange}
          className="hidden"
          type="file"
          accept="image/gif,image/jpeg,image/jpg,image/png"
        />
        <MarkdownToolButton
          label={label}
          icon="ri-image-add-line"
          disabled={uploading}
          onClick={() => uploadRef.current?.click()}
        />
      </>
    );
  }

  /* ---------------- 隐藏段提示（`[glass]` / `[owner]`） ----------------
   * 只有这一件事：把编辑器里每一段标记整段框起来，划到那儿一眼就知道"这段我打过码"。
   * `[glass]`（登录读者可见）用蓝灰框，`[owner]`（只有我能看）用紫灰框，两种一眼分开。
   * （正文页面里作者看到的是纯原文，没有任何提示。）
   */
  const glassDecorationIds = useRef<string[]>([]);

  const syncGlassDecorations = () => {
    const instance = editorRef.current;
    const model = instance?.getModel();
    if (!instance || !model) return;

    const text = model.getValue();
    const decorations: editor.IModelDeltaDecoration[] = [];
    const re = /\[(glass|owner)\][\s\S]*?\[\/\1\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = model.getPositionAt(match.index);
      const end = model.getPositionAt(match.index + match[0].length);
      const isOwner = match[1] === "owner";
      decorations.push({
        range: new Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          inlineClassName: isOwner ? "owner-marker" : "glass-marker",
          hoverMessage: {
            value: t(isOwner ? "markdown_editor.toolbar.owner_jump" : "markdown_editor.toolbar.glass_jump"),
          },
        },
      });
    }
    glassDecorationIds.current = instance.deltaDecorations(glassDecorationIds.current, decorations);
  };

  /* ---------------- Monaco Mount & IME Optimization ---------------- */

  const handleEditorMount = (editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;

    editor.onDidCompositionStart(() => {
      isComposingRef.current = true;
    });

    editor.onDidCompositionEnd(() => {
      isComposingRef.current = false;
      setContent(editor.getValue());
    });

    editor.onDidChangeModelContent(() => {
      if (!isComposingRef.current) {
        setContent(editor.getValue());
      }
    });

    editor.onDidBlurEditorText(() => {
      setContent(editor.getValue());
    });

    // 挂载时内容来自 defaultValue，content 不会变 ⇒ 这里补一次，把已有隐藏段先高亮出来
    syncGlassDecorations();
  };

  /* ---------------- synchronization ---------------- */

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const editorValue = model.getValue();

    // Avoid infinite loops & prevent overwriting content being edited
    if (editorValue !== content) {
      editor.setValue(content);
    }

    // 必须在 setValue 之后重打一遍：setValue 会清空全部装饰（两段隐藏段的框就没了）。
    // 别拆成两个 effect —— 那样装饰先打、随后被 setValue 抹掉，表现就是"框有时在有时不在"。
    syncGlassDecorations();
  }, [content]);

  /* ---------------- UI ---------------- */

  return (
    <div className="flex flex-col gap-0 sm:gap-3">
      <FlatInset className="flex flex-wrap items-center gap-2 border-0 border-b border-black/10 rounded-none bg-transparent p-2 dark:border-white/10 sm:p-3">
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <FlatTabButton active={preview === 'edit'} onClick={() => setPreview('edit')}> {t("edit")} </FlatTabButton>
          <FlatTabButton active={preview === 'preview'} onClick={() => setPreview('preview')}> {t("preview")} </FlatTabButton>
          <FlatTabButton active={preview === 'comparison'} onClick={() => setPreview('comparison')}> {t("comparison")} </FlatTabButton>
        </div>
        <div className="flex-grow" />
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="toolbar"
          aria-label={t("markdown_editor.toolbar.label")}
        >
          {markdownActions.map((action) => (
            <MarkdownToolButton
              key={action.key}
              label={action.label}
              icon={action.icon}
              onClick={action.onClick}
            />
          ))}
          <span className="mx-1 hidden h-6 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden="true" />
          <UploadImageButton />
        </div>
        {uploading &&
          <div className="flex flex-row items-center space-x-2 px-2">
            <Loading type="spin" color="#FC466B" height={16} width={16} />
            <span className="text-sm text-neutral-500">{t('uploading')}</span>
          </div>
        }
      </FlatInset>
      <div className={`grid grid-cols-1 gap-0 sm:gap-4 ${preview === 'comparison' ? "lg:grid-cols-2" : ""}`}>
        <div className={"flex min-w-0 flex-col " + (preview === 'preview' ? "hidden" : "")}>
          <div
            className={"relative min-h-0 overflow-hidden rounded-none border-0 bg-w"}
            onDrop={(e) => {
              e.preventDefault();
              const editor = editorRef.current;
              if (!editor) return;
              for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const selection = editor.getSelection();
                if (!selection) return;
                const file = e.dataTransfer.files[i];
                setUploading(true);
                void insertImage(file, selection, showAlert).finally(() => {
                  setUploading(false);
                });
              }
            }}
            onPaste={handlePaste}
          >
            <Editor
              onMount={handleEditorMount}
              height={height}
              defaultLanguage="markdown"
              defaultValue={content}
              theme={colorMode === "dark" ? "vs-dark" : "light"}
              options={{
                wordWrap: "on",

                // Chinese IME stability key
                fontFamily: "Sarasa Mono SC, JetBrains Mono, monospace",
                fontLigatures: false,
                letterSpacing: 0,

                fontSize: 14,
                lineNumbers: "off",
                // 右上角的代码缩略图在这么窄的编辑区里只会挡字，关掉
                minimap: { enabled: false },

                accessibilitySupport: "off",
                unicodeHighlight: { ambiguousCharacters: false },

                renderWhitespace: "none",
                renderControlCharacters: false,
                smoothScrolling: false,

                dragAndDrop: true,
                pasteAs: { enabled: false },
              }}
            />
          </div>
        </div>
        <div
          className={"min-h-0 overflow-y-auto rounded-none border-0 bg-w px-4 py-4 border-t sm:border-none " + (preview === 'edit' ? "hidden" : "")}
          style={{ height: height }}
        >
          <Markdown content={content ? renderGlassPreview(content) : placeholder} />
        </div>
      </div>
      <AlertUI />
      <Modal
        isOpen={videoModalOpen}
        shouldCloseOnOverlayClick={true}
        shouldCloseOnEsc={true}
        onRequestClose={() => setVideoModalOpen(false)}
        style={{
          content: {
            top: '50%',
            left: '50%',
            right: 'auto',
            bottom: 'auto',
            marginRight: '-50%',
            transform: 'translate(-50%, -50%)',
            padding: '0',
            border: 'none',
            borderRadius: '16px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            background: 'transparent',
            maxWidth: '40em',
            width: '90%',
          },
          overlay: {
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
          },
        }}
      >
        <div className="flex flex-col items-start p-4 bg-w space-y-4 w-full min-w-56 sm:min-w-96">
          <h1 className="text-2xl font-bold t-primary">
            {t("markdown_editor.video.title")}
          </h1>
          <p className="text-sm text-neutral-500">
            {t("markdown_editor.video.description")}
          </p>
          <input
            type="text"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder={t("markdown_editor.video.placeholder")}
            className="w-full px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-transparent t-primary focus:outline-none focus:ring-2 focus:ring-theme"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleInsertVideo();
              }
            }}
          />
          <div className="w-full flex flex-row items-center justify-end space-x-2 mt-2">
            <Button secondary onClick={() => setVideoModalOpen(false)} title={t('cancel')} />
            <Button onClick={handleInsertVideo} title={t('confirm')} />
          </div>
        </div>
      </Modal>
      <Modal
        isOpen={downloadModalOpen}
        shouldCloseOnOverlayClick={true}
        shouldCloseOnEsc={true}
        onRequestClose={() => setDownloadModalOpen(false)}
        style={{
          content: {
            top: '50%',
            left: '50%',
            right: 'auto',
            bottom: 'auto',
            marginRight: '-50%',
            transform: 'translate(-50%, -50%)',
            padding: '0',
            border: 'none',
            borderRadius: '16px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            background: 'transparent',
            maxWidth: '40em',
            width: '90%',
          },
          overlay: {
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
          },
        }}
      >
        <div className="flex flex-col items-start p-4 bg-w space-y-3 w-full min-w-56 sm:min-w-96">
          <h1 className="text-2xl font-bold t-primary">
            {t("markdown_editor.download.title")}
          </h1>
          <p className="text-sm text-neutral-500">
            {t("markdown_editor.download.description")}
          </p>
          <div className="w-full space-y-2">
            <label className="text-sm font-medium t-primary">
              {t("markdown_editor.download.url_label")}
            </label>
            <input
              type="text"
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder={t("markdown_editor.download.url_placeholder")}
              className="w-full px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-transparent t-primary focus:outline-none focus:ring-2 focus:ring-theme"
            />
          </div>
          <div className="w-full space-y-2">
            <label className="text-sm font-medium t-primary">
              {t("markdown_editor.download.filename_label")}
              <span className="text-neutral-400 font-normal ml-1">({t("optional")})</span>
            </label>
            <input
              type="text"
              value={downloadFilename}
              onChange={(e) => setDownloadFilename(e.target.value)}
              placeholder={t("markdown_editor.download.filename_placeholder")}
              className="w-full px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-transparent t-primary focus:outline-none focus:ring-2 focus:ring-theme"
            />
          </div>
          <div className="w-full space-y-2">
            <label className="text-sm font-medium t-primary">
              {t("markdown_editor.download.password_label")}
              <span className="text-neutral-400 font-normal ml-1">({t("optional")})</span>
            </label>
            <input
              type="text"
              value={downloadPassword}
              onChange={(e) => setDownloadPassword(e.target.value)}
              placeholder={t("markdown_editor.download.password_placeholder")}
              className="w-full px-3 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-transparent t-primary focus:outline-none focus:ring-2 focus:ring-theme"
            />
          </div>
          <div className="w-full flex flex-row items-center justify-end space-x-2 mt-2">
            <Button secondary onClick={() => setDownloadModalOpen(false)} title={t('cancel')} />
            <Button onClick={handleInsertDownload} title={t('confirm')} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
