const path = require('path');
const fs = require('fs');
const mime = require('mime');

// File extensions that WhatsApp doesn't support as media — send as documents instead
const DOCUMENT_EXTENSIONS = new Set([
    '.dwg',
    '.dxf',
    '.dgn',
    '.rvt',
    '.nwd',
    '.nwc', // CAD
    '.xlsx',
    '.xls',
    '.csv', // Excel
    '.doc',
    '.docx', // Word
    '.zip',
    '.rar',
    '.7z', // Archives
]);

function _createMediaFromFile(filePath) {
    const { MessageMedia } = require('whatsapp-web.js');
    const b64data = fs.readFileSync(filePath, { encoding: 'base64' });
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    let mimetype = mime.getType(filePath);
    // Fall back to octet-stream for types WhatsApp rejects
    if (
        !mimetype ||
        mimetype.startsWith('image/vnd.') ||
        DOCUMENT_EXTENSIONS.has(ext)
    ) {
        mimetype = 'application/octet-stream';
    }

    const filesize = fs.statSync(filePath).size;
    return new MessageMedia(mimetype, b64data, filename, filesize);
}

/**
 * 通用互動會話管理器（SessionManager）
 *
 * 核心規則：
 * 1. 群組觸發的命令 → 所有中間問答透過私訊進行 → 最終結果發回群組
 * 2. 私訊觸發的命令 → 所有問答在私訊中完成 → 結果也在私訊
 * 3. 同一用戶同時只能有一個活躍會話
 * 4. 群組鎖定：群組會話進行中，只有發起人的訊息被處理，其他人亂入忽略
 * 5. 確認回饋：每次收到用戶回答後，先發送「✅ 收到: {答案}」再繼續
 * 6. 會話有超時機制，預設 5 分鐘
 * 7. 此規則適用於所有現有及未來的 tools
 */

class SessionManager {
    constructor() {
        /** @type {Map<string, Session>} userId → Session */
        this._sessions = new Map();
        /** @type {Map<string, string>} groupId → userId  群組鎖定 */
        this._groupLocks = new Map();
        /** @type {Set<string>} userId → 正在處理中，防止 re-entrant */
        this._processing = new Set();
        this._defaultTimeout = 5 * 60 * 1000; // 5 分鐘
    }

    // ========== 會話生命週期 ==========

    /**
     * 建立新的互動會話
     */
    create(
        userId,
        originId,
        handler,
        context = {},
        timeout = null,
        senderId = null
    ) {
        // 強制結束舊會話
        if (this._sessions.has(userId)) {
            this._cancelQuiet(userId, '已被新會話取代');
        }

        const isGroup = originId.endsWith('@g.us');

        // 群組鎖定：記錄此群組正被哪個用戶鎖定
        if (isGroup) {
            // 如果群組已被其他用戶鎖定，拒絕
            const existingOwner = this.getGroupLock(originId);
            if (existingOwner && existingOwner !== userId) {
                console.log(
                    `⛔ 群組 ${originId} 已被用戶 ${existingOwner} 鎖定，拒絕 ${userId}`
                );
                return null;
            }
            this._groupLocks.set(originId, userId);
        }

        // 推斷正確的 WhatsApp ID 格式
        // senderId: 發送者的完整 ID（含 @c.us 或 @lid）
        // 若無 senderId 且 originId 非群組，則 originId 即為發送者 ID
        const resolvedSenderId = senderId || (!isGroup ? originId : null);

        const session = {
            userId,
            originId,
            isGroup,
            senderId: resolvedSenderId, // 用於發送私訊的正確格式
            handler,
            context,
            timeout: timeout || this._defaultTimeout,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            step: 0,
        };

        this._sessions.set(userId, session);
        console.log(
            `📋 [SessionManager] 建立會話: ${handler.name} (用戶: ${userId}, 來源: ${originId}${isGroup ? ', 已鎖定群組' : ''})`
        );
        return session;
    }

    /**
     * 檢查用戶是否有活躍會話
     */
    hasActive(userId) {
        if (!this._sessions.has(userId)) return false;
        const session = this._sessions.get(userId);
        if (Date.now() - session.lastActivity > session.timeout) {
            this._cancelQuiet(userId, '會話已超時');
            return false;
        }
        return true;
    }

