import { eq, desc, ne } from "drizzle-orm";
import { feeds } from "../db/schema";
import { clearFeedCache } from "./feed";
import { syncFeedAISummaryQueueState } from "./feed-ai-summary";

type QueueTaskStatus = "idle" | "pending" | "processing" | "completed" | "failed";

export interface QueueTaskSummary {
  idle: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface QueueTaskItem {
  id: number;
  title: string | null;
  aiSummaryStatus: QueueTaskStatus;
  aiSummaryError: string;
  updatedAt: string;
  createdAt: string;
}

export interface QueueStatusResponse {
  queueConfigured: boolean;
  generatedAt: string;
  summary: QueueTaskSummary;
  items: QueueTaskItem[];
}

export async function retryQueueStatusTask(
  db: any,
  cache: any,
  serverConfig: { get(key: string): Promise<unknown> },
  env: Env,
  feedId: number,
) {
  const feed = await db.query.feeds.findFirst({
    where: eq(feeds.id, feedId),
  });

  if (!feed) {
    throw new Error("Feed not found");
  }

  if (feed.ai_summary_status !== "failed") {
    throw new Error("Only failed AI summary tasks can be retried");
  }

  await syncFeedAISummaryQueueState(db, serverConfig, env, feedId, {
    draft: feed.draft === 1,
    updatedAt: feed.updatedAt,
    resetSummary: false,
    // 这篇自己关了 AI 摘要的话，点"重试"也不该把它生成出来
    aiSummaryEnabled: feed.ai_summary_enabled !== 0,
  });
  await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}

export async function deleteQueueStatusTask(
  db: any,
  cache: any,
  feedId: number,
) {
  const feed = await db.query.feeds.findFirst({
    where: eq(feeds.id, feedId),
  });

  if (!feed) {
    throw new Error("Feed not found");
  }

  // 任何非 idle 的记录都能手动清掉：原来只允许 failed/completed，
  // 卡在 pending/processing（队列消费者没跑、消息丢了）的记录就永远删不掉，只能干看着
  if (feed.ai_summary_status === "idle") {
    throw new Error("This task record is already idle");
  }

  await db
    .update(feeds)
    .set({
      ai_summary_status: "idle",
      ai_summary_error: "",
    })
    .where(eq(feeds.id, feedId));

  await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}

export async function buildQueueStatusResponse(
  db: any,
  env: Env,
): Promise<QueueStatusResponse> {
  const summary: QueueTaskSummary = {
    idle: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };

  const allFeeds = await db.query.feeds.findMany({
    columns: {
      id: true,
      ai_summary_status: true,
    },
  });

  for (const feed of allFeeds) {
    const status = feed.ai_summary_status as QueueTaskStatus;
    if (status in summary) {
      summary[status] += 1;
    }
  }

  const items = await db.query.feeds.findMany({
    where: ne(feeds.ai_summary_status, "idle"),
    columns: {
      id: true,
      title: true,
      ai_summary_status: true,
      ai_summary_error: true,
      updatedAt: true,
      createdAt: true,
    },
    orderBy: [desc(feeds.updatedAt)],
    limit: 50,
  });

  return {
    queueConfigured: Boolean(env.TASK_QUEUE),
    generatedAt: new Date().toISOString(),
    summary,
    items: items.map((item: {
      id: number;
      title: string | null;
      ai_summary_status: string;
      ai_summary_error: string;
      updatedAt: Date;
      createdAt: Date;
    }) => ({
      id: item.id,
      title: item.title,
      aiSummaryStatus: item.ai_summary_status as QueueTaskStatus,
      aiSummaryError: item.ai_summary_error,
      updatedAt: item.updatedAt.toISOString(),
      createdAt: item.createdAt.toISOString(),
    })),
  };
}
