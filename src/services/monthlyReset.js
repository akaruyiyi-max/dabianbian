import { getTodayStr } from '../utils/helpers.js';

/**
 * 每月 1 号自动清空并重置所有打卡数据
 *
 * 逻辑：
 *   - 检查今天是否是某月 1 号
 *   - 若是且本月尚未执行过重置 → 清空 checkins 表，重置 user_stats
 *   - 用 meta 表的 last_monthly_reset 记录上次重置月份（YYYY-MM），防止重复执行
 *
 * 调用时机：
 *   - 服务器启动时立即检查一次
 *   - 之后每小时检查一次（覆盖跨午夜场景）
 */

/**
 * 执行每月重置检查
 */
export function checkMonthlyReset(db) {
    const now = new Date();
    const day = now.getDate();

    // 只有每月 1 号才触发
    if (day !== 1) return;

    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 读取上次重置月份
    const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_monthly_reset');
    if (meta && meta.value === currentMonth) {
        // 本月已重置过
        return;
    }

    performMonthlyReset(db, currentMonth);
}

/**
 * 执行实际的重置操作
 */
function performMonthlyReset(db, resetMonth) {
    console.log(`[MonthlyReset] 开始执行 ${resetMonth} 月数据重置...`);

    try {
        const txn = db.transaction(() => {
            // 1. 清空所有打卡记录
            const deletedCount = db.prepare('DELETE FROM checkins').run().changes;

            // 2. 重置所有用户统计
            const resetCount = db.prepare(`
                UPDATE user_stats
                SET current_streak = 0,
                    longest_streak = 0,
                    total_checkins = 0,
                    last_checkin_time = NULL,
                    last_reminder_sent = NULL
            `).run().changes;

            // 3. 重置自增序列
            db.prepare("DELETE FROM sqlite_sequence WHERE name = 'checkins'").run();

            // 4. 记录重置月份
            db.prepare(`
                INSERT INTO meta (key, value) VALUES ('last_monthly_reset', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `).run(resetMonth);
        });

        txn();
        console.log(`[MonthlyReset] ${resetMonth} 月数据重置完成，所有打卡记录已清空`);
    } catch (err) {
        console.error('[MonthlyReset] 重置失败:', err);
    }
}

/**
 * 启动每月重置定时检查
 */
export function startMonthlyResetService(db) {
    // 启动时立即检查一次
    checkMonthlyReset(db);

    // 每小时检查一次（覆盖服务器跨午夜运行场景）
    setInterval(() => {
        checkMonthlyReset(db);
    }, 3600000);

    console.log('[MonthlyReset] Service started, checking every hour');
}
