/**
 * 命令登記模組
 *
 * 所有需要多步驟互動的命令（whitelist、topdf 等）統一透過 SessionManager 管理，
 * 確保以下規則：
 *   1. 群組觸發 → 中間問答經私訊 → 最終結果發回群組
 *   2. 私訊觸發 → 全部在私訊中完成
 *
 * Session handler 介面：{ name, start(ctx, meta), handleReply(ctx, message) }
 *   - start 回傳：{ done: true, result: "..." } 或 { question: "..." }
 *   - handleReply 回傳：{ done: true, result: "..." } 或 { question: "..." }
 */

const fs = require('fs');
const path = require('path');

function registerAll(router) {
    // ========== 基礎命令（無需權限） ==========
    router.register('ping', pingHandler, { requireAuth: false });
    router.register('help', helpHandler, { requireAuth: false });
    router.register('status', statusHandler, { requireAuth: false });
    router.register('stats', statsHandler, { requireAuth: false });
    router.register('weather', weatherHandler, {
        requireAuth: false,
        aliases: ['天氣'],
    });
    router.register('news', newsHandler, {
        requireAuth: false,
        aliases: [
            '新聞',
            'construction',
            '地盤',
            'monitor',
            '監控',
            'accident',
            '意外',
        ],
    });
    router.register('whitelist', whitelistHandler, { requireAuth: false });

    // ========== Hash 命令 ==========
    router.register('topdf', topdfHandler, { requireAuth: true, isHash: true });
    router.register('done', doneHandler, { requireAuth: true, isHash: true });
    router.register('cancel', cancelSessionHandler, {
        requireAuth: true,
        isHash: true,
    });

    // ========== 管理員命令 ==========
    router.register('cleanup', cleanupHandler, { requireAuth: true });
    router.register('mediastats', mediastatsHandler, { requireAuth: true });
    router.register('security', securityHandler, { requireAuth: true });
    router.register('cleanupwhitelist', cleanupWhitelistHandler, {
        requireAuth: true,
    });
    router.register('addgroup', addGroupHandler, { requireAuth: true });
    router.register('removegroup', removeGroupHandler, { requireAuth: true });

    // ========== 考勤命令 ==========
    router.register('申報', reportHandler, { requireAuth: true, isHash: true });
    router.register('今日人數', todayCountHandler, {
        requireAuth: true,
        isHash: true,
    });
    router.register('登記判頭', registerForemanHandler, {
        requireAuth: true,
        isHash: true,
    });
    router.register('判頭列表', listForemenHandler, {
        requireAuth: true,
        isHash: true,
    });
    router.register('移除判頭', removeForemanHandler, {
        requireAuth: true,
        isHash: true,
    });

    // ========== 物料圖紙命令 ==========
    router.register('Drawing', drawingHandler, {
        requireAuth: true,
        isHash: true,
        aliases: ['圖紙'],
    });
    router.register('searchpor', rebuildIndexHandler, {
        requireAuth: true,
        isHash: true,
        aliases: ['重建索引'],
    });
    router.register('dwgfind', dwgFindHandler, {
        requireAuth: true,
        isHash: true,
        aliases: ['找位置圖', 'findlayout'],
    });
    router.register('rebuildTg', rebuildTgHandler, {
        requireAuth: true,
        isHash: true,
        aliases: ['重建位置圖', 'rebuildtg'],
    });
}

// =====================================================================
// 簡單命令（單步完成）
// =====================================================================

async function pingHandler(message) {
    await message.reply('pong');
}

async function helpHandler(message, context, _client, { authManager }) {
    await message.reply(authManager.generateHelpMessage(context.userId));
}

