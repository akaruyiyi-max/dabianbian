/**
 * 答辩记录仪 - 仪表盘主模块
 * 管理打卡、日历视图、实时动态、提醒弹窗
 */

/**
 * 弹幕管理器 — 双规则弹幕系统（有限生成，签名去重）
 *
 * 设计原则：
 *   - 无无限循环 spawner，每条内容只生成有限条弹幕
 *   - 签名去重：内容签名不变时不重复生成
 *   - 弹幕滚完即自动销毁，不残留
 *
 * 规则一（通报批评）：用户超过24h未打卡
 *   弹幕：小{用户名}~，你也不想所有人知道你已经{N}天没拉屎了吧~~~
 *   红色系背景，用户名金色高亮，天数红色高亮
 *
 * 规则二（打卡成就）：根据今日打卡次数(0-10)匹配称号
 *   弹幕：小{用户名}~，荣获{称号}称号，{话语}
 *   蓝紫系背景，用户名青色高亮，称号金色高亮，次数绿色高亮
 */
const DanmakuManager = {
    pool: [],               // 弹幕池: { type, target_user_id, _sig, ... }
    layer: null,             // DOM 弹幕层
    controls: null,          // 清屏按钮容器
    maxOnScreen: 40,         // 同屏最大弹幕数
    spawnPerTrigger: 2,      // 每次触发生成弹幕条数
    spawnInterval: 3000,     // 同一内容的弹幕间隔(ms)

    init() {
        this.layer = document.getElementById('danmaku-layer');
        this.controls = document.getElementById('danmaku-controls');
    },

    /** 批量处理双规则弹幕 */
    handleBatch(data) {
        const overdueList = data.overdue || [];
        const achievementList = data.achievements || [];

        const overdueIds = new Set(overdueList.map(u => u.target_user_id));
        const achievementIds = new Set(achievementList.map(u => u.target_user_id));

        // 移除已不再符合条件的弹幕（用户已打卡/状态变化）
        this.pool = this.pool.filter(p =>
            (p.type === 'overdue' && overdueIds.has(p.target_user_id)) ||
            (p.type === 'achievement' && achievementIds.has(p.target_user_id))
        );

        // 处理规则一：通报批评
        for (const u of overdueList) {
            this._upsertItem('overdue', u);
        }

        // 处理规则二：打卡成就
        for (const u of achievementList) {
            this._upsertItem('achievement', u);
        }

        // UI 控制
        if (this.pool.length > 0) {
            if (this.controls) this.controls.style.display = 'block';
        } else {
            if (this.controls) this.controls.style.display = 'none';
        }
    },

    /** 添加或更新池中的弹幕项 — 签名不变则不重新生成 */
    _upsertItem(type, data) {
        const isMe = (typeof Auth !== 'undefined' && Auth.getCurrentUser()?.id === data.target_user_id);

        // 构建内容签名 — 内容不变则签名不变
        const sig = type === 'overdue'
            ? `${type}:${data.target_user_id}:${data.days_overdue}`
            : `${type}:${data.target_user_id}:${data.checkin_count}`;

        const existing = this.pool.find(p => p.type === type && p.target_user_id === data.target_user_id);

        if (existing) {
            // 已在池中 — 签名不变则仅更新 isMe，不生成新弹幕
            if (existing._sig === sig) {
                existing.isMe = isMe;
                return;
            }
            // 签名变了（天数增加/打卡次数变化）— 更新数据并生成新弹幕
            existing._sig = sig;
            if (type === 'overdue') {
                existing.days_overdue = data.days_overdue;
                existing.emoji = this._getOverdueEmoji(data.days_overdue);
            } else {
                existing.checkin_count = data.checkin_count;
                existing.title = data.title;
                existing.phrase = data.phrase;
                existing.tier_emoji = data.tier_emoji;
            }
            existing.isMe = isMe;
            this._spawnBatch(existing);
        } else {
            // 新项 — 加入池并生成弹幕
            const item = { type, target_user_id: data.target_user_id, target_username: data.target_username, isMe, _sig: sig };
            if (type === 'overdue') {
                item.days_overdue = data.days_overdue;
                item.emoji = this._getOverdueEmoji(data.days_overdue);
            } else {
                item.checkin_count = data.checkin_count;
                item.title = data.title;
                item.phrase = data.phrase;
                item.tier_emoji = data.tier_emoji;
            }
            this.pool.push(item);
            this._spawnBatch(item);
        }
    },

    /** 为一个弹幕项生成有限条弹幕（无无限循环） */
    _spawnBatch(item) {
        if (!item) return;
        for (let i = 0; i < this.spawnPerTrigger; i++) {
            setTimeout(() => {
                // 检查项是否仍在池中（可能已被移除）且屏幕未满
                if (!this.pool.find(p => p === item)) return;
                if (this.layer && this.layer.children.length >= this.maxOnScreen) return;
                this._spawnOne(item);
            }, i * this.spawnInterval);
        }
    },

    /** 生成单条弹幕 DOM */
    _spawnOne(item) {
        if (!this.layer) return;

        const el = document.createElement('div');
        el.className = 'danmaku-item ' +
            (item.type === 'overdue' ? 'rule-overdue' : 'rule-achievement') +
            (item.isMe ? ' danmaku-me' : '');

        const topPx = 70 + Math.random() * (window.innerHeight - 160);
        const duration = 8 + Math.random() * 6;
        const fontSize = 1.0 + Math.random() * 0.5;

        el.style.top = `${topPx}px`;
        el.style.setProperty('--duration', `${duration}s`);
        el.style.fontSize = `${fontSize}rem`;

        if (item.type === 'overdue') {
            el.innerHTML =
                `<span class="danmaku-emoji">${item.emoji}</span>` +
                `<span class="danmaku-text">小` +
                `<span class="danmaku-username">${this._escapeHtml(item.target_username)}</span>` +
                `~，你也不想所有人知道你已经` +
                `<span class="danmaku-days">${item.days_overdue}</span>` +
                `天没拉屎了吧~~~</span>`;
        } else {
            el.innerHTML =
                `<span class="danmaku-emoji">${item.tier_emoji}</span>` +
                `<span class="danmaku-text">小` +
                `<span class="danmaku-username">${this._escapeHtml(item.target_username)}</span>` +
                `~，荣获` +
                `<span class="danmaku-title">${this._escapeHtml(item.title)}</span>` +
                `称号，` +
                `<span class="danmaku-phrase">${this._escapeHtml(item.phrase)}</span>` +
                `（今日第` +
                `<span class="danmaku-count">${item.checkin_count}</span>` +
                `次）</span>`;
        }

        this.layer.appendChild(el);

        // 动画结束后自动移除 DOM
        el.addEventListener('animationend', () => {
            el.remove();
            if (this.pool.length === 0 && this.layer.children.length === 0 && this.controls) {
                this.controls.style.display = 'none';
            }
        });
    },

    /** 清除指定用户的通报批评弹幕（该用户已打卡） */
    clearUser(userId) {
        this.pool = this.pool.filter(p => !(p.type === 'overdue' && p.target_user_id === userId));
        if (this.pool.length === 0) {
            if (this.controls) {
                setTimeout(() => {
                    if (this.pool.length === 0) this.controls.style.display = 'none';
                }, 15000);
            }
        }
    },

    /** 清除所有弹幕 */
    clearAll() {
        this.pool = [];
        if (this.layer) this.layer.innerHTML = '';
        if (this.controls) this.controls.style.display = 'none';
    },

    /** 根据便秘天数映射表情符号（规则一专用，N>1） */
    _getOverdueEmoji(days) {
        if (days <= 2)  return '\u{1F60F}'; // 😏 略微得意
        if (days <= 3)  return '\u{1F605}'; // 😅 有点尴尬
        if (days <= 5)  return '\u{1F623}'; // 😣 开始难受
        if (days <= 7)  return '\u{1F62B}'; // 😫 真的很难受
        if (days <= 10) return '\u{1F631}'; // 😱 痛苦尖叫
        if (days <= 14) return '\u{1F92F}'; // 🤯 快炸了
        return '\u{1F480}';                  // 💀 已经走了
    },

    _escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};

