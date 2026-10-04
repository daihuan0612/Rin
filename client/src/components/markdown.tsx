import "katex/dist/katex.min.css";
import React, { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";

function VideoPlayer({ children, ...props }: any) {
  const [played, setPlayed] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  return (
    <div className="my-4 w-full overflow-hidden rounded-xl flex justify-center bg-black/5 relative cursor-pointer" onClick={() => {
      if (played) return;
      const video = videoRef.current;
      if (video) {
        setPlayed(true);
        video.muted = false;
        video.play().catch(() => {});
      }
    }}>
      {poster && !played && (
        <img src={poster} alt="" className="absolute inset-0 w-full h-full object-contain rounded-xl pointer-events-none" />
      )}
      <video
        {...props}
        ref={videoRef}
        className="max-h-[70vh] w-auto h-auto block"
        controls
        preload="metadata"
        playsInline
        muted={!ready && !played}
        onPlay={() => setPlayed(true)}
        onLoadedMetadata={() => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && video.videoWidth > 0 && video.videoHeight > 0) {
            video.currentTime = 0.1;
          }
        }}
        onSeeked={() => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && !poster) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              setPoster(canvas.toDataURL('image/jpeg', 0.85));
              video.currentTime = 0;
              video.muted = false;
              setReady(true);
            }
          }
        }}
      >
        {children}
      </video>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
import {
  base16AteliersulphurpoolLight,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import gfm from "remark-gfm";
import remarkMermaid from "../remark/remarkMermaid";
import { remarkAlert } from "remark-github-blockquote-alert";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import Lightbox, { SlideImage } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Download from "yet-another-react-lightbox/plugins/download";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { drawBlurhashToCanvas } from "../utils/blurhash";
import { useColorMode } from "../utils/darkModeUtils";
import { parseImageUrlMetadata } from "../utils/image-upload";
import { useImageLoadState } from "../utils/use-image-load-state";
import { DownloadCard } from "./download-card";


const countNewlinesBeforeNode = (text: string, offset: number) => {
  let newlinesBefore = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "\n") {
      newlinesBefore++;
    } else {
      break;
    }
  }
  return newlinesBefore;
};

const isMarkdownImageLinkAtEnd = (text: string) => {
  const trimmed = text.trim();

  const match = trimmed.match(/(.*)(!\\[.*?\\]\\(.*?\\))$/s);

  if (match) {
    const [, beforeImage, _] = match;

    return beforeImage.trim().length === 0 || beforeImage.endsWith("\n");
  }

  return false;
};

