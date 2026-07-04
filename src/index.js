// 載入環境變數（必須在最前面）
require('dotenv').config();

// 啟動日誌攔截（必須在最前面，確保所有 console 輸出都被捕獲）
const { logStream } = require('./core/logStream');
logStream.start();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ── 核心模組 ──
const AuthManager = require('./core/authManager');
const CommandRouter = require('./core/commandRouter');
const { sessionManager } = require('./core/sessionManager');
const { dataStore } = require('./core/dataStore');
const { getDatabase } = require('./core/database');
const MonitorServer = require('./core/monitorServer');
const Scheduler = require('./core/scheduler');
const { dailyAttendanceTask } = require('../skills/workerAttendance');

// ── 工具模組 ──
const MessageLogger = require('../tools/messageLogger');
const MediaDownloader = require('../tools/mediaDownloader');
const ImageToPdf = require('../tools/imageToPdf');
const CleanupManager = require('../tools/cleanup');
const HealthMonitor = require('../tools/healthMonitor');
const ErrorRecovery = require('../tools/errorRecovery');
const WeatherReporter = require('../tools/weatherReporter');
const NewsReporter = require('../tools/newsReporter');

// ── 啟動時清理上次 crash 遺留嘅暫存 JSON（防止累積耗盡磁碟）
try {
    const { cleanupOrphanedTempFiles } = require('../tools/dwgReader');
    cleanupOrphanedTempFiles();
} catch {}

// ── 命令登記 ──
const { registerAll } = require('./modules/commands');

// ── 載入配置 ──
const configPath = path.join(__dirname, '../configs/settings.json');
let config = {};

try {
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
} catch (error) {
    console.error('❌ 載入配置檔案失敗:', error.message);
    config = {
        bot: { prefix: '!' },
        logging: { level: 'info' },
        features: { reply_in_group: true },
        message_logging: { enabled: true },
    };
}

// ── 初始化核心 ──
const authManager = new AuthManager(config);

// ── 初始化工具模組 ──
const messageLogger = new MessageLogger(config.message_logging);
const mediaDownloader = new MediaDownloader(config.media_download);
const imageToPdf = new ImageToPdf(config.media_download);
const cleanupManager = new CleanupManager(config);
const healthMonitor = new HealthMonitor(config);
const errorRecovery = new ErrorRecovery(config);
const weatherReporter = new WeatherReporter(config);
const newsReporter = new NewsReporter(config);

// ── 服務容器（傳遞給所有命令處理器） ──
// ── 初始化監控伺服器 ──
const monitorServer = new MonitorServer(3456);

const services = {
    config,
    authManager,
    sessionManager,
    dataStore,
    monitorServer,
    messageLogger,
    mediaDownloader,
    imageToPdf,
    cleanupManager,
    healthMonitor,
    errorRecovery,
    weatherReporter,
    newsReporter,
};

// 啟動監控伺服器（傳遞 services 供 API 使用）
monitorServer.start(services);

// ── 初始化命令路由器 ──
const commandRouter = new CommandRouter(authManager, config);
registerAll(commandRouter);

// ── 排程器實例（防止重新連線時重複建立） ──
let _scheduler = null;

// ── 初始化 WhatsApp 客戶端 ──
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'pbots-client' }),
    puppeteer: {
        headless: true,
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            // 更新 user agent 以相容新版 WhatsApp Web
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        ],
    },
});

// ── QR Code 事件 ──
client.on('qr', async (qr) => {
    console.log('🔐 QR Code 生成成功，請掃描登入:');
    console.log(`🔍 QR 資料預覽: ${qr.substring(0, 80)}...`);
    qrcodeTerminal.generate(qr, { small: true });

    try {
        // 保存 QR Code 圖片
        const qrDir = path.join(__dirname, '../data');
        if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
        const qrPath = path.join(qrDir, 'qr-code.png');
        await QRCode.toFile(qrPath, qr, { width: 600, margin: 2 });

        // 傳遞 QR Data URL 給監控伺服器（顯示在儀表板登入頁）
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 500, margin: 2 });
        monitorServer.setQrDataUrl(qrDataUrl);

        // 自動打開瀏覽器顯示 QR Code 頁面
        try {
            const { exec } = require('child_process');
            const cmd = process.platform === 'win32' ? 'start' : 'open';
            exec(`${cmd} http://localhost:3456`);
        } catch {}

        console.log(`📱 QR Code 圖片: ${qrPath}`);
    } catch (err) {
        console.error('❌ 保存 QR Code 圖片失敗:', err.message);
    }
});

