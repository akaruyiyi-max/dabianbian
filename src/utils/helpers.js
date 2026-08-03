/**
 * 日期工具函数
 */

/**
 * 解析数据库中的时间字符串为 Date 对象（统一处理时区问题）
 * - ISO 格式 (含 T 和 Z): "2026-07-30T04:20:10.690Z" → 直接解析
 * - SQLite datetime('now') 格式 (空格分隔, 无 Z): "2026-07-30 04:19:59" → 视为 UTC
 * @param {string|null} str - 时间字符串
 * @returns {Date|null}
 */
export function parseDbDate(str) {
    if (!str) return null;
    if (str.includes('T')) return new Date(str);
    return new Date(str.replace(' ', 'T') + 'Z');
}

/**
 * 格式化 Date 为 'YYYY-MM-DD'
 */
export function formatDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 在日期字符串上加/减天数，返回 'YYYY-MM-DD'
 */
export function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return formatDateStr(d);
}

/**
 * 获取客户端本地日期 'YYYY-MM-DD'
 */
export function getTodayStr() {
    return formatDateStr(new Date());
}

/**
 * 获取昨天的日期 'YYYY-MM-DD'
 */
export function getYesterdayStr() {
    return formatDateStr(new Date(Date.now() - 86400000));
}

/**
 * 计算超时天数 N
 * @param {string|null} lastCheckinTime - 最近打卡 UTC 时间
 * @param {string} createdAt - 用户注册 UTC 时间
 * @returns {number} 超时天数，至少 1
 */
export function calculateDaysOverdue(lastCheckinTime, createdAt) {
    const baseline = lastCheckinTime || createdAt;
    const elapsedMs = Date.now() - parseDbDate(baseline).getTime();
    const days = Math.floor(elapsedMs / 86400000);
    return Math.max(1, days);
}

/**
 * 将 UTC 时间字符串转为友好的相对时间描述
 */
export function timeAgo(utcTimeStr) {
    if (!utcTimeStr) return '从未';
    const diff = Date.now() - parseDbDate(utcTimeStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return parseDbDate(utcTimeStr).toLocaleDateString('zh-CN');
}
