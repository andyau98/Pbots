/**
 * 統一權限管理器
 *
 * 依賴 DataStore 進行所有持久化操作。
 * 不再直接讀寫 configs/settings.json。
 */

const { dataStore } = require('./dataStore');

class AuthManager {
    constructor(config = {}) {
        this.config = config;
        this.botPrefix = config.bot?.prefix || '!';

        // 白名單開關（靜態設定，來自 settings.json）
        this.whitelistEnabled = config.security?.whitelist_enabled !== false;

        // 認證密碼（從環境變數讀取，或從 settings.json 的靜態備份）
        this.authPassword =
            process.env.AUTH_PASSWORD || config.security?.auth_password;
        if (!this.authPassword || this.authPassword === '288365') {
            console.warn(
                '⚠️  警告：使用預設或不安全的密碼！請在 .env 檔案中設定 AUTH_PASSWORD'
            );
        }

        // 私信認證會話管理
        this.activeSessions = new Map();
        this.sessionTimeout = 5 * 60 * 1000; // 5 分鐘

        // 未授權訪問記錄（純記憶體，不持久化）
        this.unauthorizedAttempts = [];
        this.maxAttemptsLog = 1000;

        console.log('🔐 統一權限管理器已初始化');
    }

    // ========== 管理員管理（→ DataStore） ==========

    /** 獲取管理員列表 */
    get admins() {
        return dataStore.getAdmins();
    }

    /** 獲取管理員數量 */
    get adminNumbers() {
        return {
            size: dataStore.getAdmins().length,
            has: (id) => dataStore.isAdmin(id),
        };
    }

    /** 獲取授權群組數量 */
    get authorizedGroups() {
        const groups = dataStore.getAuthorizedGroups();
        return {
            size: groups.length,
        };
    }

    isAdmin(userId) {
        return dataStore.isAdmin(userId);
    }

    addAdmin(userId) {
        dataStore.addAdmin(userId);
        console.log(`✅ 已添加管理員: ${userId}`);
    }

    removeAdmin(userId) {
        dataStore.removeAdmin(userId);
        console.log(`✅ 已移除管理員: ${userId}`);
    }

    // ========== 封鎖管理（→ DataStore） ==========

    isBlocked(userId) {
        return dataStore.isBlocked(userId);
    }

    blockUser(userId, reason = '') {
        dataStore.blockUser(userId, reason);
        console.log(`🚫 已封鎖用戶: ${userId}`);
    }

    unblockUser(userId) {
        dataStore.unblockUser(userId);
        console.log(`✅ 已解除封鎖: ${userId}`);
    }

    // ========== 群組管理（→ DataStore） ==========

    addAuthorizedGroup(groupId) {
        dataStore.addAuthorizedGroup(groupId);
        console.log(`✅ 已添加授權群組: ${groupId}`);
    }

    removeAuthorizedGroup(groupId) {
        dataStore.removeAuthorizedGroup(groupId);
        console.log(`✅ 已移除授權群組: ${groupId}`);
    }

    // ========== 權限檢查（唯一入口） ==========

    /**
     * 權限檢查（唯一入口）
     * @param {string} userId - 用戶號碼
     * @param {string} [groupId] - 群組 ID（若從群組發送）
     */
    checkPermission(userId, groupId = null) {
        // 封鎖檢查優先
        if (this.isBlocked(userId)) {
            return {
                isAdmin: false,
                whitelistEnabled: this.whitelistEnabled,
                hasFullAccess: false,
                isBlocked: true,
            };
        }
        // 白名單關閉 → 所有人有權限
        if (!this.whitelistEnabled) {
            return {
                isAdmin: this.isAdmin(userId),
                whitelistEnabled: false,
                hasFullAccess: true,
                isBlocked: false,
            };
        }
        // 管理員 → 完整權限
        if (this.isAdmin(userId)) {
            return {
                isAdmin: true,
                whitelistEnabled: true,
                hasFullAccess: true,
                isBlocked: false,
            };
        }
        // 授權群組成員 → 完整權限（群組內所有人自動獲得管理員權限）
        if (groupId && dataStore.getAuthorizedGroups().includes(groupId)) {
            return {
                isAdmin: false,
                whitelistEnabled: true,
                hasFullAccess: true,
                isBlocked: false,
                authorizedByGroup: true,
            };
        }
        return {
            isAdmin: false,
            whitelistEnabled: this.whitelistEnabled,
            hasFullAccess: false,
            isBlocked: false,
        };
    }

