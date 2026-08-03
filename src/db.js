import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 让 pg 把 TIMESTAMPTZ / TIMESTAMP 以 ISO 字符串返回，保持与 SQLite 行为一致。
function isoParser(str) {
    if (str == null) return str;
    const iso = str.replace(' ', 'T');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? str : d.toISOString();
}
pg.types.setTypeParser(1184, isoParser);
pg.types.setTypeParser(1114, isoParser);

let pool = null;

/**
 * 初始化数据库（Supabase Postgres）。
 *
 * 从 DATABASE_URL 解析连接参数，以独立参数模式传给 Pool（而非 connectionString），
 * 因为独立参数模式下 family:4 才能正确生效，强制走 IPv4。
 *
 * connectionString 模式下 family:4 不生效是 node-postgres 的已知问题：
 * https://github.com/brianc/node-postgres/issues/1886
 */
export function initDb() {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) {
        throw new Error(
            'DATABASE_URL 环境变量未设置。请配置 Supabase Postgres 连接串（见 .env.example）'
        );
    }

    // 手动解析 postgresql://user:pass@host:port/database
    const urlObj = new URL(rawUrl);
    const config = {
        host: urlObj.hostname,
        port: parseInt(urlObj.port, 10) || 5432,
        user: decodeURIComponent(urlObj.username),
        password: decodeURIComponent(urlObj.password),
        database: urlObj.pathname.replace(/^\//, ''),
        ssl: { rejectUnauthorized: false },
        family: 4, // 独立参数模式下生效：强制 IPv4
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    };

    // 脱敏打印
    const maskedUrl = rawUrl.replace(/\/\/([^:]+):([^@]+)@/, '//\$1:****@');
    console.log('[DB] DATABASE_URL (masked):', maskedUrl);
    console.log(`[DB] Connecting to ${config.host}:${config.port} (family=4, forced IPv4)`);

    pool = new Pool(config);

    pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle Postgres client:', err.message);
    });

    console.log('[DB] Postgres pool initialized (Supabase, IPv4)');
    return dbApi;
}

/**
 * 异步数据库 API，兼容原 better-sqlite3 的 get/all/run 语义：
 *   - get(sql, ...params)  -> 单行或 null
 *   - all(sql, ...params)  -> 行数组
 *   - run(sql, ...params)  -> { changes, lastID, rows }
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
    async query(sql, ...params) {
        return pool.query(sql, params);
    },
    async close() {
        if (pool) await pool.end();
    },
};