    /**
     * 檢查群組是否被鎖定（有進行中的會話）
     * @returns {string|null} 鎖定該群組的用戶 ID，或 null
     */
    getGroupLock(groupId) {
        const ownerId = this._groupLocks.get(groupId);
        if (!ownerId) return null;
        // 確認該用戶的會話仍然有效
        if (!this.hasActive(ownerId)) {
            this._groupLocks.delete(groupId);
            return null;
        }
        return ownerId;
    }

    /**
     * 檢查群組是否被其他用戶鎖定
     */
    isGroupLockedByOther(groupId, userId) {
        const ownerId = this.getGroupLock(groupId);
        return ownerId !== null && ownerId !== userId;
    }

    /**
     * 獲取用戶的活躍會話
     */
    get(userId) {
        if (!this.hasActive(userId)) return null;
        return this._sessions.get(userId);
    }

    /**
     * 更新會話活動時間
     */
    _touch(userId) {
        const session = this._sessions.get(userId);
        if (session) session.lastActivity = Date.now();
    }

    /**
     * 結束會話（釋放群組鎖定）
     */
    end(userId) {
        const session = this._sessions.get(userId);
        if (session) {
            console.log(
                `📋 [SessionManager] 結束會話: ${session.handler.name} (用戶: ${userId})`
            );
            // 釋放群組鎖定
            if (session.isGroup) {
                this._groupLocks.delete(session.originId);
            }
        }
        this._sessions.delete(userId);
    }

    /**
     * 安靜取消（不發送通知）
     */
    _cancelQuiet(userId, reason) {
        const session = this._sessions.get(userId);
        if (!session) return;
        console.log(
            `📋 [SessionManager] 取消會話: ${session.handler.name} (${reason})`
        );
        if (session.isGroup) {
            this._groupLocks.delete(session.originId);
        }
        this._sessions.delete(userId);
    }

    /**
     * 取消會話（發送取消通知到私訊）
     */
    async cancel(userId, client) {
        const session = this._sessions.get(userId);
        if (!session) return false;
        const name = session.handler.name;

        // 釋放群組鎖定
        if (session.isGroup) {
            this._groupLocks.delete(session.originId);
        }
        this._sessions.delete(userId);

        try {
            let cancelMsg = `❌ *${name}* 會話已取消`;
            if (session.handler.onCancel) {
                const result = await session.handler.onCancel(session.context);
                if (result) cancelMsg = result;
            }
            await this._sendDM(userId, cancelMsg, client);
        } catch {}

        console.log(`📋 [SessionManager] 取消會話: ${name} (用戶: ${userId})`);
        return true;
    }

    // ========== 訊息路由（Phase 7 群組鎖定） ==========