    // ========== 內聯認證 ==========

    authenticateDirect(userId, password) {
        if (!this.authPassword) {
            return {
                success: false,
                message: '❌ 系統未設定認證密碼，請聯繫管理員。',
            };
        }
        if (password === this.authPassword) {
            this.addAdmin(userId);
            console.log(`✅ ${userId} 內聯認證成功`);
            return {
                success: true,
                message:
                    '✅ *認證成功！*\n\n👑 您已成為系統管理員\n' +
                    `📱 用戶ID: ${userId}\n⏰ 生效時間: ${new Date().toLocaleString()}\n\n` +
                    '💡 發送 *!help* 查看完整命令列表',
                userId,
            };
        }
        console.log(`❌ ${userId} 內聯認證失敗：密碼錯誤`);
        return {
            success: false,
            message: '❌ *密碼錯誤*\n\n請確認密碼後重試。',
        };
    }

    // ========== 私信認證會話 ==========

    hasActiveSession(userId) {
        if (!this.activeSessions.has(userId)) return false;
        const session = this.activeSessions.get(userId);
        if (Date.now() - session.startTime > this.sessionTimeout) {
            this.activeSessions.delete(userId);
            return false;
        }
        return true;
    }

    async startPrivateSession(userId, originId, client) {
        try {
            if (this.hasActiveSession(userId)) {
                return {
                    success: false,
                    message: '您已經有一個活躍的認證會話，請檢查私訊。',
                };
            }
            const sessionData = {
                userId,
                originId,
                startTime: Date.now(),
                step: 'ask_password',
                attempts: 0,
                maxAttempts: 3,
            };
            this.activeSessions.set(userId, sessionData);

            const question =
                '🔐 *管理員認證*\n\n請輸入認證密碼以獲取管理員權限：\n' +
                `💡 您有 ${sessionData.maxAttempts} 次嘗試機會\n⏰ 會話將在 5 分鐘後自動過期`;

            await this._sendPrivateMessage(userId, question, client);
            console.log(`🔐 已向 ${userId} 發起私信認證會話`);
            return {
                success: true,
                message: '已向您發送私信，請檢查私訊並輸入認證密碼。',
            };
        } catch (error) {
            console.error('❌ 開始私信會話失敗:', error.message);
            return {
                success: false,
                message: '無法發起私信認證，請稍後再試。',
            };
        }
    }

