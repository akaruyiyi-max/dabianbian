import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getTodayStr } from '../utils/helpers.js';

export function createAuthRouter(db) {
    const router = Router();

    // ---- 房间邀请码辅助（存储在 meta 表） ----
    function getInviteCode() {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'invite_code'").get();
        return row ? row.value : null;
    }

    // GET /api/auth/invite-status — 房间是否已初始化（是否已设置邀请码）
    router.get('/invite-status', (req, res) => {
        res.json({ initialized: !!getInviteCode() });
    });

    // POST /api/auth/setup — 第一位进入的人设置房间邀请码（仅可设置一次）
    router.post('/setup', (req, res) => {
        if (getInviteCode()) {
            return res.status(409).json({ error: 'ALREADY_INITIALIZED', message: '房间邀请码已设置，无法重复设置' });
        }
        const raw = (typeof req.body.code === 'string') ? req.body.code.trim() : '';
        if (raw.length < 4 || raw.length > 40) {
            return res.status(400).json({ error: 'INVALID_CODE', message: '邀请码需为 4-40 位字符' });
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('invite_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(raw);
        console.log('[Auth] 房间邀请码已设置');
        res.json({ success: true });
    });

    // POST /api/auth/login — 无密码模式，仅需用户名 + 房间邀请码
    router.post('/login', (req, res) => {
        const { username, code } = req.body;

        // 邀请码校验
        const inviteCode = getInviteCode();
        if (!inviteCode) {
            return res.status(400).json({ error: 'ROOM_NOT_INITIALIZED', message: '房间尚未初始化，请先设置邀请码' });
        }
        const provided = (typeof code === 'string') ? code.trim() : '';
        if (provided !== inviteCode) {
            return res.status(401).json({ error: 'INVALID_INVITE_CODE', message: '邀请码不正确' });
        }

        // 输入校验：必须为纯中文，1-20 个字符
        const trimmedRaw = (typeof username === 'string') ? username.trim() : '';
        if (!trimmedRaw || trimmedRaw.length > 20) {
            return res.status(400).json({ error: 'INVALID_USERNAME', message: '用户名需要1-20个中文字符' });
        }
        if (!/^[\u4e00-\u9fa5]+$/.test(trimmedRaw)) {
            return res.status(400).json({ error: 'INVALID_USERNAME', message: '用户名必须为纯中文' });
        }

        const trimmedName = trimmedRaw;

        // 查找用户，不存在则自动创建
        let user = db.prepare('SELECT * FROM users WHERE username = ?').get(trimmedName);
        if (!user) {
            const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(trimmedName, '');
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
            console.log(`[Auth] 新用户自动注册: ${trimmedName} (id=${user.id})`);
        }

        try {
            const token = jwt.sign({ userId: user.id, username: user.username }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    avatar_emoji: user.avatar_emoji,
                    created_at: user.created_at,
                },
            });
        } catch (err) {
            console.error('[Auth] Login error:', err);
            res.status(500).json({ error: 'INTERNAL_ERROR', message: '登录失败，请重试' });
        }
    });

    // GET /api/auth/me
    router.get('/me', (req, res) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'NO_TOKEN', message: '未提供认证令牌' });
        }
        const token = authHeader.split(' ')[1];
        try {
            const payload = jwt.verify(token, config.JWT_SECRET);
            const user = db.prepare('SELECT id, username, avatar_emoji, created_at FROM users WHERE id = ?').get(payload.userId);
            if (!user) {
                return res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
            }
            const stats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(user.id);
            const todayCount = db.prepare('SELECT COUNT(*) as c FROM checkins WHERE user_id = ? AND checkin_date = ?').get(user.id, getTodayStr()).c;
            res.json({ user, stats, today_count: todayCount });
        } catch (err) {
            return res.status(401).json({ error: 'INVALID_TOKEN', message: '令牌无效或已过期' });
        }
    });

    return router;
}
