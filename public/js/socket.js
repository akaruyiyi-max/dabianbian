/**
 * 答辩记录仪 - Socket.io 客户端
 * 处理实时通信：打卡广播、排行榜更新、在线状态、超时提醒
 */
const SocketClient = {
    socket: null,
    connected: false,
    onlineUserIds: new Set(),

    init() {
        const token = Api.getToken();
        if (!token) return;

        this.socket = io({
            auth: { token },
            transports: ['websocket', 'polling'],
        });

        // ---- 连接状态 ----
        this.socket.on('connect', () => {
            this.connected = true;
            const banner = document.getElementById('connection-banner');
            if (banner) banner.classList.remove('show');
        });

        this.socket.on('disconnect', () => {
            this.connected = false;
            const banner = document.getElementById('connection-banner');
            if (banner) banner.classList.add('show');
        });

        this.socket.on('connect_error', () => {
            const banner = document.getElementById('connection-banner');
            if (banner) banner.classList.add('show');
        });

        // ---- 在线用户列表更新 ----
        this.socket.on('online_users:update', (data) => {
            this.onlineUserIds = new Set(data.users.map(u => u.user_id));
            const el = document.getElementById('online-count');
            if (el) el.textContent = data.users.length;
            // 更新排行榜的在线状态
            Leaderboard.refreshOnlineStatus();
        });

        // ---- 打卡广播 ----
        this.socket.on('checkin:created', (data) => {
            Dashboard.onCheckinCreated(data);
        });

        // ---- 打卡删除 ----
        this.socket.on('checkin:deleted', (data) => {
            // 如果是自己的记录被删，可在此处理
        });

        // ---- 排行榜更新 ----
        this.socket.on('leaderboard:update', (data) => {
            Leaderboard.render(data.leaderboard);
        });

        // ---- 用户上线/下线 ----
        this.socket.on('user:online', (data) => {
            Dashboard.addFeed({
                emoji: data.avatar_emoji || '💩',
                username: data.username,
                action: '上线了',
            });
        });

        this.socket.on('user:offline', (data) => {
            Dashboard.addFeed({
                emoji: '👋',
                username: data.username,
                action: '溜了',
            });
        });

        // ---- 超时提醒批量推送（所有超时用户） ----
        this.socket.on('reminder:batch', (data) => {
            Dashboard.showReminderBatch(data);
        });
    },

    dismissReminder() {
        if (this.socket) {
            this.socket.emit('reminder:dismiss');
        }
    },

    isOnline(userId) {
        return this.onlineUserIds.has(userId);
    },
};