    async handlePrivateReply(userId, message, client) {
        try {
            if (!this.hasActiveSession(userId)) {
                await this._sendPrivateMessage(
                    userId,
                    '❌ 沒有活躍的認證會話，請重新發起認證。',
                    client
                );
                return { success: false, message: '無活躍會話' };
            }
            const session = this.activeSessions.get(userId);
            const userInput = message.body.trim();
            session.attempts++;

            if (userInput === this.authPassword) {
                this.activeSessions.delete(userId);
                this.addAdmin(userId);

                const successMsg =
                    '✅ *認證成功！*\n\n👑 您已成為系統管理員\n' +
                    `📱 用戶ID: ${userId}\n⏰ 生效時間: ${new Date().toLocaleString()}\n\n` +
                    '💡 發送 *!help* 查看完整命令列表';

                await this._sendPrivateMessage(userId, successMsg, client);
                if (session.originId.endsWith('@g.us')) {
                    try {
                        await client.sendMessage(
                            session.originId,
                            `✅ *認證成功通知*\n\n用戶 ${userId} 已成功通過管理員認證\n現已擁有完整系統權限`
                        );
                    } catch {}
                }
                console.log(`✅ ${userId} 認證成功`);
                return {
                    success: true,
                    message: '認證成功',
                    userId,
                    originId: session.originId,
                };
            }

            const remainingAttempts = session.maxAttempts - session.attempts;
            if (remainingAttempts > 0) {
                await this._sendPrivateMessage(
                    userId,
                    `❌ *密碼錯誤*\n\n您還有 ${remainingAttempts} 次嘗試機會\n請重新輸入認證密碼：`,
                    client
                );
                return {
                    success: false,
                    message: '密碼錯誤',
                    remainingAttempts,
                };
            }

            this.activeSessions.delete(userId);
            await this._sendPrivateMessage(
                userId,
                '❌ *認證失敗*\n\n您已達到最大嘗試次數\n認證會話已結束\n💡 如需再次認證，請重新發起 !whitelist 命令',
                client
            );
            console.log(`❌ ${userId} 認證失敗（達到最大嘗試次數）`);
            return { success: false, message: '認證失敗' };
        } catch (error) {
            console.error('❌ 處理私信回覆失敗:', error.message);
            return { success: false, message: error.message };
        }
    }

    getSessionStatus(userId) {
        if (!this.hasActiveSession(userId)) return null;
        const session = this.activeSessions.get(userId);
        const remainingTime =
            this.sessionTimeout - (Date.now() - session.startTime);
        return {
            userId: session.userId,
            originId: session.originId,
            step: session.step,
            attempts: session.attempts,
            maxAttempts: session.maxAttempts,
            remainingMinutes: Math.ceil(remainingTime / 60000),
        };
    }

    // ========== 動態幫助訊息 ==========

    generateHelpMessage(userId) {
        const permission = this.checkPermission(userId);
        const prefix = this.botPrefix;

        let text = '🤖 *PBOTS 幫助*\n\n';

        text += '*📋 基礎:*\n';
        text += `• ${prefix}ping - 測試響應\n`;
        text += `• ${prefix}help - 幫助訊息\n`;
        text += `• ${prefix}status - 機器人狀態\n`;
        text += `• ${prefix}stats - 今日統計\n`;

        text += '\n*🌤️ 資訊:*\n';
        text += `• ${prefix}weather / 天氣 - 香港天氣\n`;
        text += `• ${prefix}news / 新聞 / 地盤 - 地盤新聞\n`;

        text += '\n*📄 PDF:*\n';
        text += '• #TOPDF [標題] - 收集照片→PDF\n';
        text += '• #done - 完成生成 PDF\n';
        text += '• #cancel - 取消會話\n';

        text += '\n*🕐 考勤:*\n';
        text += '• #申報 - 申報今日人數\n';
        text += '• #今日人數 - 查詢今日申報\n';

        text += '\n*📦 圖紙:*\n';
        text += '• #Drawing / #圖紙 - 搜尋加工圖\n';
        text += '• #searchpor - 重建圖紙索引\n';
        text += '• #dwgfind / #找位置圖 - 加工圖號→位置圖\n';
        text += '• #rebuildTg - 重建位置圖映射\n';

        if (permission.hasFullAccess) {
            text += '\n*👑 管理:*\n';
            text += `• ${prefix}security - 安全狀態\n`;
            text += `• ${prefix}cleanup - 系統清理\n`;
            text += `• ${prefix}mediastats - 媒體統計\n`;
            text += `• ${prefix}whitelist - 白名單認證\n`;
            text += `• ${prefix}addgroup - 授權群組\n`;
            text += `• ${prefix}removegroup [ID] - 移除授權\n`;
            text += '• #登記判頭 - 登記判頭\n';
            text += '• #判頭列表 - 判頭列表\n';
            text += '• #移除判頭 [ID] - 移除判頭\n';
            text += '\n👑 完整管理員權限\n';
        } else {
            text += '\n*🔓 認證:*\n';
            text += `• ${prefix}whitelist <密碼> - 直接認證\n`;
            text += `• ${prefix}whitelist - 私信認證\n`;
        }

        text += `\n🔐 白名單: ${this.whitelistEnabled ? '✅' : '❌'} | 📋 前綴: ${this.botPrefix}`;
        return text;
    }

