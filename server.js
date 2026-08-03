import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { config } from './src/config.js';
import { initDb } from './src/db.js';
import { authMiddleware } from './src/middleware/auth.js';
import { createAuthRouter } from './src/routes/authRoutes.js';
import { createCheckinRouter } from './src/routes/checkinRoutes.js';
import { setupSocketHandlers } from './src/sockets/socketHandler.js';
import { startReminderService } from './src/sockets/reminderService.js';
import { startMonthlyResetService } from './src/services/monthlyReset.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e6,
});

// 初始化数据库（Supabase REST/HTTPS 客户端，IPv4 兼容）
const db = initDb();

// 中间件
app.use(express.json());
app.use(cors());
app.use(express.static(join(__dirname, 'public')));

// 路由
app.use('/api/auth', createAuthRouter(db));
app.use('/api', authMiddleware(db), createCheckinRouter(db, io));

// Socket.io
setupSocketHandlers(io, db);
startReminderService(io, db);
startMonthlyResetService(db);

// 启动服务器
server.listen(config.PORT, () => {
    console.log(`\n  \u{1F4A9} 答辩记录仪运行中: http://localhost:${config.PORT}\n`);
});
