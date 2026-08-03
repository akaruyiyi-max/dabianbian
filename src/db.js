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
 * 通过 Google DNS-over-HTTPS API 查询 A 记录（IPv4）。
 * 完全不依赖 Node.js dns 模块（在 Render 上 lookup/resolve4 均不可靠）。
 */
async function resolveIPv4ViaDoH(hostname) {
    // Google DoH: https://dns.google/resolve?name=HOST&type=A
    const dohUrl = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`;
    console.log(`[DB] Querying Google DoH for ${hostname}...`);

    try {
        const res = await fetch(dohUrl, {
            headers: { Accept: 'application/dns-json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.Answer && Array.isArray(data.Answer)) {
            // A 记录的 type = 1
            const aRecord = data.Answer.find(r => r.type === 1);
            if (aRecord && aRecord.data) {
                console.log(`[DB] ✅ DoH: ${hostname} -> ${aRecord.data} (IPv4)`);
                return aRecord.data;
            }
        }
        throw new Error('No A record in response');
    } catch (e) {
        console.error(`[DB] Google DoH failed: ${e.message}`);
        throw e;
    }
}

/**
 * 初始化数据库（Supabase Postgres）。
 *
 * 异步函数：通过 DNS-over-HTTPS 获取 Supabase 主机名的 IPv4 地址，
 * 替换连接串中的主机名后创建 Pool。彻底绕过 node-postgres/libpq 的 IPv6 问题。
 *
 * 问题链：
 *   Supabase DNS 返回 AAAA → Render 不支持 IPv6 → ENETUNREACH
 *   family:4 被 libpq 忽略
 *   dns.lookupSync 在 ESM 下不是函数
 *   dns.promises.lookup/resolve4 在 Render 上 ENOTFOUND
 *
 * 最终方案：Google DoH API (HTTPS) 查 IPv4 → 替换连接串主机名
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

    const urlObj = new URL(rawUrl);
    const hostname = urlObj.hostname;

    let finalUrl = rawUrl;
    try {
        const ipv4 = await resolveIPv4ViaDoH(hostname);

        // 将连接串中所有出现的主机名替换为 IPv4 IP
        finalUrl = rawUrl.split(hostname).join(ipv4);
        console.log('[DB] ✅ Using forced-IPv4 connection string');
    } catch (e) {
        console.error('[DB] ⚠️  All IPv4 resolution methods failed:', e.message);
        console.error('[DB] ⚠️  Proceeding with original URL — expect ENETUNREACH');
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
