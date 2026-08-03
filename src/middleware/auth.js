import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function authMiddleware(db) {
    return async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'NO_TOKEN', message: '未提供认证令牌' });
        }
        const token = authHeader.split(' ')[1];
        try {
            const payload = jwt.verify(token, config.JWT_SECRET);
            const user = await db.get('SELECT id, username, avatar_emoji FROM users WHERE id = ?', [payload.userId]);
            if (!user) {
                return res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
            }
            req.user = user;
            next();
        } catch (err) {
            return res.status(401).json({ error: 'INVALID_TOKEN', message: '令牌无效或已过期' });
        }
    };
}
