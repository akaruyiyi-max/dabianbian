import dotenv from 'dotenv';
dotenv.config();

export const config = {
    PORT: parseInt(process.env.PORT || '3000', 10),
    JWT_SECRET: process.env.JWT_SECRET || 'default-dev-secret-change-me',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
    REMINDER_CHECK_INTERVAL_MS: parseInt(process.env.REMINDER_CHECK_INTERVAL_MS || '300000', 10),
    REMINDER_COOLDOWN_MS: parseInt(process.env.REMINDER_COOLDOWN_MS || '21600000', 10),
    REMINDER_THRESHOLD_MS: parseInt(process.env.REMINDER_THRESHOLD_MS || '86400000', 10),
};
