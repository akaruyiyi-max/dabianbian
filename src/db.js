import { createClient } from '@supabase/supabase-js';

let supabase = null;

/**
 * 初始化数据库（Supabase REST/HTTPS 客户端）。
 *
 * 为什么用 supabase-js 而不是 pg 直连：
 *   Supabase Direct Connection (db.xxx.supabase.co:5432) 与 Transaction Pooler
 *   对该项目都只暴露 IPv6（无 A 记录），而 Render 免费网络不支持 IPv6，
 *   导致 pg 直连始终 ENETUNREACH / ENOTFOUND。
 *
 *   supabase-js 走 HTTPS（PostgREST），目标域名 supabase.co 有 IPv4 地址，
 *   因此在 Render 上可正常连接，彻底绕开 IPv6 问题。
 *
 * 环境变量：
 *   SUPABASE_URL        例如 https://inzuoypiwasnoumspzik.supabase.co
 *   SUPABASE_ANON_KEY   项目 anon public key（仅服务端使用，不暴露给客户端）
 *
 * 说明：本应用所有数据库访问都经由服务端 API，anon key 不会下发到浏览器，
 *       因此可在 Supabase 控制台对 4 张表执行 DISABLE ROW LEVEL SECURITY 后安全使用。
 */
export function initDb() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) {
        throw new Error(
            'SUPABASE_URL 和 SUPABASE_ANON_KEY 环境变量未设置。' +
            '请在 Render / .env 中配置（从 Supabase Dashboard → Settings → API 获取）。'
        );
    }
    console.log('[DB] Supabase URL:', url);
    supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log('[DB] ✅ Supabase client initialized (HTTPS/REST, IPv4-compatible)');
    return supabase;
}

export function getDb() {
    if (!supabase) throw new Error('Database not initialized. Call initDb() first.');
    return supabase;
}

/**
 * 统一错误处理：解构 supabase 返回的 { data, error, count }。
 * 若 error 存在则抛出（打印日志）；否则返回 { data, count }。
 *
 * 用法：
 *   const { data: user } = assertResult(await db.from('users').select('*').eq('id', 1), 'ctx');
 *   const { count } = assertResult(await db.from('x').select('*', { count:'exact', head:true }), 'ctx');
 */
export function assertResult(result, ctx) {
    const { data, error, count } = result;
    if (error) {
        console.error(`[DB] ${ctx}:`, error.message);
        const e = new Error(error.message);
        e.code = error.code;
        throw e;
    }
    return { data, count };
}
