import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const created_at = integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();
const updated_at = integer("updated_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();

export const feeds = sqliteTable("feeds", {
    id: integer("id").primaryKey(),
    alias: text("alias"),
    title: text("title"),
    summary: text("summary").default("").notNull(),
    ai_summary: text("ai_summary").default("").notNull(),
    ai_summary_status: text("ai_summary_status").default("idle").notNull(),
    ai_summary_error: text("ai_summary_error").default("").notNull(),
    content: text("content").notNull(),
    listed: integer("listed").default(1).notNull(),
    draft: integer("draft").default(1).notNull(),
    top: integer("top").default(0).notNull(),
    show_toc: integer("show_toc").default(0).notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const moments = sqliteTable("moments", {
    id: integer("id").primaryKey(),
    content: text("content").notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at
});

export const visits = sqliteTable("visits", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    ip: text("ip").notNull(),
    createdAt: created_at,
});

export const visitStats = sqliteTable("visit_stats", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull().primaryKey(),
    pv: integer("pv").default(0).notNull(),
    hllData: text("hll_data").default("").notNull(),
    updatedAt: updated_at,
});

export const info = sqliteTable("info", {
    key: text("key").notNull().unique(),
    value: text("value").notNull(),
});

export const friends = sqliteTable("friends", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    desc: text("desc"),
    avatar: text("avatar").notNull(),
    url: text("url").notNull(),
    uid: integer("uid").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    accepted: integer("accepted").default(0).notNull(),
    health: text("health").default("").notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    username: text("username").notNull(),
    openid: text("openid").notNull(),
    avatar: text("avatar"),
    password: text("password"),
    permission: integer("permission").default(0),
    // 作者给这个用户写的备注：注册时从邀请码的备注自动带过来（"这个码给老王"⇒ 用户备注就是老王），
    // 之后作者也可以随时改。目的是"不管他起什么网名，我都知道他是谁"。
    note: text("note").default("").notNull(),
    // 注册时他自己填的一句"你是谁"（只读，和上面的备注分开存）
    signup_note: text("signup_note").default("").notNull(),
    // 注册时的来源 IP，用来认人 / 事后追
    signup_ip: text("signup_ip").default("").notNull(),
    // 停用：登录直接拒绝；已经登录的会话在 authMiddleware 里当作未登录
    disabled: integer("disabled").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

/**
 * 邀请码：一次一码。
 * 每个码带一句备注（"给谁的"），注册成功后备注自动写进那个用户的 `note`，
 * 码本身标记 used_by / used_at，不能再用 —— 这样"码 → 人 → 用户名"能对上。
 */
export const inviteCodes = sqliteTable("invite_codes", {
    id: integer("id").primaryKey(),
    code: text("code").notNull().unique(),
    note: text("note").default("").notNull(),
    used_by: integer("used_by"),
    used_at: integer("used_at", { mode: 'timestamp' }),
    revoked: integer("revoked").default(0).notNull(),
    createdAt: created_at,
});

export const comments = sqliteTable("comments", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }),
    content: text("content").notNull(),
    guestName: text("guest_name").default(""),
    guestEmail: text("guest_email").default(""),
    guestWebsite: text("guest_website").default(""),
    approved: integer("approved").default(1).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const hashtags = sqliteTable("hashtags", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const feedHashtags = sqliteTable("feed_hashtags", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    hashtagId: integer("hashtag_id").references(() => hashtags.id, { onDelete: 'cascade' }).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const cache = sqliteTable("cache", {
    id: integer("id").primaryKey(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    type: text("type").default("cache").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    // 复合唯一约束：key + type
    keyTypeUnique: unique().on(table.key, table.type),
}));

export const feedsRelations = relations(feeds, ({ many, one }) => ({
    hashtags: many(feedHashtags),
    user: one(users, {
        fields: [feeds.uid],
        references: [users.id],
    }),
    comments: many(comments),
}));

export const momentsRelations = relations(moments, ({ one }) => ({
    user: one(users, {
        fields: [moments.uid],
        references: [users.id],
    })
}));

export const commentsRelations = relations(comments, ({ one }) => ({
    feed: one(feeds, {
        fields: [comments.feedId],
        references: [feeds.id],
    }),
    user: one(users, {
        fields: [comments.userId],
        references: [users.id],
    }),
}));

export const hashtagsRelations = relations(hashtags, ({ many }) => ({
    feeds: many(feedHashtags),
}));

export const feedHashtagsRelations = relations(feedHashtags, ({ one }) => ({
    feed: one(feeds, {
        fields: [feedHashtags.feedId],
        references: [feeds.id],
    }),
    hashtag: one(hashtags, {
        fields: [feedHashtags.hashtagId],
        references: [hashtags.id],
    }),
}));