function MarkdownImage({
  src,
  alt,
  show,
  rounded,
  scale,
  className,
}: {
  src?: string;
  alt?: string;
  show: (src?: string) => void;
  rounded: boolean;
  scale: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { src: cleanSrc, blurhash, width, height } = parseImageUrlMetadata(src);
  const { failed, imageRef, loaded, onError, onLoad } = useImageLoadState(cleanSrc);
  const roundedClass = rounded ? "rounded-xl" : "";
  const aspectRatio = width && height ? `${width} / ${height}` : undefined;

  useEffect(() => {
    if (!blurhash || !canvasRef.current) {
      return;
    }
    try {
      drawBlurhashToCanvas(canvasRef.current, blurhash);
    } catch (error) {
      console.error("Failed to render blurhash", error);
    }
  }, [blurhash]);

  return (
    <span
      className={`relative inline-block max-w-full overflow-hidden ${roundedClass}`}
      style={{ zoom: scale, aspectRatio }}
    >
      {blurhash && !loaded ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full scale-110 blur-sm ${roundedClass}`}
        />
      ) : null}
      <img
        ref={imageRef}
        src={cleanSrc}
        alt={alt}
        width={width}
        height={height}
        onClick={() => {
          show(cleanSrc);
        }}
        onLoad={onLoad}
        onError={onError}
        className={`mx-auto max-w-full cursor-zoom-in transition-opacity ${roundedClass} ${className || ""} ${
          blurhash && (!loaded || failed) ? "opacity-0" : "opacity-100"
        }`}
      />
    </span>
  );
}

export function Markdown({ content }: { content: string }) {
  const colorMode = useColorMode();
  const [index, setIndex] = React.useState(-1);
  const slides = useRef<SlideImage[]>();

  useEffect(() => {
    slides.current = undefined;
  }, [content]);
  /**
   * 🆕 2026-10-05：**统一行尾**——`\r\n` / `\n\r` / 单独 `\r` 都只算**一个**换行。
   * 背景（用户："我正文明明只回车了一次，到预览就换行了两次"）：某些编辑器/粘贴会在行尾混进 `\r`，
   * 于是同一个换行被数成两个（`whitespace-pre-line` 与 markdown 都会各算一次）⇒ 预览多出一个空行。
   * ⚠️ 它必须**同时**用于 `children` 和下面 img 的 `offset` 计算，否则图片定位会错位。
   */
  const normalizedContent = useMemo(
    () => stripParagraphIndent(content.replace(/\r\n|\n\r|\r/g, "\n")),
    [content],
  );



  const Content = useMemo(() => (
    <div className="toc-content dark:text-neutral-300">
    <ReactMarkdown
      remarkPlugins={[gfm, remarkMermaid, remarkMath, remarkAlert, remarkBreaks]}
      children={normalizedContent}
      rehypePlugins={[rehypeKatex, rehypeRaw]}
      components={{
        img({ node, src, ...props }) {
          const offset = node!.position!.start.offset!;
          const previousContent = normalizedContent.slice(0, offset);
          const newlinesBefore = countNewlinesBeforeNode(
            previousContent,
            offset
          );
          const Image = ({
            rounded,
            scale,
          }: {
            rounded: boolean;
            scale: string;
          }) => (
            <MarkdownImage
              src={src}
              alt={props.alt}
              show={show}
              rounded={rounded}
              scale={scale}
              className={props.className}
            />
          );
          if (
            newlinesBefore >= 1 ||
            previousContent.trim().length === 0 ||
            isMarkdownImageLinkAtEnd(previousContent)
          ) {
            return (
              <span className="block w-full text-center my-4">
                <Image scale="0.75" rounded={true} />
              </span>
            );
          } else {
            return (
              <span className="inline-block align-middle mx-1 ">
                <Image scale="0.5" rounded={false} />
              </span>
            );
          }
        },
        code(props) {
          const [copied, setCopied] = React.useState(false);
          const { children, className, node, ...rest } = props;
          const match = /language-(\w+)/.exec(className || "");

          const curContent = normalizedContent.slice(node?.position?.start.offset || 0);
          const isCodeBlock = curContent.trimStart().startsWith("```");

          const codeBlockStyle = {
            fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: "14px",
            fontVariantLigatures: "normal",
            WebkitFontFeatureSettings: '"liga" 1',
            fontFeatureSettings: '"liga" 1',
          };

          const inlineCodeStyle = {
            ...codeBlockStyle,
            fontSize: "13px",
          };

          const language = match ? match[1] : "";

          if (isCodeBlock) {
            return (
              <div className="relative group">
                <SyntaxHighlighter
                  PreTag="div"
                  className="rounded"
                  language={language}
                  style={
                    colorMode === "dark"
                      ? vscDarkPlus
                      : base16AteliersulphurpoolLight
                  }
                  wrapLongLines={true}
                  codeTagProps={{ style: codeBlockStyle }}
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
                <button className="absolute top-1 right-1 px-2 py-1 bg-w rounded-md text-sm bg-hover select-none invisible group-hover:visible"
                  onClick={() => {
                    navigator.clipboard.writeText(String(children));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            );
          } else {
            return (
              <code
                {...rest}
                className={`bg-[#eff1f3] dark:bg-[#4a5061] h-[24px] px-[4px] rounded-md mx-[2px] py-[2px] text-neutral-800 dark:text-neutral-300 ${className || ""
                  }`}
                style={inlineCodeStyle}
              >
                {children}
              </code>
            );
          }
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="border-l-4 border-gray-300 dark:border-gray-500 pl-4 italic text-gray-500 dark:text-gray-400"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        em({ children, ...props }) {
          return (
            <em className="ml-[1px] mr-[4px]" {...props}>
              {children}
            </em>
          );
        },
        strong({ children, ...props }) {
          return (
            <strong className="mx-[1px]" {...props}>
              {children}
            </strong>
          );
        },

        ul({ children, className, ...props }) {
          const listClass = className?.includes("contains-task-list")
            ? "list-none pl-5"
            : "list-disc pl-5 mt-2";
          return (
            <ul className={listClass} {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="list-decimal pl-5" {...props}>
              {children}
            </ol>
          );
        },
        li({ children, ...props }) {
          return (
            <li className="pl-2 py-1" {...props}>
              {children}
            </li>
          );
        },
        a({ children, ...props }) {
          return (
            <a
              className="text-[#0686c8] dark:text-[#2590f1] hover:underline"
              {...props}
            >
              {children}
            </a>
          );
        },
        h1({ children, ...props }) {
          return (
            <h1
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-3xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-2xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h3>
          );
        },
        h4({ children, ...props }) {
          return (
            <h4
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-lg font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h4>
          );
        },
        h5({ children, ...props }) {
          return (
            <h5
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-base font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h5>
          );
        },
        h6({ children, ...props }) {
          return (
            <h6
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-sm font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h6>
          );
        },
        p({ children, node, ...props }) {
                  // 🆕 2026-10-05（真机截图核对后重写）：首行缩进写进文本，而且**每个视觉行首都补**。
                  //    原因：remarkBreaks 把换行变成 <br>，图片/文字常挤在同一个 <p> 里 ⇒
                  //    只补"段落第一个行首"时，图片后面的那一段（作者明明也缩进了）看起来就没缩进 ✗。
                  //    规则：字符串且处于行首 ⇒ 前置两个全角空格；<br> 之后算新行首；
                  //          行首是图片等元素 ⇒ 不补空格（图片不许被推出去）。
                  const arr = Array.isArray(children) ? children : [children];
                  const out: React.ReactNode[] = [];
                  let atLineStart = true;
                  arr.forEach((child) => {
                    if (typeof child === "string") {
                      if (atLineStart && child.trim().length > 0) {
                        out.push("\u3000\u3000");
                        atLineStart = false;
                      }
                      out.push(child);
                      return;
                    }
                    const isBreak = React.isValidElement(child) && (child as { type?: unknown }).type === "br";
                    out.push(child);
                    atLineStart = isBreak;
                  });
                  return (
                    <p className="mt-2 py-1" {...props}>
                      {out}
                    </p>
                  );
                },
        table: ({ node, ...props }) => <table className="table" {...props} />,
        th: ({ node, ...props }) => (
          <th className="px-4 py-2 border bg-gray-600" {...props} />
        ),
        td: ({ node, ...props }) => (
          <td className="px-4 py-2 border" {...props} />
        ),
        sup: ({ children, ...props }) => (
          <sup className="text-xs mr-[4px]" {...props}>
            {children}
          </sup>
        ),
        sub: ({ children, ...props }) => (
          <sub className="text-xs mr-[4px]" {...props}>
            {children}
          </sub>
        ),
        section({ children, ...props }) {
          if (props.hasOwnProperty("data-footnotes")) {
            props.className = `${props.className || ""} mt-8`.trim();
          }
          const modifiedChildren = React.Children.map(children, (child) => {
            if (isValidElement(child) && child.props.node.tagName === "ol") {
              return cloneElement(child, {
                ...child.props,
                className: "list-decimal px-10 text-sm text-[#6B7280]",
              } as React.HTMLAttributes<HTMLParagraphElement>);
            }
            return child;
          });
          return <section {...props}>{modifiedChildren}</section>;
        },
        iframe({ node, src, title, ...props }) {
          return (
            <div className="my-4 w-full overflow-hidden rounded-xl">
              <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
                <iframe
                  {...props}
                  src={src}
                  title={title || "Embedded content"}
                  className="absolute top-0 left-0 w-full h-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  allowFullScreen
                />
              </div>
            </div>
          );
        },
        video({ children, ...props }) {
          return (
            <VideoPlayer {...props}>{children}</VideoPlayer>
          );
        },
        div({ children, node: _node, ...props }) {
          const className = (props.className || "") as string;
          if (className.includes("rin-download-card")) {
            const propsAny = props as Record<string, unknown>;
            const url = (propsAny["data-url"] as string) || "";
            const filename = (propsAny["data-filename"] as string) || undefined;
            const password = (propsAny["data-password"] as string) || undefined;
            if (url) {
              return <DownloadCard url={url} filename={filename} password={password} />;
            }
          }
          return <div {...props}>{children}</div>;
        },
      }}
    />
    </div>), [content])



  const show = (src: string | undefined) => {
    let slidesLocal = slides.current;
    if (!slidesLocal) {
      const parent = document.getElementsByClassName("toc-content")[0];
      if (!parent) return;
      const images = parent.querySelectorAll("img");
      slidesLocal = Array.from(images)
        .map((image) => {
          const url = image.getAttribute("src") || "";
          const filename = url.split("/").pop() || "";
          const alt = image.getAttribute("alt") || "";
          return {
            src: url,
            alt: alt,
            imageFit: "contain" as const,
            download: {
              url: url,
              filename: filename,
            },
          };
        })
        .filter((slide) => slide.src !== "");
      slides.current = (slidesLocal);
    }
    const index = slidesLocal?.findIndex((slide) => slide.src === src) ?? -1;
    setIndex(index);
  };

  return (
    <>
      {Content}
      <Lightbox
        plugins={[Download, Zoom, Counter]}
        index={index}
        slides={slides.current}
        open={index >= 0}
        close={() => setIndex(-1)}
      />
    </>
  );
}

/**
 * 🆕 2026-10-05：**吃掉段落行首手打的缩进**（半角空格 / 全角空格 / Tab），
 * 让"首行缩进"只由 CSS `.toc-content > p { text-indent: 2em }` 一处决定。
 * 背景：用户旧文里手打了两个全角空格 ⇒ 与 CSS 叠加会变成**双份缩进**（明显比平时深）✗。
 * ⚠️ **结构行一律不动**：代码围栏（``` / ~~~，含围栏内全部内容）、列表项、有序列表、引用、
 *    标题、表格、HTML、以及缩进 ≥4 空格的行（可能是缩进代码块）—— 动它们会破坏嵌套结构。
 */
export function stripParagraphIndent(text: string): string {
    let inFence = false;
    return text
        .split("\n")
        .map((line) => {
            if (/^\s*(```|~~~)/.test(line)) {
                inFence = !inFence;
                return line;
            }
            if (inFence) return line;
            if (/^\s*([-*+]|\d+\.|>|#{1,6}|\||<)/.test(line)) return line;
            if (/^[ \t]{4,}/.test(line)) return line;
            return line.replace(/^[\s\u3000]+/, ""); // ⚠️ 必须用 \s：NBSP(\u00a0)/BOM 这类不可见空格也要吃掉
        })
        .join("\n");
}