async function statusHandler(message, _ctx, _client, { config, authManager }) {
    await message.reply(
        '🤖 *PBOTS 狀態*\n\n' +
            `• 運行時間: ${new Date().toLocaleString()}\n` +
            `• 群組回覆: ${config.features?.reply_in_group ? '✅ 已啟用' : '❌ 已禁用'}\n` +
            `• 訊息日誌: ${config.message_logging?.enabled ? '✅ 已啟用' : '❌ 已禁用'}\n` +
            `• 媒體下載: ${config.media_download?.enabled ? '✅ 已啟用' : '❌ 已禁用'}\n` +
            `• 白名單模式: ${config.security?.whitelist_enabled ? '✅ 已啟用' : '❌ 已禁用'}\n` +
            `• 管理員數量: ${authManager.adminNumbers.size}\n` +
            `• 授權群組: ${authManager.authorizedGroups.size}\n` +
            `• 版本: ${config.project?.version || '1.0.0'}`
    );
}

async function statsHandler(message, _ctx, _client, { messageLogger }) {
    const stats = messageLogger.getTodayStats();
    await message.reply(messageLogger.formatStats(stats));
}

async function mediastatsHandler(message, _ctx, _client, { mediaDownloader }) {
    const stats = mediaDownloader.getMediaStats();
    await message.reply(mediaDownloader.formatMediaStats(stats));
}

async function securityHandler(message, _ctx, _client, { authManager }) {
    const status = authManager.getSecurityStatus();
    await message.reply(authManager.formatSecurityStatus(status));
}

async function cleanupHandler(message, _ctx, _client, { cleanupManager }) {
    await message.reply('🔄 正在執行系統清理，請稍候...');
    try {
        const results = await cleanupManager.performCleanup(30);
        await message.reply(cleanupManager.formatCleanupResults(results));
    } catch (error) {
        await message.reply(`❌ 清理失敗: ${error.message}`);
    }
}

async function cleanupWhitelistHandler(
    message,
    _ctx,
    _client,
    { authManager }
) {
    try {
        const result = await authManager.resetAll();
        if (result.success) {
            await message.reply(
                '🧹 *白名單清理完成*\n\n✅ 所有白名單註冊數據已清理\n• 管理員列表: 已清空\n• 授權群組: 已清空\n• 配置文件: 已更新\n\n💡 系統已重置為初始狀態，所有用戶需要重新認證。'
            );
        } else {
            await message.reply(`❌ 清理失敗: ${result.message}`);
        }
    } catch (error) {
        await message.reply(`❌ 清理白名單失敗: ${error.message}`);
    }
}

async function weatherHandler(message, _ctx, _client, { weatherReporter }) {
    await message.reply('🌤️ 正在獲取香港天氣資訊，請稍候...');
    try {
        const result = await weatherReporter.getCompleteWeatherReport();
        await message.reply(
            result.success ? result.report : '❌ 獲取天氣資訊失敗，請稍後再試。'
        );
    } catch (error) {
        await message.reply(`❌ 天氣報告失敗: ${error.message}`);
    }
}

async function newsHandler(message, _ctx, _client, { newsReporter }) {
    try {
        await message.reply('📰 正在獲取香港地盤意外新聞，請稍候...');
        const report = await newsReporter.getConstructionAccidentNews();
        await message.reply(report);
    } catch (error) {
        await message.reply(`❌ 新聞報告失敗: ${error.message}`);
    }
}

// =====================================================================
// !whitelist — 支援 SessionManager 互動流程
// =====================================================================

