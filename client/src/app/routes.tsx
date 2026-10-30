import type { ComponentType, ReactNode } from "react";
import { lazy, Suspense, useContext } from "react";
import type { DefaultParams, PathPattern } from "wouter";
import { Route, Switch } from "wouter";
import { AdminLayout } from "../components/admin-layout";
import Footer from "../components/footer";
import { Header } from "../components/header";
import { Padding } from "../components/padding";
import { Waiting } from "../components/loading";
import { TOCHeader } from "../components/toc-header";
import { getHeaderLayoutDefinition } from "../components/site-header/layout-registry";
import useTableOfContents from "../hooks/useTableOfContents";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { ErrorPage } from "../page/error";
import { FeedsPage } from "../page/feeds";
import { ProfileContext } from "../state/profile";
import { tryInt } from "../utils/int";
import { useTranslation } from "react-i18next";

/**
 * 除首页外全部按需加载。
 *
 * 之前这里 26 个页面全是静态 import ⇒ 打包成**一个 5.5MB 的 entry chunk**：
 * 游客打开首页也得先把 monaco（写作页专用）、mermaid、Prism、整个管理后台都下载并解析完才出页面。
 * 实测线上 `index-*.js` 未压缩 5.5MB、br 后 1.5MB，压缩前那条链路上要 60 多秒。
 * 现在首屏只要 shell + 首页，其它页面各走各的 chunk。
 */
const CHUNK_RELOAD_KEY = "rin.chunk-reload";

/**
 * 懒加载 + "旧 chunk 404" 自愈。
 *
 * 拆包以后多了一种新故障：用户还停在老页面上，我们发了一版新的 ⇒ 老 chunk 的 hash 在 CDN 上没了，
 * 点进任何一页都会 `Failed to fetch dynamically imported module`。整页刷新一次就能拿到新的
 * `index.html` 和新的 chunk，所以这里直接刷新；但只允许自动刷一次（`sessionStorage` 记账），
 * 真挂了（网络断、部署坏了）就交给 GlobalErrorBoundary 显示错误页，不许无限刷新。
 */
function lazyWithRetry<T extends { default: ComponentType<any> }>(factory: () => Promise<T>) {
  return lazy(() =>
    factory().then(
      (module) => {
        try {
          window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        } catch {
          // 隐私模式下 sessionStorage 可能不可用，忽略
        }
        return module;
      },
      (error) => {
        try {
          if (!window.sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
            window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
            window.location.reload();
            // 页面马上要刷新，先挂住这次渲染，别让 React 继续按失败处理
            return new Promise<T>(() => {});
          }
        } catch {
          // 拿不到 sessionStorage 就不自愈，直接抛给 ErrorBoundary
        }
        throw error;
      },
    ),
  );
}

const FeedPageLazy = lazyWithRetry(() => import("../page/feed").then((m) => ({ default: m.FeedPage })));
const TimelinePageLazy = lazyWithRetry(() => import("../page/timeline").then((m) => ({ default: m.TimelinePage })));
const MomentsPageLazy = lazyWithRetry(() => import("../page/moments").then((m) => ({ default: m.MomentsPage })));
const FriendsPageLazy = lazyWithRetry(() => import("../page/friends").then((m) => ({ default: m.FriendsPage })));
const HashtagsPageLazy = lazyWithRetry(() => import("../page/hashtags").then((m) => ({ default: m.HashtagsPage })));
const HashtagPageLazy = lazyWithRetry(() => import("../page/hashtag").then((m) => ({ default: m.HashtagPage })));
const SearchPageLazy = lazyWithRetry(() => import("../page/search").then((m) => ({ default: m.SearchPage })));
const SettingsLazy = lazyWithRetry(() => import("../page/settings").then((m) => ({ default: m.Settings })));
const HealthPageLazy = lazyWithRetry(() => import("../page/health").then((m) => ({ default: m.HealthPage })));
const QueueStatusPageLazy = lazyWithRetry(() => import("../page/queue-status").then((m) => ({ default: m.QueueStatusPage })));
const CompatTasksPageLazy = lazyWithRetry(() => import("../page/compat-tasks").then((m) => ({ default: m.CompatTasksPage })));
const WritingPageLazy = lazyWithRetry(() => import("../page/writing").then((m) => ({ default: m.WritingPage })));
const CommentsAdminPageLazy = lazyWithRetry(() => import("../page/comments-admin").then((m) => ({ default: m.CommentsAdminPage })));
const ImagesAdminPageLazy = lazyWithRetry(() => import("../page/images-admin").then((m) => ({ default: m.ImagesAdminPage })));
const UsersAdminPageLazy = lazyWithRetry(() => import("../page/users-admin").then((m) => ({ default: m.UsersAdminPage })));
const InviteAdminPageLazy = lazyWithRetry(() => import("../page/invite-admin").then((m) => ({ default: m.InviteAdminPage })));
const CallbackPageLazy = lazyWithRetry(() => import("../page/callback").then((m) => ({ default: m.CallbackPage })));
const LoginPageLazy = lazyWithRetry(() => import("../page/login").then((m) => ({ default: m.LoginPage })));
const RegisterPageLazy = lazyWithRetry(() => import("../page/register").then((m) => ({ default: m.RegisterPage })));
const ProfilePageLazy = lazyWithRetry(() => import("../page/profile").then((m) => ({ default: m.ProfilePage })));

