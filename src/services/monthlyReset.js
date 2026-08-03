import { assertResult } from '../db.js';

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

export async function checkMonthlyReset(db) {
    const now = new Date();
    const day = now.getDate();

    // 只有每月 1 号才触发
    if (day !== 1) return;

    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 读取上次重置月份
    const { data: meta } = assertResult(
        await db.from('meta').select('value').eq('key', 'last_monthly_reset').maybeSingle(),
        'monthly meta'
    );
    if (meta && meta.value === currentMonth) {
        // 本月已重置过
        return;
    }

    await performMonthlyReset(db, currentMonth);
}

async function performMonthlyReset(db, resetMonth) {
    console.log(`[MonthlyReset] 开始执行 ${resetMonth} 月数据重置...`);

    try {
        // 1. 清空所有打卡记录
        const { count: deletedCount } = assertResult(
            await db.from('checkins').delete({ count: 'exact' }).gte('id', 0),
            'monthly delete checkins'
        );

        // 2. 重置所有用户统计（gte('user_id', 0) 匹配全部）
        await db.from('user_stats').update({
            current_streak: 0,
            longest_streak: 0,
            total_checkins: 0,
            last_checkin_time: null,
            last_reminder_sent: null,
        }).gte('user_id', 0);

        // 3. 记录重置月份
        await db.from('meta').upsert({ key: 'last_monthly_reset', value: resetMonth }, { onConflict: 'key' });

        console.log(`[MonthlyReset] ${resetMonth} 月数据重置完成，清空打卡 ${deletedCount ?? 0} 条`);
    } catch (err) {
        console.error('[MonthlyReset] 重置失败:', err);
    }
}

/**
 * 启动每月重置定时检查
 */
export function startMonthlyResetService(db) {
    checkMonthlyReset(db).catch((e) => console.error('[MonthlyReset] 启动检查异常:', e));

    setInterval(() => {
        checkMonthlyReset(db).catch((e) => console.error('[MonthlyReset] 定时检查异常:', e));
    }, 3600000);

    console.log('[MonthlyReset] Service started, checking every hour');
}
