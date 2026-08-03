import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { createOnlineUserManager } from './onlineUsers.js';
import { checkAndSendReminderForUser } from './reminderService.js';

export function setupSocketHandlers(io, db) {
    const onlineManager = createOnlineUserManager(io);

    // Socket.io 认证中间件
    io.use((socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('NO_TOKEN'));
        }
        try {
            const payload = jwt.verify(token, config.JWT_SECRET);
            socket.userId = payload.userId;
            socket.username = payload.username;
            next();
        } catch (err) {
            next(new Error('INVALID_TOKEN'));
        }
    });

    io.on('connection', async (socket) => {
        console.log(`[Socket] User connected: ${socket.username} (id=${socket.userId})`);

        // 获取用户头像
        const user = await db.get('SELECT avatar_emoji FROM users WHERE id = ?', [socket.userId]);
        const avatarEmoji = user ? user.avatar_emoji : '\u{1F4A9}';

        // 添加到在线列表
        onlineManager.addUser(socket.userId, socket.username, avatarEmoji, socket.id);

        // 上线即检查该用户是否需要提醒
        await checkAndSendReminderForUser(socket.userId, io, db);

        socket.on('disconnect', () => {
            console.log(`[Socket] User disconnected: ${socket.username}`);
            onlineManager.removeUser(socket.userId, socket.id);
        });

        // 客户端标记提醒已查看（仅 UI 层面）
        socket.on('reminder:dismiss', () => {
            // 不做服务端处理，仅前端用
        });
    });

    return { onlineManager };
}
