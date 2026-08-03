/**
 * 在线用户管理模块
 * Map<userId, { userId, username, avatarEmoji, sockets: Set<socketId> }>
 * 同一用户可能多标签页登录，用 Set 管理多个 socket 连接
 */

const onlineUsers = new Map();

export function createOnlineUserManager(io) {
    function broadcastOnlineList() {
        const list = Array.from(onlineUsers.values()).map(u => ({
            user_id: u.userId,
            username: u.username,
            avatar_emoji: u.avatarEmoji,
        }));
        io.emit('online_users:update', { users: list });
    }

    function addUser(userId, username, avatarEmoji, socketId) {
        const wasOffline = !onlineUsers.has(userId);
        if (wasOffline) {
            onlineUsers.set(userId, {
                userId,
                username,
                avatarEmoji,
                sockets: new Set(),
            });
            // 新用户上线，广播通知
            io.emit('user:online', { user_id: userId, username, avatar_emoji: avatarEmoji });
        }
        onlineUsers.get(userId).sockets.add(socketId);
        broadcastOnlineList();
    }

    function removeUser(userId, socketId) {
        const user = onlineUsers.get(userId);
        if (!user) return;
        user.sockets.delete(socketId);
        if (user.sockets.size === 0) {
            onlineUsers.delete(userId);
            io.emit('user:offline', { user_id: userId, username: user.username });
            broadcastOnlineList();
        }
    }

    function getOnlineUserIds() {
        return Array.from(onlineUsers.keys());
    }

    function isOnline(userId) {
        return onlineUsers.has(userId);
    }

    function getOnlineCount() {
        return onlineUsers.size;
    }

    return {
        addUser,
        removeUser,
        getOnlineUserIds,
        isOnline,
        getOnlineCount,
        broadcastOnlineList,
    };
}