// ── 客戶端就緒 ──
client.on('ready', async () => {
    console.log('✅ PBOTS 機器人已準備就緒！');
    console.log(`🤖 機器人名稱: ${config.bot?.name || 'PBOTS'}`);
    console.log(`🔧 命令前綴: ${config.bot?.prefix || '!'}`);
    console.log(
        `🔔 群組回覆: ${config.features?.reply_in_group ? '✅ 已啟用' : '❌ 已禁用'}`
    );
    console.log(
        `📝 訊息日誌: ${config.message_logging?.enabled ? '✅ 已啟用' : '❌ 已禁用'}`
    );
    console.log(
        `📥 媒體下載: ${config.media_download?.enabled ? '✅ 已啟用' : '❌ 已禁用'}`
    );
    console.log(
        `🔐 白名單模式: ${config.security?.whitelist_enabled ? '✅ 已啟用' : '❌ 已禁用'}`
    );
    console.log(`👑 管理員數量: ${authManager.adminNumbers.size}`);
    console.log(`👥 授權群組: ${authManager.authorizedGroups.size}`);

    // 切換監控伺服器為儀表板模式
    monitorServer.setReady(true);

    // 啟動排程模組（防止重新連線時重複建立）
    try {
        if (_scheduler) _scheduler.stop();
        _scheduler = new Scheduler();
        _scheduler.start(client, dailyAttendanceTask, config);
    } catch (schedErr) {
        console.error('❌ 排程器啟動失敗:', schedErr.message);
    }

    try {
        await healthMonitor.initialize();
        console.log('✅ 健康監控系統已啟動');
    } catch (error) {
        console.error('❌ 健康監控系統啟動失敗:', error.message);
    }

    console.log('📱 開始監聽訊息...');
});

// ── 輔助函數 ──

async function getGroupInfo(message) {
    try {
        if (message.from.endsWith('@g.us')) {
            const chat = await message.getChat();
            return {
                groupName: chat.name || 'Unknown Group',
                participants: chat.participants?.length || 0,
            };
        }
    } catch (error) {
        console.error('❌ 獲取群組信息失敗:', error.message);
    }
    return { groupName: null, participants: 0 };
}

async function getSenderInfo(message) {
    try {
        const contact = await message.getContact();
        // 保留 WhatsApp 原始 ID 格式（@c.us 或 @lid）
        const rawId =
            contact.id?._serialized ||
            contact.number ||
            message.author ||
            message.from;
        let phoneNumber = rawId;
        if (phoneNumber.includes('@')) phoneNumber = phoneNumber.split('@')[0];
        return {
            pushname: contact.pushname || contact.name || 'Unknown',
            number: phoneNumber,
            whatsappId: rawId,
        };
    } catch (error) {
        console.error('❌ 獲取發送者信息失敗:', error.message);
    }
    const rawId = message.author || message.from;
    let phoneNumber = rawId;
    if (phoneNumber.includes('@')) phoneNumber = phoneNumber.split('@')[0];
    return { pushname: 'Unknown', number: phoneNumber, whatsappId: rawId };
}

function formatSourcePrefix(isGroup, groupName) {
    return isGroup ? `[GROUP - ${groupName}]` : '[PRIVATE]';
}

