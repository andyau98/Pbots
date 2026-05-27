class ErrorRecovery {
    constructor(config = {}) {
        this.config = config;

        // 重连配置
        this.baseReconnectDelay = 1000; // 1秒
        this.maxReconnectDelay = 30000; // 30秒
        this.maxReconnectAttempts = 10;
        this.reconnectAttempts = 0;

        // 错误缓冲区
        this.errorBuffer = [];
        this.maxErrorBuffer = 100;

        // 崩溃检测
        this.lastHeartbeat = new Date();
        this.heartbeatInterval = 60000; // 1分钟

        console.log('🛡️ 錯誤恢復系統已初始化');
    }

    /**
     * 记录错误
     */
    recordError(error, context = {}) {
        const errorRecord = {
            timestamp: new Date().toISOString(),
            error: error ? (error.message || error.toString()) : 'unknown error',
            stack: error ? error.stack : null,
            context: context,
            type: error ? this.classifyError(error) : 'unknown',
        };

        this.errorBuffer.push(errorRecord);

        // 限制缓冲区大小
        if (this.errorBuffer.length > this.maxErrorBuffer) {
            this.errorBuffer = this.errorBuffer.slice(-this.maxErrorBuffer);
        }

        console.error(`❌ 錯誤記錄 [${errorRecord.type}]:`, error.message);

        return errorRecord;
    }

    /**
     * 错误分类
     */
    classifyError(error) {
        const message = error.message || error.toString();

        if (message.includes('認證失敗') || message.includes('auth_failure')) {
            return '認證錯誤';
        }
        if (message.includes('連接中斷') || message.includes('disconnected')) {
            return '連接錯誤';
        }
        if (message.includes('網絡錯誤') || message.includes('network')) {
            return '網絡錯誤';
        }
        if (message.includes('權限') || message.includes('permission')) {
            return '權限錯誤';
        }
        if (message.includes('文件') || message.includes('file')) {
            return '文件錯誤';
        }
        if (message.includes('媒體') || message.includes('media')) {
            return '媒體錯誤';
        }
        if (message.includes('記憶體') || message.includes('memory')) {
            return '記憶體錯誤';
        }

        return '未知錯誤';
    }

    /**
     * 计算重连延迟（指数退避）
     */
    calculateReconnectDelay() {
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        );

        this.reconnectAttempts++;

        console.log(`🔄 重連嘗試 ${this.reconnectAttempts}, 延遲 ${delay}ms`);

        return delay;
    }

    /**
     * 处理连接错误
     */
    async handleConnectionError(error, client) {
        const errorRecord = this.recordError(error, {
            action: 'connection_error',
        });

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ 達到最大重連嘗試次數，停止重連');
            await this.sendCrashNotification(errorRecord);
            return false;
        }

        const delay = this.calculateReconnectDelay();

        try {
            await new Promise((resolve) => setTimeout(resolve, delay));

            console.log('🔄 嘗試重新連接...');
            await client.initialize();

            // 重置重连计数
            this.reconnectAttempts = 0;
            console.log('✅ 重新連接成功');

            return true;
        } catch (reconnectError) {
            console.error('❌ 重新連接失敗:', reconnectError.message);
            return await this.handleConnectionError(reconnectError, client);
        }
    }

    /**
     * 处理认证错误
     */
    async handleAuthError(error) {
        const errorRecord = this.recordError(error, { action: 'auth_error' });

        console.error('❌ 認證錯誤，需要重新掃描 QR Code');

        // 发送认证错误通知
        await this.sendAuthErrorNotification(errorRecord);

        return false;
    }

    /**
     * 发送崩溃通知
     */
    async sendCrashNotification(errorRecord) {
        try {
            const notification = this.formatCrashNotification(errorRecord);

            // 这里可以添加发送给管理员的逻辑
            // 例如：await this.sendToAdmins(notification);

            console.log('⚠️ 系統崩潰通知:');
            console.log(notification);
        } catch (notificationError) {
            console.error('❌ 發送崩潰通知失敗:', notificationError.message);
        }
    }

    /**
     * 发送认证错误通知
     */
    async sendAuthErrorNotification(errorRecord) {
        try {
            const notification = this.formatAuthErrorNotification(errorRecord);

            // 这里可以添加发送给管理员的逻辑

            console.log('🔐 認證錯誤通知:');
            console.log(notification);
        } catch (notificationError) {
            console.error(
                '❌ 發送認證錯誤通知失敗:',
                notificationError.message
            );
        }
    }

    /**
     * 格式化崩溃通知
     */
    formatCrashNotification(errorRecord) {
        let notification = '🚨 *PBOTS 系統崩潰通知*\n\n';
        notification += `⏰ 崩潰時間: ${new Date().toLocaleString()}\n`;
        notification += `🔧 錯誤類型: ${errorRecord.type}\n`;
        notification += `📝 錯誤訊息: ${errorRecord.error}\n`;
        notification += `🔄 重連嘗試: ${this.reconnectAttempts} 次\n\n`;

        notification += '💡 *建議操作:*\n';
        notification += '1. 檢查網絡連接\n';
        notification += '2. 重啟 PBOTS 服務\n';
        notification += '3. 檢查日誌文件獲取詳細信息\n';

        return notification;
    }

    /**
     * 格式化认证错误通知
     */
    formatAuthErrorNotification(errorRecord) {
        let notification = '🔐 *PBOTS 認證錯誤通知*\n\n';
        notification += `⏰ 錯誤時間: ${new Date().toLocaleString()}\n`;
        notification += `📝 錯誤訊息: ${errorRecord.error}\n\n`;

        notification += '💡 *解決方案:*\n';
        notification += '1. 重新掃描 QR Code\n';
        notification += '2. 檢查 WhatsApp 帳戶狀態\n';
        notification += '3. 確認網絡連接正常\n';

        return notification;
    }

    /**
     * 更新心跳
     */
    updateHeartbeat() {
        this.lastHeartbeat = new Date();
    }

    /**
     * 检查系统健康状态
     */
    checkSystemHealth() {
        const now = new Date();
        const timeSinceHeartbeat = now - this.lastHeartbeat;

        if (timeSinceHeartbeat > this.heartbeatInterval * 2) {
            // 心跳超时，可能系统卡死
            console.warn('⚠️ 系統心跳超時，可能出現卡死情況');
            return false;
        }

        return true;
    }

    /**
     * 获取错误统计
     */
    getErrorStats() {
        const stats = {
            totalErrors: this.errorBuffer.length,
            byType: {},
            byHour: {},
            recentErrors: this.errorBuffer.slice(-10),
        };

        // 按类型统计
        this.errorBuffer.forEach((error) => {
            stats.byType[error.type] = (stats.byType[error.type] || 0) + 1;
        });

        // 按小时统计
        this.errorBuffer.forEach((error) => {
            const hour = new Date(error.timestamp).getHours();
            stats.byHour[hour] = (stats.byHour[hour] || 0) + 1;
        });

        return stats;
    }

    /**
     * 格式化错误统计
     */
    formatErrorStats(stats) {
        let text = '📊 *錯誤統計報告*\n\n';
        text += `📅 報告時間: ${new Date().toLocaleString()}\n`;
        text += `📈 總錯誤數量: ${stats.totalErrors}\n\n`;

        if (Object.keys(stats.byType).length > 0) {
            text += '📋 *按類型統計*\n';
            Object.entries(stats.byType).forEach(([type, count]) => {
                text += `• ${type}: ${count} 次\n`;
            });
            text += '\n';
        }

        if (stats.recentErrors.length > 0) {
            text += '⚠️ *最近錯誤* (最近5次)\n';
            stats.recentErrors.slice(0, 5).forEach((error, index) => {
                const time = new Date(error.timestamp).toLocaleTimeString();
                text += `${index + 1}. ${time} - ${error.type}: ${error.error}\n`;
            });
        }

        return text;
    }

    /**
     * 清理旧错误记录
     */
    cleanupOldErrors(daysToKeep = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const originalCount = this.errorBuffer.length;
        this.errorBuffer = this.errorBuffer.filter(
            (error) => new Date(error.timestamp) >= cutoffDate
        );

        const removedCount = originalCount - this.errorBuffer.length;
        if (removedCount > 0) {
            console.log(
                `🗑️ 已清理 ${removedCount} 條 ${daysToKeep} 天前的錯誤記錄`
            );
        }
    }

    /**
     * 重置重连计数
     */
    resetReconnectAttempts() {
        this.reconnectAttempts = 0;
        console.log('🔄 重連計數已重置');
    }
}

module.exports = ErrorRecovery;