async function whitelistHandler(
    message,
    context,
    client,
    { authManager, sessionManager }
) {
    const body = context.messageBody;
    const parts = body.startsWith('!')
        ? body.slice(1).trim().split(/\s+/)
        : body.trim().split(/\s+/);
    const inlinePassword = parts.slice(1).join(' ');

    // ── 模式 1：內聯認證 `!whitelist <密碼>` ──
    if (inlinePassword) {
        const result = authManager.authenticateDirect(
            context.userId,
            inlinePassword
        );
        await message.reply(result.message);
        return;
    }

    // ── 模式 2：SessionManager 互動流程 ──
    // 定義 whitelist session handler
    const whitelistSessionHandler = {
        name: '管理員認證',

        async start(ctx, _meta) {
            ctx.attempts = 0;
            ctx.maxAttempts = 3;
            return {
                question:
                    '🔐 *管理員認證*\n\n' +
                    '請輸入認證密碼以獲取管理員權限：\n' +
                    `💡 您有 ${ctx.maxAttempts} 次嘗試機會\n` +
                    '⏰ 會話將在 5 分鐘後自動過期\n\n' +
                    '輸入 *#cancel* 取消認證',
            };
        },

        async handleReply(ctx, replyMessage) {
            const input = replyMessage.body.trim();

            // 檢查取消
            if (input === '#cancel') {
                return { done: true, result: '❌ *認證已取消*' };
            }

            ctx.attempts++;
            const result = authManager.authenticateDirect(ctx.userId, input);

            if (result.success) {
                return {
                    done: true,
                    result:
                        '✅ *認證成功！*\n\n' +
                        '👑 您已成為系統管理員\n' +
                        `📱 用戶ID: ${ctx.userId}\n` +
                        `⏰ 生效時間: ${new Date().toLocaleString()}\n\n` +
                        '💡 *可用命令:*\n' +
                        '!help - 查看完整命令列表\n' +
                        '#TOPDF - 照片收集→PDF\n' +
                        '#申報 - 考勤申報\n' +
                        '#登記判頭 - 登記判頭\n' +
                        '!security - 安全狀態\n' +
                        '!cleanup - 系統清理',
                };
            }

            const remaining = ctx.maxAttempts - ctx.attempts;
            if (remaining <= 0) {
                return {
                    done: true,
                    result: '❌ *認證失敗*\n\n您已達到最大嘗試次數。\n💡 請重新發起 !whitelist 命令。',
                };
            }

            return {
                question: `❌ *密碼錯誤*\n\n您還有 ${remaining} 次嘗試機會\n請重新輸入認證密碼：`,
            };
        },

        async onTimeout(_ctx) {
            return '⏰ *認證會話已超時*\n請重新發起 !whitelist 命令。';
        },

        async onCancel(_ctx) {
            return '❌ *認證已取消*';
        },
    };

    // 啟動會話（傳入 senderId 以確保 DM 使用正確的 WhatsApp ID 格式）
    const result = await sessionManager.start(
        context.userId,
        context.originId,
        whitelistSessionHandler,
        { userId: context.userId },
        client,
        null,
        context.whatsappId || (context.isGroup ? null : context.originId)
    );

    if (!result.success) {
        await message.reply(result.message || '❌ 啟動認證失敗');
    } else if (result.isGroup && result.message) {
        // 群組觸發 → 在群組中提示用戶檢查私訊
        await message.reply(result.message);
    }
}

// =====================================================================
// #TOPDF / #done / #cancel — 統一使用 SessionManager
// =====================================================================