const Dashboard = {
    // ---- 初始化 ----
    async init() {
        DanmakuManager.init();
        this._loadUserInfo();
        await this._loadStats();
        await this._loadCalendar();
        await this._loadFeed();
        // 排行榜单独加载
        Leaderboard.init();
    },

    // ---- 加载用户信息到导航栏 ----
    _loadUserInfo() {
        const user = Auth.getCurrentUser();
        if (!user) return;

        const avatarEl = document.getElementById('nav-avatar');
        const nameEl = document.getElementById('nav-username');
        if (avatarEl) avatarEl.textContent = user.avatar_emoji || '\u{1F4A9}';
        if (nameEl) nameEl.textContent = user.username;
    },

    // ---- 加载统计数据（连续天数等） ----
    async _loadStats() {
        try {
            const data = await Api.getMe();
            this._updateStats(data.stats);
            this._updateUndoButton(data.today_count || 0);
        } catch (err) {
            console.error('[Dashboard] Load stats error:', err);
        }
    },

    _updateStats(stats) {
        if (!stats) return;

        const streakEl = document.getElementById('current-streak');
        const navStreakEl = document.getElementById('nav-streak');
        const lastEl = document.getElementById('last-checkin');

        const streak = stats.current_streak || 0;
        if (streakEl) streakEl.textContent = streak;
        if (navStreakEl) navStreakEl.textContent = `\u{1F525}\u00D7${streak}\u5929`;

        if (lastEl) {
            if (stats.last_checkin_time) {
                lastEl.textContent = `\u4E0A\u6B21\u6253\u5361: ${this._formatTime(stats.last_checkin_time)}`;
            } else {
                lastEl.textContent = '\u4E0A\u6B21\u6253\u5361: \u4ECE\u672A';
            }
        }
    },

    // ---- 打卡 ----
    async checkin() {
        const btn = document.getElementById('checkin-btn');
        const noteInput = document.getElementById('note-input');
        const note = noteInput ? noteInput.value.trim() : '';

        if (btn) {
            btn.disabled = true;
            btn.textContent = '\u6253\u5361\u4E2D...';
        }

        // 获取本地日期 YYYY-MM-DD
        const today = new Date().toLocaleDateString('sv-SE');

        try {
            const data = await Api.createCheckin(note, today);

            // 每日 10 次上限 — 后端静默拒绝，前端不显示任何提示
            if (data && data.limit_reached) {
                return;
            }

            // 更新统计
            this._updateStats(data.stats);

            // 更新撤销按钮状态
            this._updateUndoButton(data.today_count || 0);

            // 刷新日历视图
            this._loadCalendar();

            // 显示庆祝弹窗
            this._showCelebration(data.checkin);

            // Toast 提示
            this._showToast('success', '\u6253\u5361\u6210\u529F\uFF01', `\u7EE7\u7EED\u4FDD\u6301\uFF0C\u5DF2\u8FDE\u7EED ${data.stats.current_streak} \u5929\uFF01`);

            // 清除自己的弹幕提醒（已打卡，不再超时）
            const currentUser = Auth.getCurrentUser();
            if (currentUser) DanmakuManager.clearUser(currentUser.id);

            // 清空备注
            if (noteInput) noteInput.value = '';
        } catch (err) {
            this._showToast('error', '\u6253\u5361\u5931\u8D25', err.message || '\u8BF7\u91CD\u8BD5');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '\u{1F4A9} \u4E00\u952E\u6253\u5361 \u{1F4A9}';
            }
        }
    },

    // ---- 撤销今日最近一次打卡（防作弊）----
    async undoCheckin() {
        const btn = document.getElementById('undo-btn');
        if (!btn || btn.disabled) return;

        btn.disabled = true;
        btn.textContent = '\u5438\u56DE\u53BB\u4E86...';

        try {
            const data = await Api.undoCheckin();

            if (data.success) {
                // 更新统计
                this._updateStats(data.stats);

                // 刷新日历视图
                await this._loadCalendar();

                // 更新撤销按钮状态
                this._updateUndoButton(data.today_count);

                this._showToast('success', '\u5438\u56DE\u53BB\u4E86\uFF01', `\u4ECA\u65E5\u5269\u4F59\u6253\u5361: ${data.today_count} \u6B21`);
            } else {
                // 今日无打卡可撤销
                this._updateUndoButton(0);
            }
        } catch (err) {
            this._showToast('error', '\u64A4\u9500\u5931\u8D25', err.message || '\u8BF7\u91CD\u8BD5');
        } finally {
            btn.textContent = '\u{1F6BD} \u628A\u5C4E\u6084\u6084\u5438\u56DE\u53BB';
        }
    },

    // ---- 根据今日打卡次数更新撤销按钮状态 ----
    _updateUndoButton(todayCount) {
        const btn = document.getElementById('undo-btn');
        if (!btn) return;
        if (todayCount > 0) {
            btn.disabled = false;
            btn.textContent = `\u{1F6BD} \u628A\u5C4E\u6084\u6084\u5438\u56DE\u53BB\uFF08\u5269${todayCount}\u6B21\uFF09`;
        } else {
            btn.disabled = true;
            btn.textContent = '\u{1F6BD} \u628A\u5C4E\u6084\u6084\u5438\u56DE\u53BB';
        }
    },

    // ---- 接收其他用户打卡广播 ----
    onCheckinCreated(data) {
        const user = Auth.getCurrentUser();
        // 自己的打卡已在 checkin() 中处理，跳过
        if (user && data.checkin.user_id === user.id) return;

        // 该用户已打卡，清除其弹幕提醒
        DanmakuManager.clearUser(data.checkin.user_id);

        this._addFeed({
            emoji: data.checkin.avatar_emoji || '\u{1F4A9}',
            username: data.checkin.username,
            action: '\u6253\u5361\u4E86\uFF01',
            note: data.checkin.note,
        });
    },

    // ---- 加载日历数据 ----
    async _loadCalendar() {
        try {
            const data = await Api.getCalendarCheckins();
            this._renderCalendar(data.dates || {}, data.month);
        } catch (err) {
            console.error('[Dashboard] Load calendar error:', err);
        }
    },

    // ---- 渲染当月日历 ----
    _renderCalendar(dateMap, monthStr) {
        const container = document.getElementById('calendar-container');
        if (!container) return;

        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth(); // 0-indexed
        const today = now.toLocaleDateString('sv-SE');

        // 当月天数
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        // 1号是星期几（0=周日）
        const firstDayOfWeek = new Date(year, month, 1).getDay();
        // 转为周一为起始（周一=0, 周日=6）
        const firstDayOffset = (firstDayOfWeek + 6) % 7;

        const weekdays = ['\u4E00', '\u4E8C', '\u4E09', '\u56DB', '\u4E94', '\u516D', '\u65E5'];
        let html = '<div class="calendar-grid">';
        html += weekdays.map(w => `<div class="calendar-weekday">${w}</div>`).join('');

        // 填充月初空白格
        for (let i = 0; i < firstDayOffset; i++) {
            html += '<div class="calendar-cell empty"></div>';
        }

        // 填充每一天
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const count = dateMap[dateStr] || 0;
            const isToday = dateStr === today;
            const isPast = dateStr < today;

            let classes = 'calendar-cell';
            let content = '';
            let clickable = false;
            let clickAction = '';

            // 日期数字 — 始终显示在格子左上角
            const dayNumHtml = `<span class="cal-day-num">${day}</span>`;

            if (count > 0) {
                // 有打卡记录 — 渲染对应数量的💩图标
                classes += ' has-checkin';
                const iconSize = this._getPoopIconSize(count);
                const poops = Array.from({ length: count }, () =>
                    `<span class="cal-poop" style="font-size:${iconSize}">\u{1F4A9}</span>`
                ).join('');
                content = `${dayNumHtml}<div class="cal-poops">${poops}</div>`;

                // 过去日期的打卡记录可以删除
                if (isPast) {
                    classes += ' can-delete';
                    clickable = true;
                    clickAction = 'delete';
                }
            } else if (isPast) {
                // 过去日期无打卡 — 可补打
                classes += ' can-makeup';
                content = `${dayNumHtml}<span class="cal-plus">+</span>`;
                clickable = true;
                clickAction = 'makeup';
            } else if (isToday) {
                content = dayNumHtml;
            } else {
                // 未来日期
                classes += ' future';
                content = dayNumHtml;
            }

            if (isToday) classes += ' is-today';

            const onclickAttr = clickable
                ? ` onclick="Dashboard._onCalendarDayClick('${dateStr}', '${clickAction}')"`
                : '';
            html += `<div class="${classes}"${onclickAttr} data-date="${dateStr}">${content}</div>`;
        }

        html += '</div>';

        // 日历提示
        html += '<div class="calendar-hint">'
            + '<span class="cal-poop">\u{1F4A9}</span> \u5DF2\u6253\u5361 &nbsp;&nbsp; '
            + '<span class="cal-plus">+</span> \u70B9\u51FB\u8865\u6253\u5361 &nbsp;&nbsp; '
            + '<span class="cal-delete-hint">\u{1F5D1}\uFE0F</span> \u70B9\u51FB\u5220\u9664\u8865\u6253\u5361'
            + '</div>';

        container.innerHTML = html;

        // 检查是否是月末，显示月报按钮
        this._checkMonthlyReportButton();
    },

    // ---- 根据打卡次数计算屎图标大小（自动缩放） ----
    _getPoopIconSize(count) {
        if (count <= 1) return '1.3rem';
        if (count <= 3) return '0.85rem';
        if (count <= 6) return '0.65rem';
        return '0.5rem';
    },

    // ---- 点击日历日期 — 根据动作类型弹窗 ----
    _onCalendarDayClick(dateStr, action) {
        if (action === 'makeup') {
            this._showMakeupDialog(dateStr);
        } else if (action === 'delete') {
            this._showDeleteDialog(dateStr);
        }
    },

    // ---- 补打卡确认弹窗 ----
    _showMakeupDialog(dateStr) {
        const container = document.getElementById('celebration-container');
        if (!container) return;

        // 格式化日期显示
        const parts = dateStr.split('-');
        const displayDate = `${parseInt(parts[1])}\u6708${parseInt(parts[2])}\u65E5`;

        const overlay = document.createElement('div');
        overlay.className = 'celebration-overlay';
        overlay.innerHTML = `
            <div class="celebration-box makeup-dialog">
                <div class="peach-illustration peach-lg peach-shy celebration-peach peach-bounce"></div>
                <div class="celebration-title">\u8865\u6253\u5361\u786E\u8BA4</div>
                <div class="celebration-text">\u786E\u5B9A\u4E3A <strong>${displayDate}</strong> \u8865\u4E00\u6B21\u6253\u5361\u5417\uFF1F</div>
                <div class="makeup-buttons">
                    <button class="btn-secondary" id="makeup-cancel">\u7B97\u4E86</button>
                    <button class="btn-primary" id="makeup-confirm">\u786E\u5B9A\u8865\u6253 \u{1F4A9}</button>
                </div>
            </div>`;

        // 取消按钮
        overlay.querySelector('#makeup-cancel').addEventListener('click', () => overlay.remove());
        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        // 确认按钮
        overlay.querySelector('#makeup-confirm').addEventListener('click', async () => {
            overlay.remove();
            await this._makeupCheckin(dateStr);
        });

        container.appendChild(overlay);
    },

    // ---- 执行补打卡 ----
    async _makeupCheckin(dateStr) {
        try {
            const data = await Api.makeupCheckin(dateStr);

            if (data.success) {
                // 更新统计
                this._updateStats(data.stats);

                // 刷新日历
                await this._loadCalendar();

                const parts = dateStr.split('-');
                this._showToast('success', '\u8865\u6253\u5361\u6210\u529F\uFF01', `${parseInt(parts[1])}\u6708${parseInt(parts[2])}\u65E5\u7684\u5C4E\u8865\u4E0A\u4E86~`);
            } else {
                this._showToast('error', '\u8865\u6253\u5361\u5931\u8D25', data.message || '\u8BE5\u65E5\u671F\u5DF2\u6709\u8BB0\u5F55');
            }
        } catch (err) {
            this._showToast('error', '\u8865\u6253\u5361\u5931\u8D25', err.message || '\u8BF7\u91CD\u8BD5');
        }
    },

    // ---- 删除补打卡确认弹窗 ----
    _showDeleteDialog(dateStr) {
        const container = document.getElementById('celebration-container');
        if (!container) return;

        const parts = dateStr.split('-');
        const displayDate = `${parseInt(parts[1])}\u6708${parseInt(parts[2])}\u65E5`;

        const overlay = document.createElement('div');
        overlay.className = 'celebration-overlay';
        overlay.innerHTML = `
            <div class="celebration-box makeup-dialog">
                <div class="peach-illustration peach-lg peach-cry celebration-peach peach-bounce"></div>
                <div class="celebration-title">\u5220\u9664\u8865\u6253\u5361\uFF1F</div>
                <div class="celebration-text">\u786E\u5B9A\u5220\u9664 <strong>${displayDate}</strong> \u7684\u6253\u5361\u8BB0\u5F55\u5417\uFF1F<br>\u5220\u9664\u540E\u8BE5\u65E5\u671F\u5C06\u6062\u590D\u4E3A\u672A\u6253\u5361\u72B6\u6001\u3002</div>
                <div class="makeup-buttons">
                    <button class="btn-secondary" id="delete-cancel">\u7B97\u4E86</button>
                    <button class="btn-delete-confirm" id="delete-confirm">\u{1F5D1}\uFE0F \u786E\u5B9A\u5220\u9664</button>
                </div>
            </div>`;

        overlay.querySelector('#delete-cancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('#delete-confirm').addEventListener('click', async () => {
            overlay.remove();
            await this._deleteCheckinByDate(dateStr);
        });

        container.appendChild(overlay);
    },

    // ---- 执行删除补打卡 ----
    async _deleteCheckinByDate(dateStr) {
        try {
            const data = await Api.deleteCheckinByDate(dateStr);

            if (data.success) {
                // 更新统计
                this._updateStats(data.stats);

                // 刷新日历
                await this._loadCalendar();

                const parts = dateStr.split('-');
                this._showToast('success', '\u5220\u9664\u6210\u529F\uFF01', `${parseInt(parts[1])}\u6708${parseInt(parts[2])}\u65E5\u7684\u5C4E\u5DF2\u5438\u56DE\u53BB\u4E86~`);
            } else {
                this._showToast('error', '\u5220\u9664\u5931\u8D25', data.message || '\u8BE5\u65E5\u671F\u65E0\u8BB0\u5F55');
            }
        } catch (err) {
            this._showToast('error', '\u5220\u9664\u5931\u8D25', err.message || '\u8BF7\u91CD\u8BD5');
        }
    },

    // ---- 检查是否是月末，显示月报按钮 ----
    _checkMonthlyReportButton() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        // 如果明天的月份不等于今天的月份，说明今天是本月最后一天
        const isLastDay = tomorrow.getMonth() !== now.getMonth();

        const btn = document.getElementById('monthly-report-btn');
        if (btn) {
            btn.style.display = isLastDay ? '' : 'none';
        }
    },

    // ---- 显示月报弹窗 ----
    async _showMonthlyReport() {
        const container = document.getElementById('celebration-container');
        if (!container) return;

        // 先显示加载中
        const overlay = document.createElement('div');
        overlay.className = 'celebration-overlay';
        overlay.innerHTML = `
            <div class="celebration-box monthly-report-box">
                <div class="celebration-title">\u{1F4CA} \u6708\u62A5\u751F\u6210\u4E2D...</div>
                <div class="celebration-text">\u6B63\u5728\u6C47\u603B\u672C\u6708\u62C9\u5C4E\u6570\u636E</div>
            </div>`;
        container.appendChild(overlay);

        try {
            const report = await Api.getMonthlyReport();
            overlay.remove();
            this._renderMonthlyReport(report);
        } catch (err) {
            overlay.remove();
            this._showToast('error', '\u6708\u62A5\u751F\u6210\u5931\u8D25', err.message || '\u8BF7\u91CD\u8BD5');
        }
    },

    // ---- 渲染月报弹窗 ----
    _renderMonthlyReport(report) {
        const container = document.getElementById('celebration-container');
        if (!container) return;

        const parts = report.month.split('-');
        const monthLabel = `${parseInt(parts[0])}\u5E74${parseInt(parts[1])}\u6708`;

        // 生成趋势条形图
        const maxCount = Math.max(...report.daily_data.map(d => d.count), 1);
        const barChart = report.daily_data.length > 0
            ? report.daily_data.map(d => {
                const heightPct = Math.max((d.count / maxCount) * 100, 8);
                return `<div class="report-bar-item">
                    <div class="report-bar" style="height:${heightPct}%" title="${d.date}: ${d.count}\u6B21">
                        <span class="report-bar-count">${d.count}</span>
                    </div>
                    <span class="report-bar-day">${d.day}</span>
                </div>`;
            }).join('')
            : '<div class="report-empty">\u672C\u6708\u8FD8\u6CA1\u6709\u6253\u5361\u8BB0\u5F55</div>';

        const maxDayLabel = report.max_day
            ? `${parseInt(report.max_day.split('-')[1])}\u6708${parseInt(report.max_day.split('-')[2])}\u65E5`
            : '\u65E0';

        const overlay = document.createElement('div');
        overlay.className = 'celebration-overlay';
        overlay.innerHTML = `
            <div class="celebration-box monthly-report-box">
                <div class="peach-illustration peach-lg peach-cheer celebration-peach peach-bounce"></div>
                <div class="celebration-title">\u{1F4CA} ${monthLabel}\u62C9\u5C4E\u6708\u62A5</div>

                <div class="report-stats-grid">
                    <div class="report-stat-item">
                        <div class="report-stat-value">${report.total_count}</div>
                        <div class="report-stat-label">\u603B\u6B21\u6570</div>
                    </div>
                    <div class="report-stat-item">
                        <div class="report-stat-value">${report.daily_average}</div>
                        <div class="report-stat-label">\u65E5\u5747\u6B21\u6570</div>
                    </div>
                    <div class="report-stat-item">
                        <div class="report-stat-value">${report.days_with_checkins}/${report.current_day}</div>
                        <div class="report-stat-label">\u6253\u5361\u5929\u6570</div>
                    </div>
                    <div class="report-stat-item">
                        <div class="report-stat-value">${report.fullness_rate}%</div>
                        <div class="report-stat-label">\u52E4\u594B\u7387</div>
                    </div>
                </div>

                <div class="report-highlight">
                    <span>\u{1F4A9} \u9AD8\u4EA7\u65E5: <strong>${maxDayLabel}</strong> \uFF08${report.max_count}\u6B21\uFF09</span>
                    <span>\u{1F525} \u8FDE\u7EED\u6253\u5361: <strong>${report.current_streak}\u5929</strong></span>
                    <span>\u{1F3C6} \u6700\u957F\u8FDE\u7EED: <strong>${report.longest_streak}\u5929</strong></span>
                </div>

                <div class="report-chart-title">\u{1F4C8} \u6BCF\u65E5\u62C9\u5C4E\u8D8B\u52BF</div>
                <div class="report-chart">${barChart}</div>

                <button class="btn-primary" onclick="this.closest('.celebration-overlay').remove()">\u{1F44D} \u6536\u5230</button>
            </div>`;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        container.appendChild(overlay);
    },

    // ---- 加载实时动态（全局打卡流） ----
    async _loadFeed() {
        try {
            const data = await Api.getAllCheckins(15, 0);
            this._renderFeed(data.checkins);
        } catch (err) {
            console.error('[Dashboard] Load feed error:', err);
        }
    },

    _renderFeed(checkins) {
        const list = document.getElementById('feed-list');
        if (!list) return;

        if (!checkins || checkins.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="peach-illustration peach-md peach-confused"></div>
                    <p class="empty-state-text">\u8FD8\u6CA1\u6709\u52A8\u6001\uFF0C\u6253\u5361\u540E\u8FD9\u91CC\u4F1A\u5B9E\u65F6\u66F4\u65B0~</p>
                </div>`;
            return;
        }

        list.innerHTML = checkins.map(c => `
            <div class="feed-item">
                <span class="feed-emoji">${c.avatar_emoji || '\u{1F4A9}'}</span>
                <span class="feed-user">${this._escapeHtml(c.username)}</span>
                <span class="feed-action">\u6253\u5361\u4E86${c.note ? '\uFF1A' + this._escapeHtml(c.note) : ''}</span>
                <span class="feed-time">${this._formatTime(c.checkin_time)}</span>
            </div>`).join('');
    },

    // 暴露给 SocketClient 调用
    addFeed(data) {
        this._addFeed(data);
    },

    _addFeed(data) {
        const list = document.getElementById('feed-list');
        if (!list) return;

        // 移除空状态
        const empty = list.querySelector('.empty-state');
        if (empty) empty.remove();

        const item = document.createElement('div');
        item.className = 'feed-item';
        item.innerHTML = `
            <span class="feed-emoji">${data.emoji || '\u{1F4A9}'}</span>
            <span class="feed-user">${this._escapeHtml(data.username)}</span>
            <span class="feed-action">${data.action}${data.note ? '\uFF1A' + this._escapeHtml(data.note) : ''}</span>
            <span class="feed-time">\u521A\u521A</span>`;
        list.insertBefore(item, list.firstChild);

        // 限制最多 50 条
        while (list.children.length > 50) {
            list.removeChild(list.lastChild);
        }
    },

    // ---- 庆祝弹窗 ----
    _showCelebration(checkin) {
        const container = document.getElementById('celebration-container');
        if (!container) return;

        const overlay = document.createElement('div');
        overlay.className = 'celebration-overlay';
        overlay.innerHTML = `
            <div class="celebration-box">
                <div class="peach-illustration peach-lg peach-success celebration-peach peach-bounce"></div>
                <div class="celebration-title">\u6253\u5361\u6210\u529F\uFF01\u{1F4A9}</div>
                <div class="celebration-text">\u53C8\u901A\u7545\u4E86\u4E00\u5929~</div>
                <button class="btn-primary" onclick="this.closest('.celebration-overlay').remove()">\u597D\u8036\uFF01</button>
            </div>`;

        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        container.appendChild(overlay);

        // 3 秒后自动关闭
        setTimeout(() => {
            if (overlay.parentElement) overlay.remove();
        }, 3000);
    },

    // ---- 双规则弹幕批量推送 ----
    showReminderBatch(data) {
        DanmakuManager.handleBatch(data);
    },

    // ---- Toast 通知 ----
    _showToast(type, title, message, isMe = false) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}${isMe ? ' is-me' : ''}`;

        // 选择屁桃君表情
        let peachClass = '';
        if (type === 'success') peachClass = 'peach-success';
        else if (type === 'reminder') peachClass = 'peach-sleepy';
        else if (type === 'error') peachClass = 'peach-cry';

        toast.innerHTML = `
            ${peachClass ? `<div class="peach-illustration toast-peach ${peachClass}"></div>` : ''}
            <div class="toast-content">
                <div class="toast-title">${this._escapeHtml(title)}</div>
                <div class="toast-message">${this._escapeHtml(message)}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.classList.add('removing'); setTimeout(()=>this.parentElement.remove(),300)">\u00D7</button>`;

        container.appendChild(toast);

        // 自动关闭：提醒类 10 秒，其他 4 秒
        const duration = type === 'reminder' ? 10000 : 4000;
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('removing');
                setTimeout(() => toast.remove(), 300);
            }
        }, duration);
    },

    // ---- 辅助方法 ----
    _formatTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            const now = new Date();
            const diff = now - d;

            if (diff < 60000) return '\u521A\u521A';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}\u5206\u949F\u524D`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}\u5C0F\u65F6\u524D`;
            if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}\u5929\u524D`;

            return d.toLocaleDateString('zh-CN', {
                month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
            });
        } catch {
            return isoStr;
        }
    },

    _escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
