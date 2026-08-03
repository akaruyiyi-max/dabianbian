/**
 * 答辩记录仪 - 认证模块
 * 处理登录/登出/Token管理（无密码 + 房间邀请码模式）
 */
const Auth = {
    user: null,
    stats: null,
    roomInitialized: true,   // 房间是否已设置邀请码（默认假设已初始化，失败时回退）
    mode: 'login',           // 'login' | 'setup'

    // ---- Token 状态 ----
    getToken() {
        return Api.getToken();
    },

    isLoggedIn() {
        return !!this.getToken();
    },

    // ---- 页面初始化 ----
    async init() {
        // 已登录直接进
        if (this.isLoggedIn()) {
            window.location.href = '/dashboard.html';
            return;
        }

        // 查询房间是否已初始化（是否已有人设置邀请码）
        try {
            const status = await Api.getInviteStatus();
            this.roomInitialized = status.initialized;
        } catch (e) {
            this.roomInitialized = true; // 查询失败则视为已初始化，避免卡死
        }

        this._renderForm();
    },

    // ---- 根据状态渲染登录表单 ----
    _renderForm() {
        const group = document.getElementById('invite-group');
        const label = document.getElementById('invite-label');
        const input = document.getElementById('invite-code');
        const hint = document.getElementById('invite-hint');
        const btn = document.getElementById('auth-submit');
        if (!group || !input) return;

        const storedCode = localStorage.getItem('poop_invite');

        if (this.roomInitialized === false) {
            // 第一位进入：设置邀请码
            this.mode = 'setup';
            label.textContent = '设置房间邀请码（你是第一位）';
            input.placeholder = '设置一个邀请码，发给朋友（4-40 位）';
            hint.textContent = '房间尚未创建，请先设置一个邀请码，之后把它发给朋友即可加入。';
            btn.textContent = '🚽 创建房间并进入 🚽';
            group.style.display = 'block';
            input.disabled = false;
        } else if (storedCode) {
            // 已记住邀请码：日常只需填用户名
            this.mode = 'login';
            label.textContent = '邀请码（已记住）';
            input.value = storedCode;
            input.disabled = true;
            hint.textContent = '';
            btn.textContent = '💩 进入 💩';
            group.style.display = 'block';
        } else {
            // 已知房间但未记住码：需填邀请码
            this.mode = 'login';
            label.textContent = '邀请码';
            input.placeholder = '输入房间邀请码';
            input.value = '';
            input.disabled = false;
            hint.textContent = '向创建房间的人索要邀请码';
            btn.textContent = '💩 进入 💩';
            group.style.display = 'block';
        }
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

    // ---- 提取邀请码 ----
    _getCode() {
        const input = document.getElementById('invite-code');
        const stored = localStorage.getItem('poop_invite');
        if (this.mode === 'login' && stored && input && input.disabled) {
            return stored;
        }
        return input ? input.value.trim() : '';
    },

    // ---- 提交（设置 or 登录） ----
    async submit() {
        const username = document.getElementById('username').value.trim();
        const code = this._getCode();

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
            // 首次设定邀请码
            if (this.mode === 'setup') {
                if (code.length < 4) {
                    this.showError('邀请码至少 4 位');
                    btn.disabled = false;
                    btn.textContent = originalText;
                    return;
                }
                try {
                    await Api.setupInvite(code);
                } catch (setupErr) {
                    // 房间已被他人抢先创建
                    if (setupErr.error === 'ALREADY_INITIALIZED') {
                        this.roomInitialized = true;
                        this._renderForm();
                        this.showError('房间已由他人创建，请输入邀请码');
                        btn.disabled = false;
                        btn.textContent = originalText;
                        return;
                    }
                    throw setupErr;
                }
            }

            // 登录
            const data = await Api.login(username, code);

            Api.setToken(data.token);
            localStorage.setItem('poop_user', JSON.stringify(data.user));
            localStorage.setItem('poop_invite', code);

            window.location.href = '/dashboard.html';
        } catch (err) {
            this.showError(err.message || '操作失败，请重试');
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
