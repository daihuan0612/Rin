import "../../test/setup";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileContext } from "../../state/profile";
import type { Profile } from "../../state/profile";
import { Markdown } from "../markdown";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

const AUTHOR: Profile = { id: 1, avatar: "", permission: true, name: "admin" };
const READER: Profile = { id: 2, avatar: "", permission: false, name: "reader" };

// 前后留空行，让 HTML 成为块级（否则会被包进 <p>，触发 validateDOMNesting 警告）
const VIDEO_MD = `\n\n<video controls><source src="https://example.com/a.mp4"></video>\n\n`;
const IFRAME_MD = `\n\n<iframe src="//player.bilibili.com/player.html?bvid=BV1xx"></iframe>\n\n`;

function renderWith(profile: Profile | null | undefined, content: string) {
  return render(
    <ProfileContext.Provider value={profile}>
      <Markdown content={content} />
    </ProfileContext.Provider>,
  );
}

/**
 * 视频打码：只有登录用户能看画面。
 * 未登录 / 加载中（undefined）⇒ 模糊遮罩 + 点不动。
 */
describe("视频打码（未登录只能看到模糊封面）", () => {
  it("未登录：mp4 有遮罩、没有控制条", () => {
    const { container } = renderWith(null, VIDEO_MD);
    expect(container.querySelectorAll(".video-glass")).toHaveLength(1);
    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.hasAttribute("controls")).toBe(false);
    expect(container.querySelector(".video-glass")!.textContent).toContain("markdown.video_locked");
  });

  it("未登录：媒体元素带上模糊类", () => {
    const { container } = renderWith(null, VIDEO_MD);
    expect(container.querySelector("video")!.className).toContain("video-locked-media");
  });

  it("未登录：B 站 iframe 同样被罩住", () => {
    const { container } = renderWith(null, IFRAME_MD);
    expect(container.querySelectorAll(".video-glass")).toHaveLength(1);
    const iframe = container.querySelector("iframe")!;
    expect(iframe.className).toContain("video-locked-media");
  });

  it("还没拿到登录态（undefined）也按锁定处理，不能先露一帧", () => {
    const { container } = renderWith(undefined, VIDEO_MD);
    expect(container.querySelectorAll(".video-glass")).toHaveLength(1);
  });

  it("作者登录：没有遮罩、恢复控制条", () => {
    const { container } = renderWith(AUTHOR, VIDEO_MD);
    expect(container.querySelectorAll(".video-glass")).toHaveLength(0);
    expect(container.querySelector("video")!.hasAttribute("controls")).toBe(true);
  });

  it("注册读者登录：同样能看（不看 permission）", () => {
    const { container } = renderWith(READER, VIDEO_MD);
    expect(container.querySelectorAll(".video-glass")).toHaveLength(0);
    expect(container.querySelector("video")!.className).not.toContain("video-locked-media");
  });

  // 静音自动播放会绕过遮罩让画面动起来，"点不动"就名存实亡了
  const AUTOPLAY_MD = `\n\n<video autoplay muted><source src="https://example.com/a.mp4"></video>\n\n`;

  it("未登录：autoplay 被摘掉", () => {
    const { container } = renderWith(null, AUTOPLAY_MD);
    expect(container.querySelector("video")!.hasAttribute("autoplay")).toBe(false);
  });

  it("登录后：autoplay 原样保留", () => {
    const { container } = renderWith(AUTHOR, AUTOPLAY_MD);
    expect(container.querySelector("video")!.hasAttribute("autoplay")).toBe(true);
  });
});
