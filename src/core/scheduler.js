/**
 * 排程模組
 *
 * 使用 node-cron 管理所有定時任務。
 * 每日 9:00 AM (週一至週六) 觸發考勤申報。
 */

const cron = require('node-cron');
const { dataStore } = require('./dataStore');

class Scheduler {
    constructor() {
        this._jobs = [];
        this._attendanceHandler = null;
    }

    /**
     * 啟動排程
     * @param {object} client - WhatsApp client
     * @param {Function} attendanceTask - 考勤任務函數
     * @param {object} [config] - 配置物件（含 paths.por）
     */
    start(client, attendanceTask, config) {
        // 每日 9:00 AM，週一至週六 — 考勤申報
        const attendanceJob = cron.schedule(
            '0 9 * * 1-6',
            async () => {
                console.log('⏰ [Scheduler] 觸發每日考勤申報 (9:00 AM)');
                try {
                    const foremen = dataStore._read('foremen.json', []);
                    if (foremen.length === 0) {
                        console.log(
                            '⚠️  [Scheduler] 沒有已登記的判頭，跳過考勤'
                        );
                        return;
                    }
                    await attendanceTask(client, foremen);
                } catch (error) {
                    console.error(
                        '❌ [Scheduler] 考勤任務失敗:',
                        error.message
                    );
                }
            },
            { timezone: 'Asia/Hong_Kong' }
        );

        this._jobs.push(attendanceJob);
        console.log('⏰ 排程已設定: 每日 9:00 AM (週一至六) 觸發考勤申報');

        // 每日中午 12:00 — 重建圖紙索引（配合工作時段 09:00-18:00）
        if (config?.paths?.por) {
            const porPath = config.paths.por;
            const rebuildJob = cron.schedule(
                '0 12 * * *',
                () => {
                    console.log('⏰ [Scheduler] 觸發圖紙索引重建 (12:00 PM)');
                    (async () => {
                        try {
                            const {
                                buildIndex,
                            } = require('../../skills/drawingSearch');
                            await buildIndex(porPath);
                        } catch (error) {
                            console.error(
                                '❌ [Scheduler] 索引重建失敗:',
                                error.message
                            );
                        }
                    })();
                },
                { timezone: 'Asia/Hong_Kong' }
            );

            this._jobs.push(rebuildJob);
            console.log('⏰ 排程已設定: 每日中午 12:00 PM 重建圖紙索引');
        }
    }

    /** 停止所有排程 */
    stop() {
        for (const job of this._jobs) {
            job.stop();
        }
        this._jobs = [];
        console.log('⏰ 所有排程已停止');
    }
}

module.exports = Scheduler;
