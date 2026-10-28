-- 单篇 AI 摘要开关：纯视频这类不需要总结的文章可以关掉
-- 默认 1（开启），老文章全部按开启处理，行为不变

--> statement-breakpoint
ALTER TABLE feeds ADD COLUMN ai_summary_enabled INTEGER DEFAULT 1 NOT NULL;

--> statement-breakpoint
UPDATE info SET value = '13' WHERE key = 'migration_version';
