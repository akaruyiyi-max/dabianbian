import { Router } from 'express';
import { calculateCurrentStreak, calculateLongestStreak } from '../utils/streak.js';
import { getTodayStr } from '../utils/helpers.js';
import { broadcastDanmakuBatch } from '../sockets/reminderService.js';
import { assertResult } from '../db.js';

export function createCheckinRouter(db, io) {
    const router = Router();

    /**
     * 打卡后更新 streak 和 stats
     */
    async function updateStatsAfterCheckin(userId, checkinDate) {
        const { data: rows } = assertResult(
            await db.from('checkins').select('checkin_date').eq('user_id', userId),
            'updateStats dates'
        );
        const dates = rows.map(r => r.checkin_date);

        const currentStreak = calculateCurrentStreak(dates);
        const ascendingDates = [...dates].sort();
        const longestStreak = calculateLongestStreak(ascendingDates);

        const nowUtc = new Date().toISOString();

        const { data: cur } = assertResult(
            await db.from('user_stats').select('longest_streak, total_checkins').eq('user_id', userId).maybeSingle(),
            'updateStats cur'
        );
        const newLongest = Math.max(cur?.longest_streak || 0, longestStreak);
        const newTotal = (cur?.total_checkins || 0) + 1;

        await db.from('user_stats').update({
            current_streak: currentStreak,
            longest_streak: newLongest,
            total_checkins: newTotal,
            last_checkin_time: nowUtc,
            last_reminder_sent: null,
        }).eq('user_id', userId);

        return {
            current_streak: currentStreak,
            longest_streak: newLongest,
            total_checkins: newTotal,
            last_checkin_time: nowUtc,
        };
    }

    /**
     * 把 checkins 嵌入式查询结果扁平化为原 JOIN 形状
     */
    function flattenCheckin(raw) {
        return {
            id: raw.id,
            user_id: raw.user_id,
            checkin_time: raw.checkin_time,
            checkin_date: raw.checkin_date,
            note: raw.note,
            username: raw.users?.username,
            avatar_emoji: raw.users?.avatar_emoji,
        };
    }

    /**
     * 获取排行榜数据 — 按今日打卡次数降序排列
     */
    async function getLeaderboard() {
        const today = getTodayStr();
        const { data: stats } = assertResult(
            await db.from('user_stats').select('user_id, current_streak, longest_streak, total_checkins, last_checkin_time, users(username, avatar_emoji, created_at)'),
            'leaderboard stats'
        );
        const { data: todayRows } = assertResult(
            await db.from('checkins').select('user_id').eq('checkin_date', today),
            'leaderboard today'
        );
        const todayCounts = {};
        for (const r of todayRows) {
            todayCounts[r.user_id] = (todayCounts[r.user_id] || 0) + 1;
        }
        const leaderboard = stats.map(s => ({
            user_id: s.user_id,
            username: s.users?.username,
            avatar_emoji: s.users?.avatar_emoji,
            current_streak: s.current_streak,
            longest_streak: s.longest_streak,
            total_checkins: s.total_checkins,
            last_checkin_time: s.last_checkin_time,
            created_at: s.users?.created_at,
            today_count: todayCounts[s.user_id] || 0,
        }));
        leaderboard.sort((a, b) => b.today_count - a.today_count || b.current_streak - a.current_streak);
        return leaderboard;
    }

    // POST /api/checkins - 创建打卡
    router.post('/checkins', async (req, res) => {
        const userId = req.user.id;
        const { note, client_date } = req.body;

        const checkinDate = (client_date && typeof client_date === 'string') ? client_date : getTodayStr();

        try {
            // 每日打卡次数限制：最多 10 次
            const { count: todayCnt } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('checkin_date', checkinDate),
                'checkin count'
            );
            if ((todayCnt || 0) >= 10) {
                return res.json({ limit_reached: true });
            }

            // 校验 note
            let cleanNote = null;
            if (note && typeof note === 'string') {
                cleanNote = note.trim().slice(0, 100);
            }

            const now = new Date().toISOString();
            const { data: inserted } = assertResult(
                await db.from('checkins').insert({ user_id: userId, checkin_time: now, checkin_date: checkinDate, note: cleanNote }).select('id').single(),
                'checkin insert'
            );

            const { data: rawCheckin } = assertResult(
                await db.from('checkins').select('id, user_id, checkin_time, checkin_date, note, users(username, avatar_emoji)').eq('id', inserted.id).single(),
                'checkin find'
            );
            const checkin = flattenCheckin(rawCheckin);

            const stats = await updateStatsAfterCheckin(userId, checkinDate);
            const { count: todayCount2 } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('checkin_date', checkinDate),
                'checkin today count'
            );

            // 通过 Socket.io 广播给所有在线用户
            if (io) {
                io.emit('checkin:created', { checkin, stats });
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
                await broadcastDanmakuBatch(io, db);
            }

            res.json({ checkin, stats, today_count: todayCount2 || 0 });
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
            const { data: lastRows } = assertResult(
                await db.from('checkins').select('id, checkin_time').eq('user_id', userId).eq('checkin_date', today).order('checkin_time', { ascending: false }).limit(1),
                'undo find last'
            );

            if (!lastRows || lastRows.length === 0) {
                return res.json({ success: false, message: '今日无打卡可撤销', today_count: 0 });
            }

            const lastCheckin = lastRows[0];
            await db.from('checkins').delete().eq('id', lastCheckin.id);

            // 重新计算 streak
            const { data: rows } = assertResult(
                await db.from('checkins').select('checkin_date').eq('user_id', userId),
                'undo dates'
            );
            const dates = rows.map(r => r.checkin_date);
            const currentStreak = calculateCurrentStreak(dates);

            // 获取剩余的最近一次打卡时间
            const { data: remainingRows } = assertResult(
                await db.from('checkins').select('checkin_time').eq('user_id', userId).order('checkin_time', { ascending: false }).limit(1),
                'undo last remaining'
            );
            const lastRemaining = (remainingRows && remainingRows.length > 0) ? remainingRows[0] : null;

            // 更新统计：total_checkins - 1
            const { data: cur } = assertResult(
                await db.from('user_stats').select('total_checkins').eq('user_id', userId).maybeSingle(),
                'undo cur'
            );
            const newTotal = Math.max(0, (cur?.total_checkins || 0) - 1);
            await db.from('user_stats').update({
                current_streak: currentStreak,
                total_checkins: newTotal,
                last_checkin_time: lastRemaining ? lastRemaining.checkin_time : null,
                last_reminder_sent: null,
            }).eq('user_id', userId);

            const { data: stats } = assertResult(
                await db.from('user_stats').select('*').eq('user_id', userId).maybeSingle(),
                'undo stats'
            );
            const { count: todayCount } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('checkin_date', today),
                'undo today count'
            );

            if (io) {
                io.emit('leaderboard:update', { leaderboard: await getLeaderboard() });
                await broadcastDanmakuBatch(io, db);
            }

            res.json({ success: true, today_count: todayCount || 0, stats });
        } catch (err) {
            console.error('[Checkin] Undo error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '撤销失败，请重试' });
        }
    });

    // POST /api/checkins/makeup - 补打卡（仅限过去日期）
    router.post('/checkins/makeup', async (req, res) => {
        const userId = req.user.id;
        const { date } = req.body;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'INVALID_DATE', message: '日期格式无效' });
        }

        const today = getTodayStr();

        if (date >= today) {
            return res.status(400).json({ error: 'DATE_NOT_PAST', message: '只能补打过去的日期' });
        }

        const currentMonth = today.substring(0, 7);
        const targetMonth = date.substring(0, 7);
        if (targetMonth !== currentMonth) {
            return res.status(400).json({ error: 'DATE_NOT_CURRENT_MONTH', message: '只能补打当月日期' });
        }

        try {
            const { count: existingCnt } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('checkin_date', date),
                'makeup existing'
            );
            if (existingCnt > 0) {
                return res.json({ success: false, message: '该日期已有打卡记录' });
            }

            const makeupTime = `${date}T12:00:00.000Z`;
            await db.from('checkins').insert({ user_id: userId, checkin_time: makeupTime, checkin_date: date, note: '补打卡' });

            const stats = await updateStatsAfterCheckin(userId, date);

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
            const { data: rows } = assertResult(
                await db.from('checkins').select('checkin_date').eq('user_id', userId).like('checkin_date', `${currentMonth}%`),
                'calendar'
            );

            const dateMap = {};
            for (const row of rows) {
                dateMap[row.checkin_date] = (dateMap[row.checkin_date] || 0) + 1;
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

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'INVALID_DATE', message: '日期格式无效' });
        }

        const today = getTodayStr();

        if (date >= today) {
            return res.status(400).json({ error: 'DATE_NOT_PAST', message: '只能删除过去日期的记录' });
        }

        try {
            const { count: existingCnt } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('checkin_date', date),
                'delete-by-date existing'
            );
            if (existingCnt === 0) {
                return res.json({ success: false, message: '该日期无打卡记录' });
            }

            await db.from('checkins').delete().eq('user_id', userId).eq('checkin_date', date);
            const deleted = existingCnt;

            const { data: rows } = assertResult(
                await db.from('checkins').select('checkin_date').eq('user_id', userId),
                'delete-by-date dates'
            );
            const dates = rows.map(r => r.checkin_date);
            const currentStreak = calculateCurrentStreak(dates);

            const { data: cur } = assertResult(
                await db.from('user_stats').select('total_checkins').eq('user_id', userId).maybeSingle(),
                'delete-by-date cur'
            );
            const newTotal = Math.max(0, (cur?.total_checkins || 0) - deleted);
            await db.from('user_stats').update({
                current_streak: currentStreak,
                total_checkins: newTotal,
                last_reminder_sent: null,
            }).eq('user_id', userId);

            const { data: stats } = assertResult(
                await db.from('user_stats').select('*').eq('user_id', userId).maybeSingle(),
                'delete-by-date stats'
            );

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
            const { count: totalCount } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId).like('checkin_date', `${currentMonth}%`),
                'monthly total'
            );

            const { data: dailyRows } = assertResult(
                await db.from('checkins').select('checkin_date').eq('user_id', userId).like('checkin_date', `${currentMonth}%`),
                'monthly daily'
            );

            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const currentDay = now.getDate();

            const daysWithCheckins = dailyRows.length;
            const dailyAverage = (totalCount / currentDay).toFixed(1);
            const fullnessRate = ((daysWithCheckins / currentDay) * 100).toFixed(0);

            const dayCounts = {};
            for (const row of dailyRows) {
                dayCounts[row.checkin_date] = (dayCounts[row.checkin_date] || 0) + 1;
            }

            let maxDay = null;
            let maxCount = 0;
            for (const [d, c] of Object.entries(dayCounts)) {
                if (c > maxCount) { maxCount = c; maxDay = d; }
            }

            const dailyData = Object.entries(dayCounts).map(([d, c]) => ({
                day: parseInt(d.split('-')[2], 10),
                count: c,
                date: d,
            })).sort((a, b) => a.day - b.day);

            const { data: stats } = assertResult(
                await db.from('user_stats').select('current_streak, longest_streak').eq('user_id', userId).maybeSingle(),
                'monthly stats'
            );

            res.json({
                month: currentMonth,
                total_count: totalCount || 0,
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
            const { data: checkins } = assertResult(
                await db.from('checkins').select('id, checkin_time, checkin_date, note').eq('user_id', userId).order('checkin_time', { ascending: false }).range(offset, offset + limit - 1),
                'history'
            );
            const { count: total } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId),
                'history total'
            );

            res.json({ checkins, total: total || 0 });
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
            const { data: rawCheckins } = assertResult(
                await db.from('checkins').select('id, user_id, checkin_time, checkin_date, note, users(username, avatar_emoji)').eq('checkin_date', today).order('checkin_time', { ascending: false }).range(offset, offset + limit - 1),
                'all checkins'
            );
            const checkins = rawCheckins.map(flattenCheckin);

            const { count: total } = assertResult(
                await db.from('checkins').select('*', { count: 'exact', head: true }).eq('checkin_date', today),
                'all total'
            );

            res.json({ checkins, total: total || 0 });
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
            const { data: checkin } = assertResult(
                await db.from('checkins').select('*').eq('id', checkinId).eq('user_id', userId).maybeSingle(),
                'delete find'
            );
            if (!checkin) {
                return res.status(404).json({ error: 'NOT_FOUND', message: '打卡记录不存在或不属于你' });
            }

            await db.from('checkins').delete().eq('id', checkinId);

            const { data: rows } = assertResult(
                await db.from('checkins').select('checkin_date').eq('user_id', userId),
                'delete dates'
            );
            const dates = rows.map(r => r.checkin_date);

            const currentStreak = calculateCurrentStreak(dates);
            const ascendingDates = [...dates].sort();
            const longestStreak = calculateLongestStreak(ascendingDates);

            const { data: cur } = assertResult(
                await db.from('user_stats').select('longest_streak, total_checkins').eq('user_id', userId).maybeSingle(),
                'delete cur'
            );
            const newLongest = Math.max(cur?.longest_streak || 0, longestStreak);
            const newTotal = Math.max(0, (cur?.total_checkins || 0) - 1);
            await db.from('user_stats').update({
                current_streak: currentStreak,
                longest_streak: newLongest,
                total_checkins: newTotal,
            }).eq('user_id', userId);

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
            const { data: user } = assertResult(
                await db.from('users').select('id, username, avatar_emoji, created_at').eq('username', req.params.username).maybeSingle(),
                'stats find user'
            );
            if (!user) {
                return res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
            }
            const { data: stats } = assertResult(
                await db.from('user_stats').select('*').eq('user_id', user.id).maybeSingle(),
                'stats'
            );
            const { data: recentCheckins } = assertResult(
                await db.from('checkins').select('checkin_time, checkin_date, note').eq('user_id', user.id).order('checkin_time', { ascending: false }).limit(10),
                'stats recent'
            );

            res.json({ user, stats, recent_checkins: recentCheckins });
        } catch (err) {
            console.error('[Checkin] Stats error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取统计失败' });
        }
    });

    return router;
}
