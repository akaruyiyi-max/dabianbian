import { Router } from 'express';
import { calculateCurrentStreak, calculateLongestStreak } from '../utils/streak.js';
import { getTodayStr } from '../utils/helpers.js';
import { broadcastDanmakuBatch } from '../sockets/reminderService.js';

export function createCheckinRouter(db, io) {
    const router = Router();

    /**
     * 打卡后更新 streak 和 stats
     */
    function updateStatsAfterCheckin(userId, checkinDate) {
        // 获取该用户所有去重日期（降序）
        const dates = db.prepare(`
            SELECT DISTINCT checkin_date FROM checkins
            WHERE user_id = ? ORDER BY checkin_date DESC
        `).all(userId).map(r => r.checkin_date);

        const currentStreak = calculateCurrentStreak(dates);
        const ascendingDates = [...dates].sort();
        const longestStreak = calculateLongestStreak(ascendingDates);

        const nowUtc = new Date().toISOString();
        db.prepare(`
            UPDATE user_stats
            SET current_streak = ?,
                longest_streak = MAX(longest_streak, ?),
                total_checkins = total_checkins + 1,
                last_checkin_time = ?,
                last_reminder_sent = NULL
            WHERE user_id = ?
        `).run(currentStreak, longestStreak, nowUtc, userId);

        return {
            current_streak: currentStreak,
            longest_streak: longestStreak,
            total_checkins: db.prepare('SELECT total_checkins FROM user_stats WHERE user_id = ?').get(userId).total_checkins,
            last_checkin_time: nowUtc,
        };
    }

    /**
     * 获取排行榜数据 — 按今日打卡次数降序排列
     */
    function getLeaderboard() {
        const today = getTodayStr();
        return db.prepare(`
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
        `).all(today);
    }

    // POST /api/checkins - 创建打卡
    router.post('/checkins', (req, res) => {
        const userId = req.user.id;
        const { note, client_date } = req.body;

        // 获取客户端日期
        const checkinDate = (client_date && typeof client_date === 'string') ? client_date : getTodayStr();

        // 每日打卡次数限制：最多 10 次
        const todayCount = db.prepare(`
            SELECT COUNT(*) AS cnt FROM checkins WHERE user_id = ? AND checkin_date = ?
        `).get(userId, checkinDate).cnt;
        if (todayCount >= 10) {
            return res.json({ limit_reached: true });
        }

        // 校验 note
        let cleanNote = null;
        if (note && typeof note === 'string') {
            cleanNote = note.trim().slice(0, 100);
        }

        try {
            const now = new Date().toISOString();
            const result = db.prepare(`
                INSERT INTO checkins (user_id, checkin_time, checkin_date, note)
                VALUES (?, ?, ?, ?)
            `).run(userId, now, checkinDate, cleanNote);

            const checkin = db.prepare(`
                SELECT c.id, c.user_id, c.checkin_time, c.checkin_date, c.note,
                       u.username, u.avatar_emoji
                FROM checkins c
                JOIN users u ON u.id = c.user_id
                WHERE c.id = ?
            `).get(result.lastInsertRowid);

            const stats = updateStatsAfterCheckin(userId, checkinDate);
            const todayCount = db.prepare('SELECT COUNT(*) as c FROM checkins WHERE user_id = ? AND checkin_date = ?').get(userId, checkinDate).c;

            // 通过 Socket.io 广播给所有在线用户
            if (io) {
                io.emit('checkin:created', { checkin, stats });
                io.emit('leaderboard:update', { leaderboard: getLeaderboard() });
                // 刷新双规则弹幕（打卡成就次数更新 + 通报批评状态更新）
                broadcastDanmakuBatch(io, db);
            }

            res.json({ checkin, stats, today_count: todayCount });
        } catch (err) {
            console.error('[Checkin] Create error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '打卡失败，请重试' });
        }
    });

    // POST /api/checkins/undo - 撤销今日最近一次打卡（防作弊）
    router.post('/checkins/undo', (req, res) => {
        const userId = req.user.id;
        const today = getTodayStr();

        try {
            // 找到今日最近一次打卡
            const lastCheckin = db.prepare(`
                SELECT id, checkin_time FROM checkins
                WHERE user_id = ? AND checkin_date = ?
                ORDER BY checkin_time DESC LIMIT 1
            `).get(userId, today);

            if (!lastCheckin) {
                return res.json({ success: false, message: '今日无打卡可撤销', today_count: 0 });
            }

            // 删除该打卡记录
            db.prepare('DELETE FROM checkins WHERE id = ?').run(lastCheckin.id);

            // 重新计算 streak
            const dates = db.prepare(`
                SELECT DISTINCT checkin_date FROM checkins
                WHERE user_id = ? ORDER BY checkin_date DESC
            `).all(userId).map(r => r.checkin_date);

            const currentStreak = calculateCurrentStreak(dates);

            // 获取剩余的最近一次打卡时间
            const lastRemaining = db.prepare(`
                SELECT checkin_time FROM checkins
                WHERE user_id = ? ORDER BY checkin_time DESC LIMIT 1
            `).get(userId);

            // 更新统计：total_checkins - 1，更新 streak 和 last_checkin_time
            db.prepare(`
                UPDATE user_stats
                SET current_streak = ?,
                    total_checkins = total_checkins - 1,
                    last_checkin_time = ?,
                    last_reminder_sent = NULL
                WHERE user_id = ?
            `).run(currentStreak, lastRemaining ? lastRemaining.checkin_time : null, userId);

            // 获取更新后的 stats
            const stats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(userId);
            const todayCount = db.prepare('SELECT COUNT(*) as c FROM checkins WHERE user_id = ? AND checkin_date = ?').get(userId, today).c;

            // 广播更新
            if (io) {
                io.emit('leaderboard:update', { leaderboard: getLeaderboard() });
                broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, today_count: todayCount, stats });
        } catch (err) {
            console.error('[Checkin] Undo error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '撤销失败，请重试' });
        }
    });

    // POST /api/checkins/makeup - 补打卡（仅限过去日期）
    router.post('/checkins/makeup', (req, res) => {
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
            const existing = db.prepare(`
                SELECT COUNT(*) as cnt FROM checkins
                WHERE user_id = ? AND checkin_date = ?
            `).get(userId, date).cnt;

            if (existing > 0) {
                return res.json({ success: false, message: '该日期已有打卡记录' });
            }

            // 插入补打卡记录（用该日期的中午时间作为 checkin_time）
            const makeupTime = `${date}T12:00:00.000Z`;
            db.prepare(`
                INSERT INTO checkins (user_id, checkin_time, checkin_date, note)
                VALUES (?, ?, ?, ?)
            `).run(userId, makeupTime, date, '\u8865\u6253\u5361');

            // 重新计算 streak 和 stats
            const stats = updateStatsAfterCheckin(userId, date);

            // 广播更新
            if (io) {
                io.emit('leaderboard:update', { leaderboard: getLeaderboard() });
                broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, date, stats });
        } catch (err) {
            console.error('[Checkin] Makeup error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '补打卡失败，请重试' });
        }
    });

    // GET /api/checkins/calendar - 获取当月日历打卡数据
    router.get('/checkins/calendar', (req, res) => {
        const userId = req.user.id;
        const today = getTodayStr();
        const currentMonth = today.substring(0, 7); // YYYY-MM

        const rows = db.prepare(`
            SELECT checkin_date, COUNT(*) as count
            FROM checkins
            WHERE user_id = ? AND checkin_date LIKE ?
            GROUP BY checkin_date
            ORDER BY checkin_date ASC
        `).all(userId, `${currentMonth}%`);

        // 转为 { "2026-07-01": 2, "2026-07-03": 1, ... }
        const dateMap = {};
        for (const row of rows) {
            dateMap[row.checkin_date] = row.count;
        }

        res.json({ dates: dateMap, month: currentMonth });
    });

    // POST /api/checkins/delete-by-date - 删除指定日期的所有打卡记录（用于删除补打卡）
    router.post('/checkins/delete-by-date', (req, res) => {
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
            const existing = db.prepare(`
                SELECT COUNT(*) as cnt FROM checkins
                WHERE user_id = ? AND checkin_date = ?
            `).get(userId, date).cnt;

            if (existing === 0) {
                return res.json({ success: false, message: '该日期无打卡记录' });
            }

            // 删除该日期所有打卡记录
            const deleted = db.prepare(`
                DELETE FROM checkins WHERE user_id = ? AND checkin_date = ?
            `).run(userId, date).changes;

            // 重新计算 streak
            const dates = db.prepare(`
                SELECT DISTINCT checkin_date FROM checkins
                WHERE user_id = ? ORDER BY checkin_date DESC
            `).all(userId).map(r => r.checkin_date);

            const currentStreak = calculateCurrentStreak(dates);

            // 更新统计
            db.prepare(`
                UPDATE user_stats
                SET current_streak = ?,
                    total_checkins = total_checkins - ?,
                    last_reminder_sent = NULL
                WHERE user_id = ?
            `).run(currentStreak, deleted, userId);

            // 获取更新后的 stats
            const stats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(userId);

            // 广播更新
            if (io) {
                io.emit('leaderboard:update', { leaderboard: getLeaderboard() });
                broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, date, deleted_count: deleted, stats });
        } catch (err) {
            console.error('[Checkin] Delete by date error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '删除失败，请重试' });
        }
    });

    // GET /api/checkins/monthly-report - 获取当月统计月报
    router.get('/checkins/monthly-report', (req, res) => {
        const userId = req.user.id;
        const today = getTodayStr();
        const currentMonth = today.substring(0, 7); // YYYY-MM

        // 当月总打卡次数
        const totalRow = db.prepare(`
            SELECT COUNT(*) as total FROM checkins
            WHERE user_id = ? AND checkin_date LIKE ?
        `).get(userId, `${currentMonth}%`);

        // 当月各日期打卡次数
        const dailyRows = db.prepare(`
            SELECT checkin_date, COUNT(*) as count
            FROM checkins
            WHERE user_id = ? AND checkin_date LIKE ?
            GROUP BY checkin_date
            ORDER BY checkin_date ASC
        `).all(userId, `${currentMonth}%`);

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
        const stats = db.prepare('SELECT current_streak, longest_streak FROM user_stats WHERE user_id = ?').get(userId);

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
    });

    // GET /api/checkins - 获取当前用户的打卡历史
    router.get('/checkins', (req, res) => {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = parseInt(req.query.offset || '0', 10);

        const checkins = db.prepare(`
            SELECT c.id, c.checkin_time, c.checkin_date, c.note
            FROM checkins c
            WHERE c.user_id = ?
            ORDER BY c.checkin_time DESC
            LIMIT ? OFFSET ?
        `).all(userId, limit, offset);

        const total = db.prepare('SELECT COUNT(*) as count FROM checkins WHERE user_id = ?').get(userId).count;

        res.json({ checkins, total });
    });

    // GET /api/checkins/all - 获取所有用户今日打卡记录（仅当日数据）
    router.get('/checkins/all', (req, res) => {
        const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
        const offset = parseInt(req.query.offset || '0', 10);
        const today = getTodayStr();

        const checkins = db.prepare(`
            SELECT c.id, c.user_id, c.checkin_time, c.checkin_date, c.note,
                   u.username, u.avatar_emoji
            FROM checkins c
            JOIN users u ON u.id = c.user_id
            WHERE c.checkin_date = ?
            ORDER BY c.checkin_time DESC
            LIMIT ? OFFSET ?
        `).all(today, limit, offset);

        const total = db.prepare('SELECT COUNT(*) as count FROM checkins WHERE checkin_date = ?').get(today).count;

        res.json({ checkins, total });
    });

    // DELETE /api/checkins/:id - 删除自己的打卡记录
    router.delete('/checkins/:id', (req, res) => {
        const userId = req.user.id;
        const checkinId = parseInt(req.params.id, 10);

        const checkin = db.prepare('SELECT * FROM checkins WHERE id = ? AND user_id = ?').get(checkinId, userId);
        if (!checkin) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '打卡记录不存在或不属于你' });
        }

        db.prepare('DELETE FROM checkins WHERE id = ?').run(checkinId);

        // 重新计算 streak
        const dates = db.prepare(`
            SELECT DISTINCT checkin_date FROM checkins
            WHERE user_id = ? ORDER BY checkin_date DESC
        `).all(userId).map(r => r.checkin_date);

        const currentStreak = calculateCurrentStreak(dates);
        const ascendingDates = [...dates].sort();
        const longestStreak = calculateLongestStreak(ascendingDates);

        db.prepare(`
            UPDATE user_stats
            SET current_streak = ?,
                total_checkins = total_checkins - 1
            WHERE user_id = ?
        `).run(currentStreak, userId);

        if (io) {
            io.emit('checkin:deleted', { checkin_id: checkinId, user_id: userId });
            io.emit('leaderboard:update', { leaderboard: getLeaderboard() });
        }

        res.json({ success: true });
    });

    // GET /api/leaderboard - 排行榜
    router.get('/leaderboard', (req, res) => {
        res.json({ leaderboard: getLeaderboard() });
    });

    // GET /api/stats/:username - 指定用户统计
    router.get('/stats/:username', (req, res) => {
        const user = db.prepare('SELECT id, username, avatar_emoji, created_at FROM users WHERE username = ?').get(req.params.username);
        if (!user) {
            return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
        }
        const stats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(user.id);
        const recentCheckins = db.prepare(`
            SELECT checkin_time, checkin_date, note
            FROM checkins WHERE user_id = ?
            ORDER BY checkin_time DESC LIMIT 10
        `).all(user.id);

        res.json({ user, stats, recent_checkins: recentCheckins });
    });

    return router;
}
