import { formatDateStr, addDays, getTodayStr, getYesterdayStr } from './helpers.js';

/**
 * 计算当前连续打卡天数
 * @param {string[]} checkinDates - 去重后的日期数组 'YYYY-MM-DD'，降序排列
 * @returns {number}
 */
export function calculateCurrentStreak(checkinDates) {
    if (!checkinDates || checkinDates.length === 0) return 0;

    const today = getTodayStr();
    const yesterday = getYesterdayStr();

    // 最近一次打卡必须是今天或昨天，否则连续已断
    if (checkinDates[0] !== today && checkinDates[0] !== yesterday) {
        return 0;
    }

    let streak = 1;
    for (let i = 0; i < checkinDates.length - 1; i++) {
        const expectedPrev = addDays(checkinDates[i], -1);
        if (checkinDates[i + 1] === expectedPrev) {
            streak++;
        } else {
            break;
        }
    }
    return streak;
}

/**
 * 计算历史最长连续天数
 * @param {string[]} allDates - 去重后的日期数组 'YYYY-MM-DD'，升序排列
 * @returns {number}
 */
export function calculateLongestStreak(allDates) {
    if (!allDates || allDates.length === 0) return 0;

    let longest = 1;
    let current = 1;
    for (let i = 1; i < allDates.length; i++) {
        if (allDates[i] === addDays(allDates[i - 1], 1)) {
            current++;
            longest = Math.max(longest, current);
        } else {
            current = 1;
        }
    }
    return longest;
}
