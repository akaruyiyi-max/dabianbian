/**
 * 答辩记录仪 - 排行榜模块
 * 渲染排行榜列表，合并在线状态
 */

/** 打卡成就等级表（0-10 次，共 11 档）— 与后端 ACHIEVEMENT_TIERS 保持一致 */
const ACHIEVEMENT_TIERS = [
    { count: 0,  title: '堵车大王', emoji: '\u{1F6AB}' },  // 🚫
    { count: 1,  title: '健康宝宝', emoji: '\u{1F476}' },  // 👶
    { count: 2,  title: '顺畅达人', emoji: '\u{2728}' },   // ✨
    { count: 3,  title: '微辣菊长', emoji: '\u{1F336}' },  // 🌶
    { count: 4,  title: '菊部微恙', emoji: '\u{1F525}' },  // 🔥
    { count: 5,  title: '马桶之友', emoji: '\u{1F6BD}' },  // 🚽
    { count: 6,  title: '腿麻战士', emoji: '\u{1F9B5}' },  // 🦵
    { count: 7,  title: '厕界劳模', emoji: '\u{1F4BC}' },  // 💼
    { count: 8,  title: '魂飞模式', emoji: '\u{1F47B}' },  // 👻
    { count: 9,  title: '登仙在即', emoji: '\u{1F47C}' },  // 👼
    { count: 10, title: '脱肛熊熊', emoji: '\u{1F43B}' },  // 🐻
];

function getAchievementTier(todayCount) {
    const idx = Math.min(Math.max(todayCount || 0, 0), 10);
    return ACHIEVEMENT_TIERS[idx];
}

const Leaderboard = {
    currentData: [],

    async init() {
        try {
            const data = await Api.getLeaderboard();
            this.render(data.leaderboard);
        } catch (err) {
            console.error('[Leaderboard] Init error:', err);
        }
    },

    render(leaderboard) {
        this.currentData = leaderboard || [];
        this._renderInternal();
    },

    refreshOnlineStatus() {
        // 仅更新在线状态，不重新请求
        this._renderInternal();
    },

    _renderInternal() {
        const list = document.getElementById('leaderboard-list');
        if (!list) return;

        if (!this.currentData || this.currentData.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="peach-illustration peach-md peach-confused"></div>
                    <p class="empty-state-text">还没有人打卡呢，快来当第一个💩</p>
                </div>`;
            return;
        }

        const myId = Auth.getCurrentUser()?.id;

        list.innerHTML = this.currentData.map((u, i) => {
            const rank = i + 1;
            const isMe = u.user_id === myId;
            const isOverdue = this._isOverdue(u.last_checkin_time, u.created_at);
            const isOnline = SocketClient.isOnline ? SocketClient.isOnline(u.user_id) : false;

            // 排名图标：前三名用屁桃君奖牌，其余用数字
            let medalHtml;
            if (rank <= 3) {
                medalHtml = '<div class="rank-medal"></div>';
            } else {
                medalHtml = `<div class="rank-number">${rank}</div>`;
            }

            // 超时标签
            const overdueBadge = isOverdue
                ? `<span class="rank-overdue-badge">${this._getOverdueDays(u.last_checkin_time, u.created_at)}天没拉💩</span>`
                : '';

            // 今日打卡称号
            const tier = getAchievementTier(u.today_count);
            const isGlow = (u.today_count || 0) > 4;
            const titleBadge = `<span class="rank-title-badge${isGlow ? ' rank-title-glow' : ''}">${tier.emoji} ${tier.title}</span>`;

            // 在线标记
            const onlineBadge = isOnline ? '<span class="online-badge"></span>' : '';

            const classes = [
                'rank-item',
                rank === 1 ? 'rank-1' : '',
                rank === 2 ? 'rank-2' : '',
                rank === 3 ? 'rank-3' : '',
                isOverdue ? 'rank-overdue' : '',
                isMe ? 'is-me' : '',
            ].filter(Boolean).join(' ');

            return `
                <div class="${classes}">
                    ${medalHtml}
                    <div class="rank-info">
                        <div class="rank-name">
                            ${u.avatar_emoji || '💩'} ${this._escapeHtml(u.username)} ${onlineBadge}
                        </div>
                        <div class="rank-stats">
                            <span>🔥${u.current_streak}天</span>
                            <span>最长${u.longest_streak}天</span>
                            <span>共${u.total_checkins}次</span>
                            <span>今日${u.today_count}次</span>
                            ${overdueBadge}
                            <span class="rank-title-slot">${titleBadge}</span>
                        </div>
                    </div>
                </div>`;
        }).join('');
    },

    // ---- 打卡广播时重新加载排行榜 ----
    onCheckinCreated(data) {
        // 排行榜会通过 leaderboard:update 事件自动更新，
        // 但如果事件丢失也兜底刷新一次
        this.init();
    },

    // ---- 辅助方法 ----
    _isOverdue(lastCheckinTime, createdAt) {
        const baseline = lastCheckinTime || createdAt;
        if (!baseline) return false;
        const elapsed = Date.now() - new Date(baseline).getTime();
        return elapsed > 24 * 60 * 60 * 1000;
    },

    _getOverdueDays(lastCheckinTime, createdAt) {
        const baseline = lastCheckinTime || createdAt;
        if (!baseline) return 0;
        const elapsed = Date.now() - new Date(baseline).getTime();
        return Math.floor(elapsed / (24 * 60 * 60 * 1000));
    },

    _escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
