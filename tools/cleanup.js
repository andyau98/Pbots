const fs = require('fs');
const path = require('path');
const { ensureDir, formatFileSize } = require('./common/utils');

class CleanupManager {
    constructor(config = {}) {
        this.config = config;
        this.logsPath = config.logs_path || './logs';
        this.dataPath = config.data_path || './data';
        this.backupsPath = config.backups_path || './backups';
        this.imagesPath = config.images_path || './data/images';
        this.pdfsPath = config.pdfs_path || './data/pdfs';

        // 確保備份目錄存在
        ensureDir(this.backupsPath);
    }

    /**
     * 掃描目錄中的舊文件
     */
    scanOldFiles(dirPath, daysOld = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysOld);

        const oldFiles = [];

        if (!fs.existsSync(dirPath)) {
            return oldFiles;
        }

        try {
            const scanDirectory = (currentPath) => {
                const items = fs.readdirSync(currentPath);

                for (const item of items) {
                    const itemPath = path.join(currentPath, item);
                    const stat = fs.statSync(itemPath);

                    if (stat.isDirectory()) {
                        // 遞歸掃描子目錄
                        scanDirectory(itemPath);
                    } else if (stat.isFile()) {
                        // 檢查文件是否超過指定天數
                        if (stat.mtime < cutoffDate) {
                            oldFiles.push({
                                path: itemPath,
                                name: item,
                                size: stat.size,
                                mtime: stat.mtime,
                                relativePath: path.relative(dirPath, itemPath),
                            });
                        }
                    }
                }
            };

            scanDirectory(dirPath);
        } catch (error) {
            console.error(`❌ 掃描目錄失敗: ${dirPath}`, error.message);
        }