function _makePdfSessionHandler(imageToPdf) {
    return {
        name: '照片收集 PDF',

        async start(ctx) {
            const title = ctx.title || '';

            if (!title) {
                ctx.state = 'waiting_title';
                return {
                    question:
                        '📸 *PDF 生成 - 第一步*\n\n' +
                        '請輸入此 PDF 的標題（例如：地盤安全巡查報告）：\n\n' +
                        '輸入 *#cancel* 取消',
                };
            }

            // 有標題 → 直接進入收集模式
            ctx.state = 'collecting';
            ctx.photos = [];
            return {
                question:
                    '📸 *PDF 收集已開始*\n\n' +
                    `📄 *標題:* ${title}\n` +
                    '📷 *已收集:* 0 張照片\n\n' +
                    '請發送照片（可附帶說明文字）。\n' +
                    '發送 *#done* 完成並生成 PDF。\n' +
                    '發送 *#cancel* 取消。',
            };
        },

        async handleReply(ctx, replyMessage) {
            const input = replyMessage.body.trim();

            // 處理取消
            if (input === '#cancel') {
                // 清理暫存照片
                if (ctx.photos) {
                    ctx.photos.forEach((p) => {
                        try {
                            fs.unlinkSync(p.path);
                        } catch {}
                    });
                }
                return { done: true, result: '❌ *PDF 收集已取消*' };
            }

            // 等待標題狀態
            if (ctx.state === 'waiting_title') {
                ctx.title = input;
                ctx.state = 'collecting';
                ctx.photos = [];
                return {
                    question:
                        '📸 *PDF 收集已開始*\n\n' +
                        `📄 *標題:* ${ctx.title}\n` +
                        '📷 *已收集:* 0 張照片\n\n' +
                        '請發送照片（可附帶說明文字作為圖片描述）。\n' +
                        '發送 *#done* 完成並生成 PDF。\n' +
                        '發送 *#cancel* 取消。',
                };
            }

            // 收集狀態 — 處理 #done
            if (ctx.state === 'collecting' && input === '#done') {
                if (!ctx.photos || ctx.photos.length === 0) {
                    return {
                        question:
                            '❌ 尚未收到任何照片，請先發送照片，或輸入 *#cancel* 取消。',
                    };
                }

                // 生成 PDF
                try {
                    const tmpDir = path.join(imageToPdf.pdfPath, '.tmp');
                    if (!fs.existsSync(tmpDir))
                        fs.mkdirSync(tmpDir, { recursive: true });

                    // 使用 ImageToPdf 現有的 PDF 生成邏輯
                    const pdfResult = await _generatePdf(imageToPdf, ctx);
                    const title = ctx.title || 'PDF 報告';

                    // 清理暫存
                    ctx.photos.forEach((p) => {
                        try {
                            fs.unlinkSync(p.path);
                        } catch {}
                    });

                    return {
                        done: true,
                        result:
                            '📄 *PDF 生成完成！*\n\n' +
                            `📄 *標題:* ${title}\n` +
                            `📷 *照片數量:* ${pdfResult.imageCount} 張\n` +
                            `📁 *檔案大小:* ${_formatSize(pdfResult.fileSize)}`,
                        attachment: pdfResult.pdfPath,
                        attachmentCaption: `📄 ${title}`,
                    };
                } catch (error) {
                    return {
                        done: true,
                        result: `❌ PDF 生成失敗: ${error.message}`,
                    };
                }
            }

            // 收集狀態 — 處理照片
            if (ctx.state === 'collecting' && replyMessage.hasMedia) {
                try {
                    const media = await replyMessage.downloadMedia();
                    if (media) {
                        const buffer = Buffer.from(media.data, 'base64');
                        const caption = input || '';
                        const fileName =
                            replyMessage.filename || `photo_${Date.now()}.jpg`;

                        const tmpDir = path.join(imageToPdf.pdfPath, '.tmp');
                        if (!fs.existsSync(tmpDir))
                            fs.mkdirSync(tmpDir, { recursive: true });
                        const filePath = path.join(
                            tmpDir,
                            `${Date.now()}_${fileName}`
                        );

                        fs.writeFileSync(filePath, buffer);
                        ctx.photos.push({
                            path: filePath,
                            name: fileName,
                            caption,
                            size: buffer.length,
                        });

                        return {
                            question:
                                `✅ 已收到第 ${ctx.photos.length} 張照片` +
                                (caption ? `\n📝 說明: ${caption}` : '') +
                                '\n\n繼續發送照片，或發送 *#done* 生成 PDF。',
                        };
                    }
                } catch (error) {
                    console.error('❌ 處理照片失敗:', error.message);
                    return { question: '❌ 無法處理此照片，請重新發送。' };
                }
            }

            // 未知輸入
            return {
                question:
                    '💡 請發送照片，或輸入以下命令：\n' +
                    '• *#done* - 完成並生成 PDF\n' +
                    '• *#cancel* - 取消收集',
            };
        },

        async onTimeout(ctx) {
            if (ctx.photos) {
                ctx.photos.forEach((p) => {
                    try {
                        fs.unlinkSync(p.path);
                    } catch {}
                });
            }
            return '⏰ *PDF 收集會話已超時*\n請重新發起 #TOPDF 命令。';
        },

        async onCancel(ctx) {
            if (ctx.photos) {
                ctx.photos.forEach((p) => {
                    try {
                        fs.unlinkSync(p.path);
                    } catch {}
                });
            }
            return '❌ *PDF 收集已取消*';
        },
    };
}

