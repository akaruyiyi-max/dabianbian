/**
 * 答辩记录仪 - 认证模块
 * 处理登录/登出/Token管理（无密码模式，仅需用户名）
 */
const Auth = {
    user: null,
    stats: null,

    // ---- Token 状态 ----
    getToken() {
        return Api.getToken();
    },

    isLoggedIn() {
        return !!this.getToken();
    },

    // ---- 错误显示 ----
    showError(msg) {
        const el = document.getElementById('form-error');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
    },

    clearError() {
        const el = document.getElementById('form-error');
        if (!el) return;
        el.textContent = '';
        el.classList.remove('show');
    },

    // ---- 提交登录（仅需用户名） ----
    async submit() {
        const username = document.getElementById('username').value.trim();

        this.clearError();

        // 前端校验：必须为纯中文，1-20 个字符
        if (!username || username.length > 20) {
            this.showError('用户名需要 1-20 个中文字符');
            return;
        }
        if (!/^[\u4e00-\u9fa5]+$/.test(username)) {
            this.showError('用户名必须输入中文');
            return;
        }

        const btn = document.getElementById('auth-submit');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '处理中...';

        try {
            const data = await Api.login(username);

            Api.setToken(data.token);
            localStorage.setItem('poop_user', JSON.stringify(data.user));

            window.location.href = '/dashboard.html';
        } catch (err) {
            this.showError(err.message || '登录失败，请重试');
            btn.disabled = false;
            btn.textContent = originalText;
        }
    },

    // ---- 登出 ----
    logout() {
        Api.clearToken();
        window.location.href = '/';
    },

    // ---- 需要登录才能访问的页面调用 ----
    async requireAuth() {
        if (!this.isLoggedIn()) {
            window.location.href = '/';
            return false;
        }

        // 先从 localStorage 恢复用户信息
        const stored = localStorage.getItem('poop_user');
        if (stored) {
            try { this.user = JSON.parse(stored); } catch (e) {}
        }

        // 通过 /me 验证 Token 有效性
        try {
            const data = await Api.getMe();
            this.user = data.user;
            this.stats = data.stats;
            localStorage.setItem('poop_user', JSON.stringify(data.user));
            return true;
        } catch (err) {
            // Token 无效或过期
            this.logout();
            return false;
        }
    },

    getCurrentUser() {
        return this.user;
    },
};
