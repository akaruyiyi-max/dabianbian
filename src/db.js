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
 * 重要发现：Supabase Direct Connection (db.xxx.supabase.co:5432) 只配置了 AAAA (IPv6)，
 * 没有 A 记录 (IPv4)。Render 免费网络不支持 IPv6 → ENETUNREACH。
 *
 * 解决方案：使用 Supabase Transaction Pooler (aws-0-[region].pooler.supabase.com:6542)，
 * 该端点有 IPv4 地址。Pooler 对应用透明，支持相同的 SQL 操作。
 *
 * 连接串格式转换：
 *   原始: postgresql://postgres:PASS@db.PROJECT_REF.supabase.co:5432/postgres?sslmode=require
 *   转换: postgresql://postgres:PASS@aws-0-us-east-1.pooler.supabase.com:6542/postgres?sslmode=require
 *
 * 可通过环境变量 SUPABASE_POOLER_HOST 覆盖默认 pooler 主机名。
 */
export async function initDb() {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) {
        throw new Error(
            'DATABASE_URL 环境变量未设置。请配置 Supabase Postgres 连接串（见 .env.example）'
        );
    }

    const maskedUrl = rawUrl.replace(/\/\/([^:]+):([^@]+)@/, '//\$1:****@');
    console.log('[DB] DATABASE_URL (masked):', maskedUrl);

    // 解析原始连接串
    const urlObj = new URL(rawUrl);
    const hostname = urlObj.hostname;

    // 检测是否是 Direct Connection（db.xxx.supabase.co），如果是则自动切换到 Pooler
    let finalUrl = rawUrl;
    if (hostname.startsWith('db.') && hostname.endsWith('.supabase.co')) {
        const poolerHost = process.env.SUPABASE_POOLER_HOST || 'aws-0-us-east-1.pooler.supabase.com';
        const poolerPort = 6542;

        finalUrl = rawUrl
            .replace(hostname, poolerHost)
            .replace(`:${urlObj.port || 5432}`, `:${poolerPort}`);

        console.log(`[DB] ⚡  Auto-switching to Transaction Pooler:`);
        console.log(`[DB]    ${hostname}:${urlObj.port || 5432} → ${poolerHost}:${poolerPort}`);
        console.log('[DB]    (Direct Connection has no IPv4; Pooler has IPv4)');
    }

    pool = new Pool({
        connectionString: finalUrl,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });

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
