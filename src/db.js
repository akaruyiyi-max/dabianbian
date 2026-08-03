import pg from 'pg';
import * as dns from 'node:dns';
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
 * 通过环境变量 DATABASE_URL 读取连接串，例如：
 *   postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
 *
 * 重要：启动时会将主机名同步解析为 IPv4 地址，替换回连接串后再建池。
 *       原因：Supabase DNS 返回 AAAA (IPv6)，Render 免费网络不支持 IPv6，
 *             导致 ENETUNREACH。Pool 的 family:4 对 connectionString 模式不生效，
 *             必须手动 DNS 解析替换才能保证走 IPv4。
 */
export function initDb() {
    const rawUrl = process.env.DATABASE_URL;
    if (rawUrl) {
        const masked = rawUrl.replace(/\/\/([^:]+):([^@]+)@/, '//\$1:****@');
        console.log('[DB] DATABASE_URL (masked):', masked);
    } else {
        console.error('[DB] ⚠️  DATABASE_URL is EMPTY or UNDEFINED!');
    }
    if (!rawUrl) {
        throw new Error(
            'DATABASE_URL 环境变量未设置。请配置 Supabase Postgres 连接串（见 .env.example）'
        );
    }

    // 解析连接串中的主机名，强制 DNS 解析为纯 IPv4 地址
    // 关键：必须用 { family: 4 } 严格请求 A 记录，不能用 V4MAPPED（会返回 IPv4-mapped IPv6）
    let connectionString = rawUrl;
    try {
        const urlObj = new URL(rawUrl);
        const hostname = urlObj.hostname;
        console.log(`[DB] Resolving hostname: ${hostname}`);
        // { family: 4 } = 仅返回 IPv4 地址（A 记录）
        const { address } = dns.lookupSync(hostname, { family: 4 });
        console.log(`[DB] DNS result: ${hostname} -> ${address}`);
        if (address && !address.includes(':')) {
            connectionString = rawUrl.replace(hostname, address);
            console.log(`[DB] ✅ Forced IPv4 connection: ${hostname} -> ${address}`);
        } else {
            console.error(`[DB] ⚠️  DNS returned non-IPv4: ${address}, will try anyway`);
        }
    } catch (e) {
        console.error('[DB] ⚠️  DNS resolution FAILED:', e.message);
        console.error('[DB] Continuing with original URL (may fail on IPv6-only networks)');
    }

    pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle Postgres client:', err.message);
    });

    console.log('[DB] Postgres pool initialized (Supabase, forced IPv4)');
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
