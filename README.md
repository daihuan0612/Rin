# Rin - 个人博客平台

基于 [openRin/Rin](https://github.com/openRin/Rin) 的定制分支，在原版基础上增强编辑器和管理功能，适配个人使用。

## 与原版的差异

### 新增功能

#### 编辑器增强
- **视频插入** — 支持 B站、YouTube、Vimeo 以及 MP4/WebM 直链视频嵌入
- **下载卡片** — 插入带密码保护的文件下载链接，可自定义文件名
- **小说格式化** — 一键识别章节标题、自动首行缩进，专为长文创作优化
- **首行缩进** — 快速添加/移除中文段落首行缩进
- **居中按钮** — 选中文本一键居中（`<center>` 标签）

#### 管理后台增强
- **图片管理页面** — 新增 `/admin/images`，网格展示所有已上传图片，支持单选/全选/批量删除、URL 复制、预览弹窗
- **评论管理页面** — 新增 `/admin/comments`，按状态筛选（全部/待审核/已通过），支持审核评论、删除、分页

#### 功能开关与配置
- **友链页面开关** — 导航栏"朋友们"入口受 `friend_page_enable` 配置控制，可在设置页关闭
- **友链申请开关** — 支持关闭友链申请入口
- **文章目录开关** — 写作页面新增"显示目录"复选框，每篇文章可独立控制是否显示目录

#### 其他
- **去除标题重复限制** — 文章标题不再有唯一性约束，同标题可重复使用；只检查内容是否重复

### 未改动

路由、认证（密码登录/GitHub OAuth）、动态、标签、搜索、RSS、图片存储、AI 摘要、Webhook、缓存、站点个性化（主题色、布局、行为模式）等核心功能保持与原版一致。

## 功能特性

- **用户认证与管理**：支持密码登录 / GitHub OAuth。首个注册用户自动成为管理员。
- **内容创作**：Monaco 编辑器 + Markdown，支持实时自动保存。
- **隐私控制**：文章可标记为"仅自己可见"，跨设备同步。
- **图片管理**：拖放或粘贴上传至 S3 兼容存储（R2），自动生成链接。
- **自定义别名**：`https://yourblog.com/about` 风格的自定义 URL。
- **友情链接**：添加友链，后端每 20 分钟自动检查可用性。
- **评论系统**：支持回复与删除管理。
- **Webhook 通知**：新评论实时推送到外部工具。
- **特色图片**：自动取文章首张图片作为列表封面。
- **标签解析**：`#标签` 自动解析展示。
- **类型安全**：通过 `@rin/api` 共享前后端类型。
- **AI 摘要**：可选接入 AI 自动生成文章摘要。

## 快速开始

```bash
# 克隆本仓库
git clone https://github.com/daihuan0612/Rin.git && cd Rin

# 安装依赖
bun install

# 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填入你的配置

# 启动开发服务器
bun run dev
```

访问 http://localhost:5173 开始使用。

### 测试

```bash
# 运行所有测试
bun run test

# 仅服务器测试
bun run test:server

# 测试覆盖率
bun run test:coverage
```

### 部署

部署流程与原版 [openRin/Rin](https://github.com/openRin/Rin) 相同：

```bash
# 全部部署
bun run deploy

# 仅后端
bun run deploy:server

# 仅前端
bun run deploy:client
```

## License

MIT License

Copyright (c) 2024 Xeu
