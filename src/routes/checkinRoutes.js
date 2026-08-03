import { Router } from 'express';
import { calculateCurrentStreak, calculateLongestStreak } from '../utils/streak.js';
import { getTodayStr } from '../utils/helpers.js';
import { broadcastDanmakuBatch } from '../sockets/reminderService.js';

export function createCheckinRouter(db, io) {
    const router = Router();

    /**
     * 打卡后更新 streak 和 stats
     */
    async function updateStatsAfterCheckin(userId, checkinDate) {
        // 获取该用户所有去重日期（降序）
        const rows = await db.all(`
            SELECT DISTINCT checkin_date FROM checkins
            WHERE user_id = ? ORDER BY checkin_date DESC
        `, [userId]);
        const dates = rows.map(r => r.checkin_date);

        const currentStreak = calculateCurrentStreak(dates);
        const ascendingDates = [...dates].sort();
        const longestStreak = calculateLongestStreak(ascendingDates);

        const nowUtc = new Date().toISOString();
        // 注意 Postgres 取两值较大用 GREATEST（SQLite 的 MAX(a,b) 标量函数对应物）
        await db.run(`
            UPDATE user_stats
            SET current_streak = ?,
                longest_streak = GREATEST(longest_streak, ?),
                total_checkins = total_checkins + 1,
                last_checkin_time = ?,
                last_reminder_sent = NULL
            WHERE user_id = ?
        `, [currentStreak, longestStreak, nowUtc, userId]);

        const statsRow = await db.get('SELECT total_checkins FROM user_stats WHERE user_id = ?', [userId]);

        return {
            current_streak: currentStreak,
            longest_streak: longestStreak,
            total_checkins: statsRow.total_checkins,
            last_checkin_time: nowUtc,
        };
    }

    /**
     * 获取排行榜数据 — 按今日打卡次数降序排列
     */
    async function getLeaderboard() {
        const today = getTodayStr();
        return db.all(`
            SELECT
                us.user_id,
                u.username,
                u.avatar_emoji,
                us.current_streak,
                us.longest_streak,
                us.total_checkins,
                us.last_checkin_time,
                u.created_at,
                (SELECT COUNT(*) FROM checkins c WHERE c.user_id = us.user_id AND c.checkin_date = ?) AS today_count
            FROM user_stats us
            JOIN users u ON u.id = us.user_id
            ORDER BY today_count DESC, us.current_streak DESC
        `, [today]);
    }

    // POST /api/checkins - 创建打卡
    router.post('/checkins', async (req, res) => {
        const userId = req.user.id;
        const { note, client_date } = req.body;

        // 获取客户端日期
        const checkinDate = (client_date && typeof client_date === 'string') ? client_date : getTodayStr();

        try {
            // 每日打卡次数限制：最多 10 次
            const todayCountRow = await db.get(`
                SELECT COUNT(*) AS cnt FROM checkins WHERE user_id = ? AND checkin_date = ?
            `, [userId, checkinDate]);
            if (todayCountRow.cnt >= 10) {
                return res.json({ limit_reached: true });
            }

            // 校验 note
            let cleanNote = null;
            if (note && typeof note === 'string') {
                cleanNote = note.trim().slice(0, 100);
            }

            const now = new Date().toISOString();
            const result = await db.run(`
                INSERT INTO checkins (user_id, checkin_time, checkin_date, note)
                VALUES (?, ?, ?, ?) RETURNING id
            `, [userId, now, checkinDate, cleanNote]);

            const checkin = await db.get(`
                SELECT c.id, c.user_id, c.checkin_time, c.checkin_date, c.note,
                       u.username, u.avatar_emoji
                FROM checkins c
                JOIN users u ON u.id = c.user_id
                WHERE c.id = ?
            `, [result.lastID]);

            const stats = await updateStatsAfterCheckin(userId, checkinDate);
            const todayCountRow2 = await db.get('SELECT COUNT(*) as c FROM checkins WHERE user_id = ? AND checkin_date = ?', [userId, checkinDate]);

            // 通过 Socket.io 广播给所有在线用户
            if (io) {
                io.emit('checkin:created', { checkin, stats });
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
                // 刷新双规则弹幕（打卡成就次数更新 + 通报批评状态更新）
                await broadcastDanmakuBatch(io, db);
            }

            res.json({ checkin, stats, today_count: todayCountRow2.c });
        } catch (err) {
            console.error('[Checkin] Create error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '打卡失败，请重试' });
        }
    });

    // POST /api/checkins/undo - 撤销今日最近一次打卡（防作弊）
    router.post('/checkins/undo', async (req, res) => {
        const userId = req.user.id;
        const today = getTodayStr();

        try {
            // 找到今日最近一次打卡
            const lastCheckin = await db.get(`
                SELECT id, checkin_time FROM checkins
                WHERE user_id = ? AND checkin_date = ?
                ORDER BY checkin_time DESC LIMIT 1
            `, [userId, today]);

            if (!lastCheckin) {
                return res.json({ success: false, message: '今日无打卡可撤销', today_count: 0 });
            }

            // 删除该打卡记录
            await db.run('DELETE FROM checkins WHERE id = ?', [lastCheckin.id]);

            // 重新计算 streak
            const rows = await db.all(`
                SELECT DISTINCT checkin_date FROM checkins
                WHERE user_id = ? ORDER BY checkin_date DESC
            `, [userId]);
            const dates = rows.map(r => r.checkin_date);

            const currentStreak = calculateCurrentStreak(dates);

            // 获取剩余的最近一次打卡时间
            const lastRemaining = await db.get(`
                SELECT checkin_time FROM checkins
                WHERE user_id = ? ORDER BY checkin_time DESC LIMIT 1
            `, [userId]);

            // 更新统计：total_checkins - 1，更新 streak 和 last_checkin_time
            await db.run(`
                UPDATE user_stats
                SET current_streak = ?,
                    total_checkins = total_checkins - 1,
                    last_checkin_time = ?,
                    last_reminder_sent = NULL
                WHERE user_id = ?
            `, [currentStreak, lastRemaining ? lastRemaining.checkin_time : null, userId]);

            // 获取更新后的 stats
            const stats = await db.get('SELECT * FROM user_stats WHERE user_id = ?', [userId]);
            const todayCountRow = await db.get('SELECT COUNT(*) as c FROM checkins WHERE user_id = ? AND checkin_date = ?', [userId, today]);

            // 广播更新
            if (io) {
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
                await broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, today_count: todayCountRow.c, stats });
        } catch (err) {
            console.error('[Checkin] Undo error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '撤销失败，请重试' });
        }
    });

    // POST /api/checkins/makeup - 补打卡（仅限过去日期）
    router.post('/checkins/makeup', async (req, res) => {
        const userId = req.user.id;
        const { date } = req.body;

        // 校验日期格式 YYYY-MM-DD
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'INVALID_DATE', message: '日期格式无效' });
        }

        const today = getTodayStr();

        // 限制：只能补打过去日期
        if (date >= today) {
            return res.status(400).json({ error: 'DATE_NOT_PAST', message: '只能补打过去的日期' });
        }

        // 限制：只能补打当月日期
        const currentMonth = today.substring(0, 7);
        const targetMonth = date.substring(0, 7);
        if (targetMonth !== currentMonth) {
            return res.status(400).json({ error: 'DATE_NOT_CURRENT_MONTH', message: '只能补打当月日期' });
        }

        try {
            // 检查该日期是否已有打卡记录
            const existingRow = await db.get(`
                SELECT COUNT(*) as cnt FROM checkins
                WHERE user_id = ? AND checkin_date = ?
            `, [userId, date]);
            if (existingRow.cnt > 0) {
                return res.json({ success: false, message: '该日期已有打卡记录' });
            }

            // 插入补打卡记录（用该日期的中午时间作为 checkin_time）
            const makeupTime = `${date}T12:00:00.000Z`;
            await db.run(`
                INSERT INTO checkins (user_id, checkin_time, checkin_date, note)
                VALUES (?, ?, ?, ?)
            `, [userId, makeupTime, date, '补打卡']);

            // 重新计算 streak 和 stats
            const stats = await updateStatsAfterCheckin(userId, date);

            // 广播更新
            if (io) {
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
                await broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, date, stats });
        } catch (err) {
            console.error('[Checkin] Makeup error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '补打卡失败，请重试' });
        }
    });

    // GET /api/checkins/calendar - 获取当月日历打卡数据
    router.get('/checkins/calendar', async (req, res) => {
        const userId = req.user.id;
        const today = getTodayStr();
        const currentMonth = today.substring(0, 7); // YYYY-MM

        try {
            const rows = await db.all(`
                SELECT checkin_date, COUNT(*) as count
                FROM checkins
                WHERE user_id = ? AND checkin_date LIKE ?
                GROUP BY checkin_date
                ORDER BY checkin_date ASC
            `, [userId, `${currentMonth}%`]);

            // 转为 { "2026-07-01": 2, "2026-07-03": 1, ... }
            const dateMap = {};
            for (const row of rows) {
                dateMap[row.checkin_date] = row.count;
            }

            res.json({ dates: dateMap, month: currentMonth });
        } catch (err) {
            console.error('[Checkin] Calendar error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取日历失败' });
        }
    });

    // POST /api/checkins/delete-by-date - 删除指定日期的所有打卡记录（用于删除补打卡）
    router.post('/checkins/delete-by-date', async (req, res) => {
        const userId = req.user.id;
        const { date } = req.body;

        // 校验日期格式
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'INVALID_DATE', message: '日期格式无效' });
        }

        const today = getTodayStr();

        // 只能删除过去日期的记录（不能删今天，今天用undo）
        if (date >= today) {
            return res.status(400).json({ error: 'DATE_NOT_PAST', message: '只能删除过去日期的记录' });
        }

        try {
            // 检查该日期是否有打卡记录
            const existingRow = await db.get(`
                SELECT COUNT(*) as cnt FROM checkins
                WHERE user_id = ? AND checkin_date = ?
            `, [userId, date]);
            if (existingRow.cnt === 0) {
                return res.json({ success: false, message: '该日期无打卡记录' });
            }

            // 删除该日期所有打卡记录
            const deletedResult = await db.run(`
                DELETE FROM checkins WHERE user_id = ? AND checkin_date = ?
            `, [userId, date]);
            const deleted = deletedResult.changes;

            // 重新计算 streak
            const rows = await db.all(`
                SELECT DISTINCT checkin_date FROM checkins
                WHERE user_id = ? ORDER BY checkin_date DESC
            `, [userId]);
            const dates = rows.map(r => r.checkin_date);

            const currentStreak = calculateCurrentStreak(dates);

            // 更新统计
            await db.run(`
                UPDATE user_stats
                SET current_streak = ?,
                    total_checkins = total_checkins - ?,
                    last_reminder_sent = NULL
                WHERE user_id = ?
            `, [currentStreak, deleted, userId]);

            // 获取更新后的 stats
            const stats = await db.get('SELECT * FROM user_stats WHERE user_id = ?', [userId]);

            // 广播更新
            if (io) {
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
                await broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, date, deleted_count: deleted, stats });
        } catch (err) {
            console.error('[Checkin] Delete by date error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '删除失败，请重试' });
        }
    });

    // GET /api/checkins/monthly-report - 获取当月统计月报
    router.get('/checkins/monthly-report', async (req, res) => {
        const userId = req.user.id;
        const today = getTodayStr();
        const currentMonth = today.substring(0, 7); // YYYY-MM

        try {
            // 当月总打卡次数
            const totalRow = await db.get(`
                SELECT COUNT(*) as total FROM checkins
                WHERE user_id = ? AND checkin_date LIKE ?
            `, [userId, `${currentMonth}%`]);

            // 当月各日期打卡次数
            const dailyRows = await db.all(`
                SELECT checkin_date, COUNT(*) as count
                FROM checkins
                WHERE user_id = ? AND checkin_date LIKE ?
                GROUP BY checkin_date
                ORDER BY checkin_date ASC
            `, [userId, `${currentMonth}%`]);

            // 当月天数
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const currentDay = now.getDate();

            // 统计数据
            const totalCount = totalRow.total;
            const daysWithCheckins = dailyRows.length;
            const dailyAverage = (totalCount / currentDay).toFixed(1);
            const fullnessRate = ((daysWithCheckins / currentDay) * 100).toFixed(0);

            // 找出最高日
            let maxDay = null;
            let maxCount = 0;
            for (const row of dailyRows) {
                if (row.count > maxCount) {
                    maxCount = row.count;
                    maxDay = row.checkin_date;
                }
            }

            // 生成每日数据数组（用于趋势图）
            const dailyData = [];
            for (const row of dailyRows) {
                const day = parseInt(row.checkin_date.split('-')[2], 10);
                dailyData.push({ day, count: row.count, date: row.checkin_date });
            }

            // 连续打卡天数统计
            const stats = await db.get('SELECT current_streak, longest_streak FROM user_stats WHERE user_id = ?', [userId]);

            res.json({
                month: currentMonth,
                total_count: totalCount,
                days_with_checkins: daysWithCheckins,
                days_in_month: daysInMonth,
                current_day: currentDay,
                daily_average: parseFloat(dailyAverage),
                fullness_rate: parseInt(fullnessRate),
                max_day: maxDay,
                max_count: maxCount,
                daily_data: dailyData,
                current_streak: stats?.current_streak || 0,
                longest_streak: stats?.longest_streak || 0,
            });
        } catch (err) {
            console.error('[Checkin] Monthly report error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取月报失败' });
        }
    });

    // GET /api/checkins - 获取当前用户的打卡历史
    router.get('/checkins', async (req, res) => {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = parseInt(req.query.offset || '0', 10);

        try {
            const checkins = await db.all(`
                SELECT c.id, c.checkin_time, c.checkin_date, c.note
                FROM checkins c
                WHERE c.user_id = ?
                ORDER BY c.checkin_time DESC
                LIMIT ? OFFSET ?
            `, [userId, limit, offset]);

            const totalRow = await db.get('SELECT COUNT(*) as count FROM checkins WHERE user_id = ?', [userId]);

            res.json({ checkins, total: totalRow.count });
        } catch (err) {
            console.error('[Checkin] History error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取历史失败' });
        }
    });

    // GET /api/checkins/all - 获取所有用户今日打卡记录（仅当日数据）
    router.get('/checkins/all', async (req, res) => {
        const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
        const offset = parseInt(req.query.offset || '0', 10);
        const today = getTodayStr();

        try {
            const checkins = await db.all(`
                SELECT c.id, c.user_id, c.checkin_time, c.checkin_date, c.note,
                       u.username, u.avatar_emoji
                FROM checkins c
                JOIN users u ON u.id = c.user_id
                WHERE c.checkin_date = ?
                ORDER BY c.checkin_time DESC
                LIMIT ? OFFSET ?
            `, [today, limit, offset]);

            const totalRow = await db.get('SELECT COUNT(*) as count FROM checkins WHERE checkin_date = ?', [today]);

            res.json({ checkins, total: totalRow.count });
        } catch (err) {
            console.error('[Checkin] All checkins error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取打卡列表失败' });
        }
    });

    // DELETE /api/checkins/:id - 删除自己的打卡记录
    router.delete('/checkins/:id', async (req, res) => {
        const userId = req.user.id;
        const checkinId = parseInt(req.params.id, 10);

        try {
            const checkin = await db.get('SELECT * FROM checkins WHERE id = ? AND user_id = ?', [checkinId, userId]);
            if (!checkin) {
                return res.status(404).json({ error: 'NOT_FOUND', message: '打卡记录不存在或不属于你' });
            }

            await db.run('DELETE FROM checkins WHERE id = ?', [checkinId]);

            // 重新计算 streak
            const rows = await db.all(`
                SELECT DISTINCT checkin_date FROM checkins
                WHERE user_id = ? ORDER BY checkin_date DESC
            `, [userId]);
            const dates = rows.map(r => r.checkin_date);

            const currentStreak = calculateCurrentStreak(dates);
            const ascendingDates = [...dates].sort();
            const longestStreak = calculateLongestStreak(ascendingDates);

            await db.run(`
                UPDATE user_stats
                SET current_streak = ?,
                    longest_streak = GREATEST(longest_streak, ?),
                    total_checkins = total_checkins - 1
                WHERE user_id = ?
            `, [currentStreak, longestStreak, userId]);

            if (io) {
                io.emit('checkin:deleted', { checkin_id: checkinId, user_id: userId });
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[Checkin] Delete error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '删除失败，请重试' });
        }
    });

    // GET /api/leaderboard - 排行榜
    router.get('/leaderboard', async (req, res) => {
        try {
            res.json({ leaderboard: await getLeaderboard() });
        } catch (err) {
            console.error('[Checkin] Leaderboard error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取排行榜失败' });
        }
    });

    // GET /api/stats/:username - 指定用户统计
    router.get('/stats/:username', async (req, res) => {
        try {
            const user = await db.get('SELECT id, username, avatar_emoji, created_at FROM users WHERE username = ?', [req.params.username]);
            if (!user) {
                return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
            }
            const stats = await db.get('SELECT * FROM user_stats WHERE user_id = ?', [user.id]);
            const recentCheckins = await db.all(`
                SELECT checkin_time, checkin_date, note
                FROM checkins WHERE user_id = ?
                ORDER BY checkin_time DESC LIMIT 10
            `, [user.id]);

            res.json({ user, stats, recent_checkins: recentCheckins });
        } catch (err) {
            console.error('[Checkin] Stats error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取统计失败' });
        }
    });

    return router;
}
