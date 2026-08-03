import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 让 pg 把 TIMESTAMPTZ / TIMESTAMP 以 ISO 字符串返回，保持与 SQLite 行为一致。
// 默认 pg 会返回 JS Date 对象，会导致后续字符串处理（parseDbDate 等）出错。
function isoParser(str) {
    if (str == null) return str;
    const iso = str.replace(' ', 'T'); // "2026-08-03 04:20:10.69+00" -> "2026-08-03T04:20:10.69+00"
    const d = new Date(iso);
    return isNaN(d.getTime()) ? str : d.toISOString(); // -> "2026-08-03T04:20:10.690Z"
}
// 1184 = timestamptz, 1114 = timestamp（无时区，但同样用 ISO 字符串返回以免变成 Date）
pg.types.setTypeParser(1184, isoParser);
pg.types.setTypeParser(1114, isoParser);

let pool = null;

/**
 * 初始化数据库（Supabase Postgres）。
 * 通过环境变量 DATABASE_URL 读取连接串，例如：
 *   postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
 */
export function initDb() {
    const connectionString = process.env.DATABASE_URL;
    // 启动时打印脱敏连接串用于排查（仅打印协议+主机，隐藏密码）
    if (connectionString) {
        const masked = connectionString.replace(/\/\/([^:]+):([^@]+)@/, '//\$1:****@');
        console.log('[DB] DATABASE_URL (masked):', masked);
    } else {
        console.error('[DB] ⚠️  DATABASE_URL is EMPTY or UNDEFINED!');
    }
    if (!connectionString) {
        throw new Error(
            'DATABASE_URL 环境变量未设置。请配置 Supabase Postgres 连接串（见 .env.example）'
        );
    }

    pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }, // Supabase 要求 SSL；自签名证书故跳过校验
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });

    // 连接异常时打印，避免进程静默退出
    pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle Postgres client:', err.message);
    });

    console.log('[DB] Postgres pool initialized (Supabase)');
    return dbApi;
}

/**
 * 异步数据库 API，兼容原 better-sqlite3 的 get/all/run 语义：
 *   - get(sql, ...params)  -> 单行或 null
 *   - all(sql, ...params)  -> 行数组
 *   - run(sql, ...params)  -> { changes, lastID, rows }（INSERT ... RETURNING id 时 lastID 为插入的 id）
 */
const dbApi = {
    async get(sql, ...params) {
        const res = await pool.query(sql, params);
        return res.rows[0] || null;
    },
    async all(sql, ...params) {
        const res = await pool.query(sql, params);
        return res.rows;
    },
    async run(sql, ...params) {
        const res = await pool.query(sql, params);
        return {
            changes: res.rowCount ?? 0,
            lastID: res.rows[0]?.id ?? null,
            rows: res.rows,
        };
    },
    // 原始查询（保留给需要完整 result 元数据的场景）
    async query(sql, ...params) {
        return pool.query(sql, params);
    },
    async close() {
        if (pool) await pool.end();
    },
};
