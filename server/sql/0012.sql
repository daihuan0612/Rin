-- 邀请码注册：users 加备注/自述/注册 IP/停用四列，并新建 invite_codes 表（一次一码）

--> statement-breakpoint
ALTER TABLE users ADD COLUMN note TEXT DEFAULT '' NOT NULL;

--> statement-breakpoint
ALTER TABLE users ADD COLUMN signup_note TEXT DEFAULT '' NOT NULL;

--> statement-breakpoint
ALTER TABLE users ADD COLUMN signup_ip TEXT DEFAULT '' NOT NULL;

--> statement-breakpoint
ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0 NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    note TEXT DEFAULT '' NOT NULL,
    used_by INTEGER,
    used_at INTEGER,
    revoked INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

--> statement-breakpoint
UPDATE info SET value = '12' WHERE key = 'migration_version';