export function AppRoutes() {
  const { t } = useTranslation();

  return (
    <Switch>
      <AppRoute path="/">
        <FeedsPage />
      </AppRoute>

      <AppRoute path="/timeline">
        <TimelinePageLazy />
      </AppRoute>

      <AppRoute path="/moments">
        <MomentsPageLazy />
      </AppRoute>

      <AppRoute path="/friends">
        <FriendsPageLazy />
      </AppRoute>

      <AppRoute path="/hashtags">
        <HashtagsPageLazy />
      </AppRoute>

      <AppRoute path="/hashtag/:name">
        {(params) => <HashtagPageLazy name={params.name || ""} />}
      </AppRoute>

      <AppRoute path="/search/:keyword">
        {(params) => <SearchPageLazy keyword={params.keyword || ""} />}
      </AppRoute>

      <AdminRoute path="/admin/settings" requirePermission title={t("settings.title")} description={t("admin.settings_description")}>
        <SettingsLazy />
      </AdminRoute>

      <AdminRoute path="/admin/health" requirePermission title={t("health.title")} description={t("admin.health_description")}>
        <HealthPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/queue-status" requirePermission title={t("queue_status.title")} description={t("admin.queue_status_description")}>
        <QueueStatusPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/compat-tasks" requirePermission title={t("compat_tasks.title")} description={t("admin.compat_tasks_description")}>
        <CompatTasksPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/writing" requirePermission title={t("writing")} description={t("admin.writing_description")}>
        <WritingPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/writing/:id" requirePermission title={t("writing")} description={t("admin.writing_description")}>
        {({ id }) => <WritingPageLazy id={tryInt(0, id)} />}
      </AdminRoute>

      <AdminRoute path="/admin/comments" requirePermission title={t("comment.admin.title")} description={t("admin.comments_description")}>
        <CommentsAdminPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/images" requirePermission title={t("images.admin.title")} description={t("admin.images_description")}>
        <ImagesAdminPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/users" requirePermission title={t("user.admin.title")} description={t("admin.users_description")}>
        <UsersAdminPageLazy />
      </AdminRoute>

      <AdminRoute path="/admin/invite" requirePermission title={t("invite.admin.title")} description={t("admin.invite_description")}>
        <InviteAdminPageLazy />
      </AdminRoute>

      <AppRoute path="/callback">
        <CallbackPageLazy />
      </AppRoute>

      <AppRoute path="/login">
        <LoginPageLazy />
      </AppRoute>

      <AppRoute path="/register">
        <RegisterPageLazy />
      </AppRoute>

      <AppRoute path="/profile">
        <ProfilePageLazy />
      </AppRoute>

      <TocRoute path="/feed/:id">
        {(params, toc, cleanup) => <FeedPageLazy id={params.id || ""} TOC={toc} clean={cleanup} />}
      </TocRoute>

      <TocRoute path="/:alias">
        {(params, toc, cleanup) => <FeedPageLazy id={params.alias || ""} TOC={toc} clean={cleanup} />}
      </TocRoute>

      <AppRoute>
        <ErrorPage error={t("error.not_found")} />
      </AppRoute>
    </Switch>
  );
}

/** 懒加载页面的占位：跟页面里的 Waiting 一个观感，头尾导航不会消失 */
function RouteFallback() {
  return <Waiting />;
}

function AppRoute({
  path,
  children,
  headerComponent,
  paddingClassName,
  requirePermission,
}: {
  path?: PathPattern;
  children: ReactNode | ((params: DefaultParams) => ReactNode);
  headerComponent?: ReactNode;
  paddingClassName?: string;
  requirePermission?: boolean;
}) {
  const profile = useContext(ProfileContext);
  const siteConfig = useSiteConfig();
  const { t } = useTranslation();

  const content =
    requirePermission && !profile?.permission ? <ErrorPage error={t("error.permission_denied")} /> : children;

  return (
    <Route path={path}>
      {(params) => {
        const resolvedContent = typeof content === "function" ? content(params) : content;
        const layoutDefinition = getHeaderLayoutDefinition(siteConfig.headerLayout);

        return layoutDefinition.renderRouteShell({
          header: <Header>{headerComponent}</Header>,
          content: (
            <Padding className={paddingClassName}>
              <Suspense fallback={<RouteFallback />}>{resolvedContent}</Suspense>
            </Padding>
          ),
          footer: <Footer />,
          paddingClassName,
        });
      }}
    </Route>
  );
}

function AdminRoute({
  path,
  children,
  requirePermission,
  title,
  description,
}: {
  path: PathPattern;
  children: ReactNode | ((params: DefaultParams) => ReactNode);
  requirePermission?: boolean;
  title: string;
  description: string;
}) {
  const profile = useContext(ProfileContext);
  const { t } = useTranslation();
  const content =
    requirePermission && !profile?.permission ? <ErrorPage error={t("error.permission_denied")} /> : children;

  return (
    <Route path={path}>
      {(params) => (
        <AdminLayout title={title} description={description}>
          <Suspense fallback={<RouteFallback />}>
            {typeof content === "function" ? content(params) : content}
          </Suspense>
        </AdminLayout>
      )}
    </Route>
  );
}

function TocRoute({
  path,
  children,
}: {
  path: PathPattern;
  children: (params: DefaultParams, toc: () => JSX.Element, cleanup: (id: string) => void) => ReactNode;
}) {
  const { TOC, cleanup } = useTableOfContents(".toc-content");

  return (
    <AppRoute path={path} headerComponent={TOCHeader({ TOC })} paddingClassName="mx-4">
      {(params) => children(params, TOC, cleanup)}
    </AppRoute>
  );
}