/** 使用 ImageToPdf 的 PDF 生成引擎 */
async function _generatePdf(imageToPdf, ctx) {
    // 複用 ImageToPdf.createPdf 的核心邏輯
    // 注意：這裡需要訪問 createPdf 方法，但它是 instance method
    // 我們直接呼叫 imageToPdf 的內部方法
    const pdfFileName = imageToPdf.generatePdfFileName(
        ctx.userId,
        ctx.title || 'document'
    );
    const pdfFilePath = path.join(imageToPdf.pdfPath, pdfFileName);

    await imageToPdf.createPdf(
        ctx.photos,
        ctx.title || 'PDF 報告',
        pdfFilePath
    );

    const stats = fs.statSync(pdfFilePath);
    return {
        pdfPath: pdfFilePath,
        fileName: pdfFileName,
        fileSize: stats.size,
        imageCount: ctx.photos.length,
    };
}

function _formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function topdfHandler(
    message,
    context,
    client,
    { imageToPdf, sessionManager }
) {
    const body = context.messageBody;
    const title = body.replace(/#TOPDF/i, '').trim();

    // 檢查用戶已有會話
    if (sessionManager.hasActive(context.userId)) {
        await message.reply(
            '❌ 您已有一個進行中的會話。請先完成或取消（#cancel）。'
        );
        return;
    }

    const handler = _makePdfSessionHandler(imageToPdf);

    const result = await sessionManager.start(
        context.userId,
        context.originId,
        handler,
        { userId: context.userId, title },
        client,
        null,
        context.whatsappId || (context.isGroup ? null : context.originId)
    );

    if (!result.success) {
        await message.reply(result.message || '❌ 啟動 PDF 收集失敗');
    } else if (result.isGroup && result.message) {
        // 群組觸發 → 提示用戶檢查私訊
        await message.reply(result.message);
    }
    // 私訊觸發 → sessionManager.start 已發送第一條問題，無需額外回覆
}

async function doneHandler(message, context, client, { sessionManager }) {
    // #done 命令：如果用戶有活躍的 PDF 會話，直接路由到會話 handler
    if (sessionManager.hasActive(context.userId)) {
        await sessionManager.routeMessage(context.userId, message, client);
    } else {
        await message.reply(
            '❌ 您沒有進行中的 PDF 收集會話。\n請先用 #TOPDF [標題] 開始。'
        );
    }
}

async function cancelSessionHandler(
    message,
    context,
    client,
    { sessionManager }
) {
    // #cancel 命令：取消用戶的活躍會話
    if (sessionManager.hasActive(context.userId)) {
        await sessionManager.cancel(context.userId, client);
    } else {
        await message.reply('❌ 您沒有進行中的會話。');
    }
}

// =====================================================================
// 授權群組管理
// =====================================================================

async function addGroupHandler(message, context, _client, { authManager }) {
    if (!context.groupId) {
        await message.reply(
            '❌ 此命令只能在群組中使用。\n請在欲授權的群組內發送 !addgroup。'
        );
        return;
    }
    authManager.addAuthorizedGroup(context.groupId);
    await message.reply(
        '✅ *群組已授權*\n\n' +
            `📱 群組 ID: ${context.groupId}\n` +
            `📋 群組名稱: ${context.groupName || '未知'}\n\n` +
            '💡 此群組的所有成員現在擁有完整系統權限，無需個別認證。'
    );
}

async function removeGroupHandler(message, context, _client, { authManager }) {
    const parts = context.messageBody.trim().split(/\s+/);
    const targetGroupId = parts[1] || context.groupId;

    if (!targetGroupId) {
        await message.reply(
            '❌ 請指定要移除的群組 ID。\n用法：!removegroup <groupId>\n或在群組內直接發送 !removegroup。'
        );
        return;
    }

    authManager.removeAuthorizedGroup(targetGroupId);
    await message.reply(`✅ 已移除授權群組: ${targetGroupId}`);
}

// =====================================================================
// 考勤命令
// =====================================================================

const {
    removeForeman,
    getForemen,
    getTodayReport,
    makeAttendanceHandler,
    makeRegisterForemanHandler,
    getExcelColumns,
} = require('../../skills/workerAttendance');

async function reportHandler(message, context, client, { sessionManager }) {
    // 找出匹配此用戶的判頭記錄
    const foremen = getForemen();
    const foreman = foremen.find((f) => f.phone === context.userId);

    if (!foreman) {
        await message.reply(
            '❌ 找不到您的判頭登記記錄。\n' +
                '請管理員使用 `#登記判頭 [電話] [姓名] [公司] [Excel欄位]` 登記。'
        );
        return;
    }

    if (sessionManager.hasActive(context.userId)) {
        await message.reply('⏰ 您已有一個進行中的申報會話，請先完成或取消。');
        return;
    }

    const handler = makeAttendanceHandler(foreman);
    const result = await sessionManager.start(
        context.userId,
        context.originId,
        handler,
        {},
        client,
        null,
        context.whatsappId || context.originId
    );

    if (result.success && result.isGroup && result.message) {
        await message.reply(result.message);
    }
}

async function todayCountHandler(message) {
    const report = await getTodayReport();
    if (!report) {
        await message.reply('📊 今日尚未有申報記錄。');
        return;
    }

    let text = '📊 *今日開工人數*\n\n';
    text += `📅 日期: ${new Date().toLocaleDateString('zh-HK')}\n\n`;
    for (const company of report.headerRow || []) {
        const count =
            report.counts[company] !== undefined ? report.counts[company] : '-';
        text += `• *${company}*: ${count} 人\n`;
    }
    text += `\n👷 *總數: ${report.total} 人*`;

    await message.reply(text);
}

async function registerForemanHandler(
    message,
    context,
    client,
    { sessionManager }
) {
    // 互動對話形式登記判頭
    // 自動擷取 WhatsApp ID，讓用戶從 Excel 欄位列表中選擇公司
    if (sessionManager.hasActive(context.userId)) {
        await message.reply('⏰ 您已有一個進行中的會話，請先完成或取消。');
        return;
    }

    // 檢查 Excel 是否有欄位
    const columns = await getExcelColumns();
    if (columns.length === 0) {
        await message.reply('❌ 無法讀取 Excel 欄位，請確認範本檔案存在。');
        return;
    }

    const handler = makeRegisterForemanHandler();

    // 傳遞額外 context：userId, pushname, groupId
    const result = await sessionManager.start(
        context.userId,
        context.originId,
        handler,
        {
            userId: context.userId,
            pushname: context.pushname,
            groupId: context.groupId,
        },
        client,
        null,
        context.whatsappId || context.originId
    );

    if (result.success && result.isGroup && result.message) {
        await message.reply(result.message);
    }
}

async function listForemenHandler(message) {
    const foremen = getForemen();
    if (foremen.length === 0) {
        await message.reply('📋 尚未登記任何判頭。');
        return;
    }

    let text = '📋 *已登記判頭列表*\n\n';
    foremen.forEach((f, i) => {
        text += `${i + 1}. *${f.name}* — ${f.company}\n`;
        text += `   📱 ${f.phone} | Excel: ${f.excelColumn}\n`;
        text += `   🆔 ${f.id}\n\n`;
    });

    await message.reply(text);
}

async function removeForemanHandler(message, context) {
    const id = context.messageBody.replace(/^#移除判頭\s*/i, '').trim();
    if (!id) {
        await message.reply('❌ 用法：`#移除判頭 [ID]`');
        return;
    }
    removeForeman(id);
    await message.reply(`✅ 已移除判頭: ${id}`);
}

// =====================================================================
// 物料圖紙命令
// =====================================================================

const {
    makeDrawingSearchHandler,
    makeDwgFindHandler,
    buildIndex,
    loadIndex,
    rebuildTgMapping,
    incrementalTgUpdate,
    isDwgReaderAvailable,
} = require('../../skills/drawingSearch');

async function drawingHandler(
    message,
    context,
    client,
    { sessionManager, config }
) {
    // 檢查 POR 路徑
    const porPath = config.paths?.por;
    if (!porPath || !require('fs').existsSync(porPath)) {
        await message.reply(
            '❌ POR 資料夾路徑未設定或不存在。\n' +
                '請管理員在 `configs/settings.json` 中設定 `paths.por`。'
        );
        return;
    }

    if (sessionManager.hasActive(context.userId)) {
        await message.reply('⏰ 您已有一個進行中的會話，請先完成或取消。');
        return;
    }

    // 確保索引已載入
    loadIndex();

    const handler = makeDrawingSearchHandler();
    const ctx = {};

    const result = await sessionManager.start(
        context.userId,
        context.originId,
        handler,
        ctx,
        client,
        null,
        context.whatsappId || context.originId
    );

    if (result.success && result.isGroup && result.message) {
        await message.reply(result.message);
    }
}

async function rebuildIndexHandler(message, _context, _client, { config }) {
    const porPath = config.paths?.por;
    if (!porPath || !require('fs').existsSync(porPath)) {
        await message.reply('❌ POR 資料夾路徑未設定或不存在。');
        return;
    }

    await message.reply('🔄 正在重建圖紙索引，請稍候...');
    try {
        const result = await buildIndex(porPath);
        await message.reply(
            '✅ *索引重建完成*\n\n' +
                `📂 檔案數量: ${result.fileCount}\n` +
                `⏱️ 耗時: ${result.elapsed} 秒`
        );
    } catch (error) {
        await message.reply(`❌ 索引重建失敗: ${error.message}`);
    }
}

// =====================================================================
// DWG 反向查詢: #dwgfind — 輸入加工圖號 → 找對應位置圖
// =====================================================================

async function dwgFindHandler(
    message,
    context,
    client,
    { sessionManager, config }
) {
    if (sessionManager.hasActive(context.userId)) {
        await message.reply('⏰ 您已有一個進行中的會話，請先完成或取消。');
        return;
    }

    loadIndex();

    const handler = makeDwgFindHandler();
    const ctx = {};

    const result = await sessionManager.start(
        context.userId,
        context.originId,
        handler,
        ctx,
        client,
        null,
        context.whatsappId || context.originId
    );

    if (result.success && result.isGroup && result.message) {
        await message.reply(result.message);
    }
}

// =====================================================================
// #rebuildTg — 只重建 TG 位置圖映射（唔重建完整索引）
// =====================================================================

async function rebuildTgHandler(message, _context, _client, { config }) {
    const porPath = config.paths?.por;
    if (!porPath || !require('fs').existsSync(porPath)) {
        await message.reply('❌ POR 資料夾路徑未設定或不存在。');
        return;
    }

    await message.reply('🔄 正在重建位置圖映射索引（Deep Scan），請稍候...');
    try {
        const result = await rebuildTgMapping(porPath);
        await message.reply(
            '✅ *位置圖映射重建完成*\n\n' +
                `📄 DWG 位置圖: ${result.dwgCount} 個\n` +
                `🔗 生成映射: ${result.totalMappings} 條\n` +
                `🆕 新掃描: ${result.scannedCount}\n` +
                `📦 快取命中: ${result.cachedCount}\n` +
                (result.errorCount > 0 ? `⚠️ 錯誤: ${result.errorCount} 個\n` : '') +
                '\n💡 搜尋圖紙時位置圖匹配將使用此索引，響應時間 < 10ms'
        );
    } catch (error) {
        await message.reply(`❌ 映射重建失敗: ${error.message}`);
    }
}

// =====================================================================

module.exports = { registerAll };