        return oldFiles;
    }

    /**
     * 移動文件到備份目錄
     */
    moveFileToBackup(fileInfo) {
        try {
            // 創建備份路徑，保持目錄結構
            const backupPath = path.join(
                this.backupsPath,
                fileInfo.relativePath
            );
            const backupDir = path.dirname(backupPath);

            // 確保備份目錄存在
            ensureDir(backupDir);

            // 如果目標文件已存在，添加時間戳後綴
            let finalBackupPath = backupPath;
            let counter = 1;

            while (fs.existsSync(finalBackupPath)) {
                const ext = path.extname(backupPath);
                const baseName = path.basename(backupPath, ext);
                finalBackupPath = path.join(
                    path.dirname(backupPath),
                    `${baseName}_${Date.now()}_${counter}${ext}`
                );
                counter++;
            }

            // 移動文件（跨磁碟時改為 copy + unlink）
            try {
                fs.renameSync(fileInfo.path, finalBackupPath);
            } catch (renameErr) {
                if (renameErr.code === 'EXDEV') {
                    fs.copyFileSync(fileInfo.path, finalBackupPath);
                    fs.unlinkSync(fileInfo.path);
                } else {
                    throw renameErr;
                }
            }

            return {
                success: true,
                originalPath: fileInfo.path,
                backupPath: finalBackupPath,
                size: fileInfo.size,
            };
        } catch (error) {
            console.error(`❌ 移動文件失敗: ${fileInfo.path}`, error.message);
            return {
                success: false,
                originalPath: fileInfo.path,
                error: error.message,
            };
        }
    }

    /**
     * 執行清理操作
     */
    async performCleanup(daysOld = 30) {
        const results = {
            startTime: new Date(),
            daysOld: daysOld,
            scannedDirectories: [],
            totalOldFiles: 0,
            totalSize: 0,
            movedFiles: 0,
            failedMoves: 0,
            details: [],
        };

        console.log(`🔄 開始清理 ${daysOld} 天前的舊文件...`);

        // 定義要掃描的目錄
        const directoriesToScan = [
            { path: this.logsPath, name: '日誌目錄' },
            { path: path.join(this.dataPath, 'chats'), name: '聊天記錄目錄' },
            { path: this.imagesPath, name: '圖片目錄' },
            { path: this.pdfsPath, name: 'PDF目錄' },
        ];

        // 掃描每個目錄
        for (const dir of directoriesToScan) {
            if (!fs.existsSync(dir.path)) {
                console.log(`ℹ️ 目錄不存在，跳過: ${dir.path}`);
                continue;
            }

            console.log(`🔍 掃描目錄: ${dir.name} (${dir.path})`);

            const oldFiles = this.scanOldFiles(dir.path, daysOld);
            results.scannedDirectories.push({
                name: dir.name,
                path: dir.path,
                oldFiles: oldFiles.length,
            });

            results.totalOldFiles += oldFiles.length;

            // 移動舊文件
            for (const file of oldFiles) {
                const moveResult = this.moveFileToBackup(file);

                if (moveResult.success) {
                    results.totalSize += moveResult.size;
                    results.movedFiles++;

                    results.details.push({
                        type: 'moved',
                        file: file.name,
                        originalPath: file.path,
                        backupPath: moveResult.backupPath,
                        size: moveResult.size,
                    });

                    console.log(
                        `✅ 已移動: ${file.name} -> ${moveResult.backupPath}`
                    );
                } else {
                    results.failedMoves++;

                    results.details.push({
                        type: 'failed',
                        file: file.name,
                        originalPath: file.path,
                        error: moveResult.error,
                    });

                    console.log(`❌ 移動失敗: ${file.name}`, moveResult.error);
                }
            }
        }

        results.endTime = new Date();
        results.duration = results.endTime - results.startTime;

        return results;
    }

    /**
     * 格式化清理結果
     */
    formatCleanupResults(results) {
        let text = '🧹 *系統清理報告*\n\n';
        text += `📅 清理時間: ${results.startTime.toLocaleString()}\n`;
        text += `⏱️ 耗時: ${(results.duration / 1000).toFixed(2)} 秒\n`;
        text += `📊 清理天數: ${results.daysOld} 天前\n\n`;

        text += '📈 *清理統計*\n';
        text += `• 掃描目錄: ${results.scannedDirectories.length} 個\n`;
        text += `• 發現舊文件: ${results.totalOldFiles} 個\n`;
        text += `• 成功移動: ${results.movedFiles} 個\n`;
        text += `• 移動失敗: ${results.failedMoves} 個\n`;
        text += `• 釋放空間: ${formatFileSize(results.totalSize)}\n\n`;

        if (results.scannedDirectories.length > 0) {
            text += '📁 *目錄掃描結果*\n';
            results.scannedDirectories.forEach((dir) => {
                text += `• ${dir.name}: ${dir.oldFiles} 個舊文件\n`;
            });
            text += '\n';
        }

        if (results.movedFiles > 0) {
            text += '✅ *清理完成*\n';
            text += `所有超過 ${results.daysOld} 天的舊文件已移動到備份目錄。`;
        } else {
            text += 'ℹ️ *無需清理*\n';
            text += `未發現超過 ${results.daysOld} 天的舊文件。`;
        }

        return text;
    }

    /**
     * 獲取存儲空間統計
     */
    getStorageStats() {
        const stats = {
            totalSize: 0,
            directories: {},
        };

        const directories = [
            { path: this.logsPath, name: '日誌' },
            { path: this.dataPath, name: '數據' },
            { path: this.imagesPath, name: '圖片' },
            { path: this.pdfsPath, name: 'PDF' },
            { path: this.backupsPath, name: '備份' },
        ];

        for (const dir of directories) {
            if (fs.existsSync(dir.path)) {
                const size = this.calculateDirectorySize(dir.path);
                stats.directories[dir.name] = {
                    path: dir.path,
                    size: size,
                    formattedSize: formatFileSize(size),
                };
                stats.totalSize += size;
            }
        }

        stats.formattedTotalSize = formatFileSize(stats.totalSize);

        return stats;
    }

    /**
     * 計算目錄大小
     */
    calculateDirectorySize(dirPath) {
        let totalSize = 0;

        if (!fs.existsSync(dirPath)) {
            return totalSize;
        }

        const calculateSize = (currentPath) => {
            const items = fs.readdirSync(currentPath);

            for (const item of items) {
                const itemPath = path.join(currentPath, item);
                const stat = fs.statSync(itemPath);

                if (stat.isDirectory()) {
                    calculateSize(itemPath);
                } else if (stat.isFile()) {
                    totalSize += stat.size;
                }
            }
        };

        calculateSize(dirPath);
        return totalSize;
    }

    /**
     * 格式化存儲統計
     */
    formatStorageStats(stats) {
        let text = '💾 *存儲空間統計*\n\n';
        text += `📅 統計時間: ${new Date().toLocaleString()}\n`;
        text += `📊 總使用空間: ${stats.formattedTotalSize}\n\n`;

        text += '📁 *各目錄使用情況*\n';
        Object.entries(stats.directories).forEach(([name, data]) => {
            text += `• ${name}: ${data.formattedSize}\n`;
        });

        return text;
    }

    /**
     * 清理備份目錄（可選功能）
     */
    async cleanupBackups(daysOld = 90) {
        console.log(`🗑️ 開始清理 ${daysOld} 天前的備份文件...`);

        const oldBackups = this.scanOldFiles(this.backupsPath, daysOld);
        let deletedCount = 0;
        let deletedSize = 0;

        for (const file of oldBackups) {
            try {
                const fileSize = file.size;
                fs.unlinkSync(file.path);
                deletedCount++;
                deletedSize += fileSize;
                console.log(`🗑️ 已刪除舊備份: ${file.name}`);
            } catch (error) {
                console.error(`❌ 刪除備份失敗: ${file.name}`, error.message);
            }
        }

        return {
            deletedCount: deletedCount,
            deletedSize: deletedSize,
            formattedSize: formatFileSize(deletedSize),
        };
    }

    /**
     * 命令行支持（獨立運行）
     */
    async runFromCommandLine(args = {}) {
        const daysOld = args.days || 30;
        const action = args.action || 'cleanup';

        switch (action) {
            case 'cleanup':
                const results = await this.performCleanup(daysOld);
                console.log('\n' + this.formatCleanupResults(results));
                break;

            case 'stats':
                const stats = this.getStorageStats();
                console.log('\n' + this.formatStorageStats(stats));
                break;

            case 'cleanup-backups':
                const backupResults = await this.cleanupBackups(daysOld);
                console.log(
                    `\n🗑️ 已清理 ${backupResults.deletedCount} 個備份文件，釋放空間: ${backupResults.formattedSize}`
                );
                break;

            default:
                console.log('可用命令:');
                console.log('  cleanup [--days=30]     - 清理舊文件');
                console.log('  stats                   - 查看存儲統計');
                console.log('  cleanup-backups [--days=90] - 清理舊備份');
        }
    }
}

// 如果直接運行此文件，提供命令行支持
if (require.main === module) {
    const cleanupManager = new CleanupManager();

    // 解析命令行參數
    const args = {};
    process.argv.slice(2).forEach((arg) => {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            args[key] = value || true;
        } else {
            args.action = arg;
        }
    });

    cleanupManager.runFromCommandLine(args).catch(console.error);
}

module.exports = CleanupManager;