    /**
     * 路由訊息到對應的會話 handler
     *
     * Phase 7 群組鎖定規則：
     * - 如果會話是群組觸發的，且訊息來自群組 → 只接受發起人的訊息，其他人忽略
     * - 如果會話是群組觸發的，且訊息來自私訊 → 正常處理
     * - 如果會話是私訊觸發的 → 正常處理
     *
     * @returns {boolean} 是否已處理（已攔截）
     */
    async routeMessage(userId, message, client) {
        if (!this.hasActive(userId)) return false;

        // 防止 re-entrant：同一用戶有多條訊息同時進入
        if (this._processing.has(userId)) {
            console.log(`⏳ [SessionManager] ${userId} 正在處理中，跳過重複調用`);
            return true;
        }

        const session = this.get(userId);
        if (!session) return false;

        const messageOriginId = message.from;

        // ── Phase 7 群組鎖定檢查 ──
        // 如果這是群組會話，且訊息來自群組（非私訊）
        if (session.isGroup && messageOriginId.endsWith('@g.us')) {
            // 只有發起人的群組訊息才被處理
            if (messageOriginId === session.originId) {
                // 這是發起人在群組中發言 → 可能是在群組內回答（不推薦，但允許）
                // 實際情況：群組觸發的會話，問答在私訊進行，群組訊息通常會被忽略
                console.log(
                    `⚠️ [SessionManager] 群組會話中，發起人 ${userId} 在群組發言，路由到會話`
                );
            } else {
                // 其他人在已鎖定的群組中發言 → 忽略
                console.log(
                    `⛔ [SessionManager] 群組 ${messageOriginId} 已被用戶 ${session.userId} 鎖定，忽略用戶 ${userId} 的訊息`
                );
                return false; // 不攔截，讓訊息正常流動（不干擾會話）
            }
        }

        this._touch(userId);
        session.step++;

        const handler = session.handler;
        const ctx = session.context;

        // 標記為處理中，防止 re-entrant
        this._processing.add(userId);

        try {
            const result = await handler.handleReply(ctx, message);

            if (!result) {
                this.end(userId);
                return true;
            }

            // 驗證 handler 回傳值：若 done 同 question 都冇，當係無效回傳終止會話
            if (!result.done && !result.question) {
                console.warn(`⚠️ [SessionManager] ${handler.name} 回傳無效值，終止會話`);
                await this._sendDM(userId, '❌ 處理程式回傳無效，會話已終止。', client).catch(() => {});
                this.end(userId);
                return true;
            }

            if (result.done) {
                // 發送最終結果到原始來源（群組或私訊）
                // 先發送文字結果
                if (result.result) {
                    await this._sendToOrigin(
                        session.originId,
                        result.result,
                        client
                    );
                }
                // 如果有附件（單一或多個），一併發送
                const attachments =
                    result.attachments ||
                    (result.attachment ? [result.attachment] : []);

                // 多附件時先發 attachmentCaption 做摘要
                if (attachments.length > 1 && result.attachmentCaption) {
                    try {
                        await this._sendToOrigin(
                            session.originId,
                            result.attachmentCaption,
                            client
                        );
                    } catch (captionErr) {
                        console.warn(`⚠️ [SessionManager] 發送附件摘要失敗:`, captionErr.message);
                    }
                }

                for (const attPath of attachments) {
                    try {
                        // Normalize path: use forward slashes to avoid Windows issues
                        const normalizedPath = attPath.replace(/\\/g, '/');
                        const media = _createMediaFromFile(normalizedPath);
                        await client.sendMessage(session.originId, media, {
                            caption:
                                attachments.length === 1
                                    ? result.attachmentCaption || '📄 檔案'
                                    : path.basename(attPath),
                        });
                        console.log(
                            `📎 [SessionManager] 附件已發送: ${attPath}`
                        );
                    } catch (attErr) {
                        console.error(
                            `❌ [SessionManager] 發送附件失敗 (${attPath}):`,
                            attErr.message
                        );
                        try {
                            await this._sendToOrigin(
                                session.originId,
                                `⚠️ 附件發送失敗: ${attErr.message}`,
                                client
                            );
                        } catch {}
                    }
                }
                // 發送完成訊息
                if (result.completionMessage) {
                    try {
                        await this._sendToOrigin(
                            session.originId,
                            result.completionMessage,
                            client
                        );
                    } catch (compErr) {
                        console.warn(`⚠️ [SessionManager] 發送完成訊息失敗:`, compErr.message);
                    }
                }
                this.end(userId);
                console.log(
                    `✅ [SessionManager] ${handler.name} 完成，結果已發送到 ${session.originId}`
                );
            } else if (result.question) {
                // Phase 7 確認回饋：先發送「✅ 收到: {用戶輸入}」，再發下一條問題
                const userInput = message.body?.trim();
                if (userInput && !message.hasMedia && userInput !== '#cancel') {
                    try {
                        await this._sendDM(
                            userId,
                            `✅ *收到:* ${userInput.substring(0, 100)}`,
                            client
                        );
                    } catch (feedbackErr) {
                        console.warn(`⚠️ [SessionManager] 發送回饋失敗:`, feedbackErr.message);
                    }
                }

                // 發送下一條問題到用戶私訊
                await this._sendDM(userId, result.question, client);
                console.log(
                    `💬 [SessionManager] ${handler.name} 步驟 ${session.step}: 發送問題到 ${userId}`
                );
            }

            return true;
        } catch (error) {
            console.error(
                `❌ [SessionManager] ${handler.name} 處理失敗:`,
                error.message
            );
            try {
                await this._sendDM(
                    userId,
                    `❌ 處理失敗: ${error.message}\n請重新開始。`,
                    client
                );
            } catch (errNotifyErr) {
                console.warn(`⚠️ [SessionManager] 發送錯誤通知失敗:`, errNotifyErr.message);
            }
            this.end(userId);
            return true;
        } finally {
            this._processing.delete(userId);
        }
    }

