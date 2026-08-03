-- =====================================================================
-- 答辩记录仪 - Supabase Postgres Schema
-- =====================================================================
-- 用途：在 Supabase Dashboard -> SQL Editor 中全选执行本文件，
--       完成建表 + 触发器（对应原 SQLite 的建表语句与触发器）。
--
-- 说明：
--   1. 主键用 SERIAL（替代 SQLite 的 AUTOINCREMENT）
--   2. 时间字段用 TIMESTAMPTZ（替代 datetime('now')）
--   3. 触发器 trg_user_stats_init 在新增用户时自动在 user_stats 插一行，
--      与原 SQLite 触发器行为一致（保证打卡统计可写）。
--   4. 连接串直连 postgres 角色会绕过 RLS，无需额外配置行级安全。
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    DEFAULT '',
    avatar_emoji  TEXT    NOT NULL DEFAULT '💩',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS checkins (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checkin_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checkin_date  TEXT    NOT NULL,
    note          TEXT    DEFAULT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkins_user_id ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_checkins_time ON checkins(checkin_time DESC);

CREATE TABLE IF NOT EXISTS user_stats (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak     INTEGER NOT NULL DEFAULT 0,
    longest_streak     INTEGER NOT NULL DEFAULT 0,
    total_checkins     INTEGER NOT NULL DEFAULT 0,
    last_checkin_time  TIMESTAMPTZ,
    last_reminder_sent TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 触发器函数：新用户注册时自动创建对应的 user_stats 行
CREATE OR REPLACE FUNCTION init_user_stats() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_stats (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_stats_init ON users;
CREATE TRIGGER trg_user_stats_init
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION init_user_stats();
