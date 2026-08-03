import pg from 'pg';
import { promises as dnsPromises } from 'node:dns';
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
 * 异步函数：启动时用 dns.promises.lookup({ family: 4 }) 将主机名解析为纯 IPv4 地址，
 * 然后替换连接串中的主机名为 IPv4 IP，再创建 Pool。
 *
 * 原因：Supabase DNS 返回 AAAA (IPv6)，Render 免费网络不支持 IPv6 → ENETUNREACH。
 *       node-postgres 的 family:4 参数在 connectionString 和独立参数模式下均不生效
 *       （底层 libpq 绕过 Node 的 family 设置）。
 *       唯一可靠的方式是提前解析为 IPv4 IP，让 pg 直接连 IP 而不再查 DNS。
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

    // 解析主机名，异步 DNS 查询仅取 A 记录 (IPv4)
    const urlObj = new URL(rawUrl);
    const hostname = urlObj.hostname;

    let finalUrl = rawUrl;
    try {
        console.log(`[DB] Resolving ${hostname} to IPv4 (async DNS)...`);
        const { address } = await dnsPromises.lookup(hostname, { family: 4 });
        console.log(`[DB] ✅ DNS: ${hostname} -> ${address} (IPv4)`);

        // 将连接串中的主机名替换为 IPv4 地址（全局替换，防止出现在查询参数中）
        finalUrl = rawUrl.split(hostname).join(address);
        console.log('[DB] Using IPv4 connection string');
    } catch (e) {
        console.error('[DB] ⚠️  DNS resolution failed:', e.message);
        console.error('[DB] Will try original URL (may ENETUNREACH on Render)');
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
