-- Add show_toc column to feeds table
-- Controls whether the table of contents is displayed for this feed

--> statement-breakpoint
ALTER TABLE feeds ADD COLUMN show_toc INTEGER DEFAULT 0 NOT NULL;

--> statement-breakpoint
UPDATE info SET value = '11' WHERE key = 'migration_version';