// ── 訊息處理（核心路由） ──
//
// 路由優先級：
//   1. SessionManager 活躍會話攔截 → 所有訊息路由到會話 handler
//   2. 媒體自動下載
//   3. 命令路由 → CommandRouter
//
// 互動規則（由 SessionManager 強制執行）：
//   - 群組觸發命令 → 中間問答經私訊進行 → 最終結果發回群組
//   - 私訊觸發命令 → 所有問答在私訊中完成
//
client.on('message', async (message) => {
    let context = null;

    try {
        if (message.fromMe) return;

        const messageBody = message.body.trim();

        // 建構標準化 Context
        const isGroup = message.from.endsWith('@g.us');
        const groupInfo = await getGroupInfo(message);
        const senderInfo = await getSenderInfo(message);
        const sourcePrefix = formatSourcePrefix(isGroup, groupInfo.groupName);

        context = {
            userId: senderInfo.number,
            originId: message.from,
            whatsappId: senderInfo.whatsappId, // 完整 WhatsApp ID（含 @c.us 或 @lid 後綴）
            isGroup,
            pushname: senderInfo.pushname,
            messageBody,
            message,
            groupName: groupInfo.groupName,
            groupId: isGroup ? message.from : null,
        };

        // 記錄訊息（失敗唔影響命令路由）
        try { await messageLogger.logMessage(message, context); } catch (logErr) {
            console.warn('⚠️ 記錄訊息失敗:', logErr.message);
        }

        // ── 優先級 1：SessionManager 群組鎖定攔截 ──
        // Phase 7：如果群組已被其他用戶鎖定（有進行中的互動會話），
        // 非發起人的命令不應干擾會話
        if (isGroup) {
            const lockOwner = sessionManager.getGroupLock(message.from);
            if (lockOwner && lockOwner !== context.userId) {
                // 群組已被其他用戶鎖定 → 只有發起人的訊息會被處理
                const parsedCmd = commandRouter.parseCommand(messageBody);
                if (parsedCmd) {
                    // 如果是命令，提示用戶群組已被鎖定
                    console.log(
                        `⛔ 群組 ${message.from} 已被用戶 ${lockOwner} 鎖定，忽略 ${context.userId} 的命令: ${parsedCmd.command}`
                    );
                    // 不發送回覆，避免打亂群組
                }
                healthMonitor.recordMessage();
                return;
            }
        }

        // ── 優先級 2：SessionManager 活躍會話攔截 ──
        // 如果用戶有進行中的互動會話，訊息路由到會話 handler
        if (sessionManager.hasActive(context.userId)) {
            const handled = await sessionManager.routeMessage(
                context.userId,
                message,
                client
            );
            if (handled) {
                healthMonitor.recordMessage();
                return;
            }
        }

        // ── 優先級 3：自動媒體下載（失敗唔影響命令路由） ──
        if (message.hasMedia) {
            try {
                const mediaResult = await mediaDownloader.downloadMedia(
                    message,
                    senderInfo.pushname
                );
                if (mediaResult) {
                    try {
                        await messageLogger.logMessage(message, {
                            ...context,
                            mediaPath: mediaResult.filePath,
                            mediaType: mediaResult.mediaType,
                            fileSize: mediaResult.fileSize,
                        });
                    } catch (mlErr) { /* 記錄媒體日誌失敗唔影響流程 */ }
                }
            } catch (dlErr) {
                console.warn('⚠️ 媒體下載失敗:', dlErr.message);
            }
        }

        // 記錄到健康監控
        healthMonitor.recordMessage();

        // 顯示接收到的訊息
        const mediaIcon = message.hasMedia ? '📎 ' : '';
        console.log(
            `📩 ${sourcePrefix} ${senderInfo.pushname}: ${mediaIcon}${messageBody}`
        );

        // ── 優先級 4：命令路由 ──
        // 群組回覆開關
        const parsed = commandRouter.parseCommand(messageBody);
        if (
            parsed &&
            isGroup &&
            !config.features?.reply_in_group &&
            parsed.command !== 'whitelist'
        ) {
            console.log(`⏸️ 群組回覆已禁用，忽略命令: ${parsed.command}`);
            return;
        }

        const handled = await commandRouter.route(
            message,
            context,
            client,
            services
        );
        if (handled && parsed) {
            console.log(
                `✅ 已處理命令: ${parsed.command} 來自 ${context.userId}`
            );
        }
    } catch (error) {
        errorRecovery.recordError(error, {
            action: 'handleMessage',
            userId: context?.userId || 'unknown',
            messageBody: context?.messageBody || '',
        });

        console.error('❌ 處理消息時發生錯誤:', error);
        try {
            await message.reply('❌ 處理命令時發生錯誤，請稍後再試。');
        } catch {}
    }
});

// ── 錯誤處理 ──

client.on('auth_failure', async () => {
    const error = new Error('WhatsApp 認證失敗');
    errorRecovery.recordError(error, { action: 'auth_failure' });
    console.error('❌ 認證失敗，請重新掃描 QR Code');
    await errorRecovery.handleAuthError(error);
});

client.on('disconnected', async (reason) => {
    const error = new Error(`連接中斷: ${reason}`);
    errorRecovery.recordError(error, { action: 'disconnected', reason });
    console.log(`🔌 連接中斷: ${reason}`);
    console.log('🔄 嘗試重新連接...');
    await errorRecovery.handleConnectionError(error, client);
});

client.on('change_state', (state) => {
    console.log(`🔍 狀態變更: ${state}`);
    errorRecovery.updateHeartbeat();
});

// ── 啟動 ──
console.log('🚀 啟動 PBOTS 機器人...');
console.log('📁 項目路徑:', __dirname);
console.log('🔧 配置載入:', configPath);

client.initialize().catch((error) => {
    console.error('❌ 啟動失敗:', error);
    process.exit(1);
});

// ── 優雅關閉 ──
async function gracefulShutdown(signal) {
    console.log(`\n🛑 收到 ${signal}，正在關閉機器人...`);

    try { if (_scheduler) _scheduler.stop(); } catch (e) { /* ignore */ }
    try { monitorServer.stop(); } catch (e) { /* ignore */ }
    try { healthMonitor.stop(); } catch (e) { /* ignore */ }
    try { messageLogger.cleanupOldLogs(30); } catch (e) { /* ignore */ }
    try { authManager.cleanupOldRecords(30); } catch (e) { /* ignore */ }
    try { mediaDownloader.cleanupOldMedia(30); } catch (e) { /* ignore */ }
    try { healthMonitor.cleanupOldErrors(30); } catch (e) { /* ignore */ }
    try { errorRecovery.cleanupOldErrors(30); } catch (e) { /* ignore */ }
    try { getDatabase().close(); } catch (e) { /* ignore */ }

    try {
        await client.destroy();
    } catch (destroyErr) {
        console.warn('⚠️ 關閉客戶端時出錯:', destroyErr.message);
    }

    console.log('👋 PBOTS 機器人已關閉');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = { client, messageLogger };
