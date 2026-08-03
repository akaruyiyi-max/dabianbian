import { config } from '../config.js';
import { calculateDaysOverdue, parseDbDate, getTodayStr } from '../utils/helpers.js';

/**
 * 打卡成就等级表（0-10 次，共 11 档）
 */
const ACHIEVEMENT_TIERS = [
    { count: 0,  title: '堵车大王', phrase: '你没屎吧？你没屎吧！你没屎吧~是吃得太干还是肠子偷懒啦？', emoji: '\u{1F6AB}' },  // 🚫
    { count: 1,  title: '健康宝宝', phrase: '恭喜你又健康了一天耶！', emoji: '\u{1F476}' },                                          // 👶
    { count: 2,  title: '顺畅达人', phrase: '哇哦~更舒服了呢~', emoji: '\u{2728}' },                                               // ✨
    { count: 3,  title: '微辣菊长', phrase: '啊~感觉清空了，就是py有点点辣', emoji: '\u{1F336}' },                                   // 🌶
    { count: 4,  title: '菊部微恙', phrase: '嗯…第四趟了呢，菊花开始有意见啦~', emoji: '\u{1F525}' },                                // 🔥
    { count: 5,  title: '马桶之友', phrase: '第五次了耶~马桶君，我们是不是太熟了~', emoji: '\u{1F6BD}' },                              // 🚽
    { count: 6,  title: '腿麻战士', phrase: '呜呜…第六次，腿麻到站不起来了呢…', emoji: '\u{1F9B5}' },                                 // 🦵
    { count: 7,  title: '厕界劳模', phrase: '救命！第七次了！今天是要住厕所了吗！', emoji: '\u{1F4BC}' },                              // 💼
    { count: 8,  title: '魂飞模式', phrase: '第八次…灵魂已经开始飘了，我是谁我在哪…', emoji: '\u{1F47B}' },                           // 👻
    { count: 9,  title: '登仙在即', phrase: '第九次了！！九九八十一难吗！！我要升天了！！', emoji: '\u{1F47C}' },                      // 👼
    { count: 10, title: '脱肛熊熊', phrase: '不要~不要再拉了~再拉炸肛了~啊！', emoji: '\u{1F43B}' },                                  // 🐻
];

/**
 * 启动提醒服务 - 定时批量推送双规则弹幕
 */
export function startReminderService(io, db) {
    setTimeout(() => broadcastDanmakuBatch(io, db), 3000);

    setInterval(() => {
        broadcastDanmakuBatch(io, db);
    }, config.REMINDER_CHECK_INTERVAL_MS);

    console.log(`[Reminder] Service started, checking every ${config.REMINDER_CHECK_INTERVAL_MS / 1000}s`);
}

/**
 * 查询所有超过 24 小时未打卡的用户（规则一：通报批评）
 */
function getAllOverdueUsers(db) {
    const now = Date.now();
    const rows = db.prepare(`
        SELECT
            u.id, u.username, u.avatar_emoji, u.created_at,
            us.last_checkin_time
        FROM users u
        JOIN user_stats us ON us.user_id = u.id
    `).all();

    const overdue = [];
    for (const row of rows) {
        const baseline = row.last_checkin_time || row.created_at;
        const baselineMs = parseDbDate(baseline).getTime();
        const elapsed = now - baselineMs;

        if (elapsed >= config.REMINDER_THRESHOLD_MS) {
            const N = calculateDaysOverdue(row.last_checkin_time, row.created_at);
            if (N > 1) {
                overdue.push({
                    target_user_id: row.id,
                    target_username: row.username,
                    days_overdue: N,
                });
            }
        }
    }
    return overdue;
}

/**
 * 查询所有用户今日打卡次数及对应称号（规则二：打卡成就）
 */
function getAllAchievementUsers(db) {
    const today = getTodayStr();
    const rows = db.prepare(`
        SELECT
            u.id AS target_user_id,
            u.username AS target_username,
            (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id AND c.checkin_date = ?) AS today_count
        FROM users u
    `).all(today);

    return rows.map(row => {
        const count = Math.min(row.today_count, 10);
        const tier = ACHIEVEMENT_TIERS[count];
        return {
            target_user_id: row.target_user_id,
            target_username: row.target_username,
            checkin_count: count,
            title: tier.title,
            phrase: tier.phrase,
            tier_emoji: tier.emoji,
        };
    });
}

/**
 * 批量广播双规则弹幕 — 通报批评 + 打卡成就
 */
export function broadcastDanmakuBatch(io, db) {
    const overdueUsers = getAllOverdueUsers(db);
    const achievementUsers = getAllAchievementUsers(db);

    io.emit('reminder:batch', {
        overdue: overdueUsers,
        achievements: achievementUsers,
    });

    if (overdueUsers.length > 0) {
        const now = new Date().toISOString();
        const updateStmt = db.prepare(`UPDATE user_stats SET last_reminder_sent = ? WHERE user_id = ?`);
        for (const user of overdueUsers) {
            updateStmt.run(now, user.target_user_id);
        }
    }

    console.log(`[Reminder] Batch: ${overdueUsers.length} overdue, ${achievementUsers.length} achievements`);
}

/**
 * 用户上线时 — 推送当前双规则弹幕
 */
export function checkAndSendReminderForUser(userId, io, db) {
    broadcastDanmakuBatch(io, db);
}