    /**
     * 開始會話（發送第一條問題到私訊，如果群組觸發則先通知群組）
     * @param {string} userId - 用戶號碼（純數字）
     * @param {string} originId - 命令來源（群組或私訊的完整 ID，含後綴）
     * @param {string} [senderId] - 發送者的完整 WhatsApp ID（含 @c.us 或 @lid 後綴），用於發送私訊
     */
    async start(userId, originId, handler, context, client, timeout, senderId) {
        // 防止 re-entrant
        if (this._processing.has(userId)) {
            return { success: false, message: '⏳ 您有正在處理中的請求，請稍後再試。' };
        }

        context = context || {};

        // 建立會話（包含群組鎖定 + senderId 用於正確的 DM 格式）
        const session = this.create(
            userId,
            originId,
            handler,
            context,
            timeout,
            senderId
        );
        if (!session) {
            return {
                success: false,
                message: '❌ 此群組已有其他用戶正在進行互動會話，請稍後再試。',
            };
        }

        const isGroup = originId.endsWith('@g.us');

        try {
            // 調用 handler.start()
            const result = await handler.start(context, {
                userId,
                originId,
                isGroup,
            });

            if (!result) {
                this.end(userId);
                return { success: false, message: '會話啟動失敗' };
            }

            if (result.done) {
                // 一步完成 → 直接發到原始來源
                await this._sendToOrigin(originId, result.result, client);
                this.end(userId);
                return { success: true, isGroup, handled: true };
            }

            // 多步驟：第一條問題發到私訊
            if (result.question) {
                await this._sendDM(userId, result.question, client);
            }

            // 如果是群組觸發，在群組中提示用戶檢查私訊
            if (isGroup) {
                return {
                    success: true,
                    isGroup: true,
                    handled: true,
                    message: `📬 已向您發送私訊，請在私訊中繼續操作 *${handler.name}*。\n\n⚠️ 此群組已鎖定，其他人無法干擾您的會話。`,
                };
            }

            return { success: true, isGroup: false, handled: true };
        } catch (error) {
            console.error(
                `❌ [SessionManager] 啟動 ${handler.name} 失敗:`,
                error.message
            );
            this.end(userId);
            return { success: false, message: `啟動失敗: ${error.message}` };
        }
    }

    // ========== 內部方法 ==========

    async _sendDM(userId, text, client) {
        // 使用會話中記錄的正確 WhatsApp ID 格式（@c.us 或 @lid）
        const session = this._sessions.get(userId);
        let target;

        if (session && session.senderId && session.senderId.includes('@')) {
            // 有正確的完整 ID → 直接使用
            target = session.senderId;
        } else if (userId.includes('@')) {
            target = userId;
        } else {
            // 根據 originId 推斷後綴
            if (
                session &&
                session.originId &&
                session.originId.includes('@lid')
            ) {
                target = userId + '@lid';
            } else {
                target = userId + '@c.us';
            }
        }

        try {
            await client.sendMessage(target, text);
        } catch (error) {
            console.error(
                `❌ [SessionManager] 發送私訊失敗 (${target}):`,
                error.message
            );
            throw error;
        }
    }

    async _sendToOrigin(originId, text, client) {
        try {
            await client.sendMessage(originId, text);
        } catch (error) {
            console.error(
                `❌ [SessionManager] 發送到 ${originId} 失敗:`,
                error.message
            );
            throw error;
        }
    }

    // ========== 工具方法 ==========

    getSummary() {
        const sessions = [];
        for (const [userId, session] of this._sessions) {
            const elapsed = Math.floor((Date.now() - session.createdAt) / 1000);
            sessions.push({
                userId,
                handler: session.handler.name,
                isGroup: session.isGroup,
                step: session.step,
                elapsedSeconds: elapsed,
            });
        }
        return sessions;
    }

    cleanup() {
        const now = Date.now();
        let count = 0;
        for (const [userId, session] of this._sessions) {
            if (now - session.lastActivity > session.timeout) {
                if (session.isGroup) {
                    this._groupLocks.delete(session.originId);
                }
                this._sessions.delete(userId);
                count++;
            }
        }
        if (count > 0) {
            console.log(`🗑️ [SessionManager] 已清理 ${count} 個超時會話`);
        }
    }
}

// 單例
const sessionManager = new SessionManager();

module.exports = { SessionManager, sessionManager };