    // ========== 安全狀態報告 ==========

    getSecurityStatus() {
        return {
            whitelistEnabled: this.whitelistEnabled,
            adminCount: dataStore.getAdmins().length,
            blockedCount: dataStore.getBlockedUsers().length,
            authorizedGroupCount: dataStore.getAuthorizedGroups().length,
            unauthorizedAttempts: this.unauthorizedAttempts.length,
            recentAttempts: this.unauthorizedAttempts.slice(-10),
        };
    }

    formatSecurityStatus(status) {
        let text = '🔐 *安全狀態報告*\n';
        text += `📅 報告時間: ${new Date().toLocaleString()}\n\n`;
        text += '📊 *系統狀態*\n';
        text += `• 白名單模式: ${status.whitelistEnabled ? '✅ 已啟用' : '❌ 已禁用'}\n`;
        text += `• 管理員數量: ${status.adminCount}\n`;
        text += `• 已封鎖用戶: ${status.blockedCount}\n`;
        text += `• 授權群組: ${status.authorizedGroupCount}\n`;
        text += `• 未授權嘗試: ${status.unauthorizedAttempts} 次\n\n`;

        const admins = dataStore.getAdmins();
        if (admins.length > 0) {
            text += '👑 *管理員列表*\n';
            admins.forEach((admin) => {
                text += `• ${admin}\n`;
            });
            text += '\n';
        }

        const blocked = dataStore.getBlockedUsers();
        if (blocked.length > 0) {
            text += '🚫 *已封鎖用戶*\n';
            blocked.forEach((b) => {
                text += `• ${b.userId} (${b.reason || '無原因'})\n`;
            });
            text += '\n';
        }

        if (status.recentAttempts.length > 0) {
            text += '⚠️ *最近未授權嘗試*\n';
            status.recentAttempts.slice(-5).forEach((attempt, index) => {
                const time = new Date(attempt.timestamp).toLocaleTimeString();
                text += `${index + 1}. ${time} - ${attempt.command || 'N/A'} (${attempt.type})\n`;
            });
        }

        return text;
    }

    // ========== 未授權訪問記錄 ==========

    logUnauthorizedAccess(userId, groupId, command) {
        const attempt = {
            timestamp: new Date().toISOString(),
            userId,
            groupId,
            command,
            type: groupId ? 'Group' : 'Private',
        };
        this.unauthorizedAttempts.push(attempt);
        if (this.unauthorizedAttempts.length > this.maxAttemptsLog) {
            this.unauthorizedAttempts = this.unauthorizedAttempts.slice(
                -this.maxAttemptsLog
            );
        }
        console.log(`🚫 未授權訪問: ${userId} → ${command || 'N/A'}`);
    }

    cleanupOldRecords(daysToKeep = 30) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysToKeep);
        this.unauthorizedAttempts = this.unauthorizedAttempts.filter(
            (a) => new Date(a.timestamp) >= cutoff
        );
    }

    // ========== 重置 ==========

    async resetAll() {
        console.log('🔄 重置權限系統...');
        this.activeSessions.clear();
        this.unauthorizedAttempts = [];
        dataStore.resetAll();
        console.log('✅ 權限系統已重置');
        return {
            success: true,
            message: '所有權限數據已清空，系統回到初始狀態',
        };
    }

    // ========== 內部：發送私信 ==========

    async _sendPrivateMessage(userId, messageText, client, originId) {
        try {
            let target = userId;
            if (!target.includes('@')) {
                target += (originId && originId.includes('@lid')) ? '@lid' : '@c.us';
            }
            await client.sendMessage(target, messageText);
            return true;
        } catch (error) {
            console.error(`❌ 發送私信失敗 (${userId}):`, error.message);
            throw error;
        }
    }
}

module.exports = AuthManager;
