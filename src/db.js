import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function initDb() {
    // 数据库路径可通过环境变量 DB_PATH 覆盖（便于 Render 等平台挂载持久磁盘）
    const dbPath = process.env.DB_PATH
        ? process.env.DB_PATH
        : join(__dirname, '..', 'data', 'app.db');

    // 确保数据库所在目录存在
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);

    // 启用 WAL 模式提升并发性能
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // 建表
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            password_hash TEXT    DEFAULT '',
            avatar_emoji  TEXT    NOT NULL DEFAULT '\u{1F4A9}',
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

        CREATE TABLE IF NOT EXISTS checkins (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL,
            checkin_time TEXT    NOT NULL DEFAULT (datetime('now')),
            checkin_date TEXT    NOT NULL,
            note         TEXT    DEFAULT NULL,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_checkins_user_id ON checkins(user_id);
        CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, checkin_date);
        CREATE INDEX IF NOT EXISTS idx_checkins_time ON checkins(checkin_time DESC);

        CREATE TABLE IF NOT EXISTS user_stats (
            user_id             INTEGER PRIMARY KEY,
            current_streak      INTEGER NOT NULL DEFAULT 0,
            longest_streak      INTEGER NOT NULL DEFAULT 0,
            total_checkins      INTEGER NOT NULL DEFAULT 0,
            last_checkin_time   TEXT,
            last_reminder_sent  TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_user_stats_init
        AFTER INSERT ON users
        BEGIN
            INSERT INTO user_stats (user_id) VALUES (new.id);
        END;

        -- 元数据表（记录每月重置等运维状态）
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    console.log('[DB] SQLite initialized at', dbPath);
    return db;
}
