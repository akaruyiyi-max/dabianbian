/**
 * 答辩记录仪 - API 封装
 * 所有 REST API 调用通过此模块发出
 */
const Api = {
    // ---- Token 管理 ----
    getToken() {
        return localStorage.getItem('poop_token');
    },

    setToken(token) {
        localStorage.setItem('poop_token', token);
    },

    clearToken() {
        localStorage.removeItem('poop_token');
        localStorage.removeItem('poop_user');
    },

    // ---- 通用请求 ----
    async request(path, options = {}) {
        const token = this.getToken();
        const headers = { 'Content-Type': 'application/json', ...options.headers };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        let res;
        try {
            res = await fetch(AppConfig.API_BASE + path, { ...options, headers });
        } catch (e) {
            throw { message: '网络错误，请检查连接' };
        }

        let data;
        try {
            data = await res.json();
        } catch (e) {
            throw { message: '服务器返回异常' };
        }

        if (!res.ok) {
            throw data;
        }
        return data;
    },

    // ---- 认证（无密码，仅需用户名 + 房间邀请码） ----
    login(username, code) {
        return this.request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, code }),
        });
    },

    getInviteStatus() {
        return this.request('/api/auth/invite-status');
    },

    setupInvite(code) {
        return this.request('/api/auth/setup', {
            method: 'POST',
            body: JSON.stringify({ code }),
        });
    },

    getMe() {
        return this.request('/api/auth/me');
    },

    // ---- 打卡 ----
    createCheckin(note, clientDate) {
        return this.request('/api/checkins', {
            method: 'POST',
            body: JSON.stringify({ note: note || null, client_date: clientDate }),
        });
    },

    getMyCheckins(limit = 20, offset = 0) {
        return this.request(`/api/checkins?limit=${limit}&offset=${offset}`);
    },

    getAllCheckins(limit = 30, offset = 0) {
        return this.request(`/api/checkins/all?limit=${limit}&offset=${offset}`);
    },

    deleteCheckin(id) {
        return this.request(`/api/checkins/${id}`, { method: 'DELETE' });
    },

    undoCheckin() {
        return this.request('/api/checkins/undo', { method: 'POST' });
    },

    makeupCheckin(date) {
        return this.request('/api/checkins/makeup', {
            method: 'POST',
            body: JSON.stringify({ date }),
        });
    },

    deleteCheckinByDate(date) {
        return this.request('/api/checkins/delete-by-date', {
            method: 'POST',
            body: JSON.stringify({ date }),
        });
    },

    getCalendarCheckins() {
        return this.request('/api/checkins/calendar');
    },

    getMonthlyReport() {
        return this.request('/api/checkins/monthly-report');
    },

    // ---- 排行榜 ----
    getLeaderboard() {
        return this.request('/api/leaderboard');
    },
};
