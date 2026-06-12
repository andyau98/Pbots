const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { ensureDir, formatFileSize } = require('./common/utils');

// 中文字體路徑 — 自動偵測作業系統
const CHINESE_FONT = (() => {
    try {
        const os = require('os');
        if (os.platform() === 'darwin') {
            // .ttf 優先（pdfkit 對 .ttc 的 subset 支援有限）
            const candidates = [
                '/Library/Fonts/Arial Unicode.ttf', // .ttf，pdfkit 完全支援
                '/System/Library/Fonts/STHeiti Light.ttc', // .ttc 備用
                '/System/Library/Fonts/Hiragino Sans GB.ttc',
                '/System/Library/Fonts/PingFang.ttc',
            ];
            for (const fontPath of candidates) {
                if (fs.existsSync(fontPath)) {
                    console.log(`✅ 中文字體: ${fontPath}`);
                    return fontPath;
                }
            }
        }
        // Windows
        const winFonts = [
            'C:/Windows/Fonts/simhei.ttf',
            path.join(__dirname, 'fonts', 'simhei.ttf'), // 專案內置 fallback
        ];
        for (const fp of winFonts) {
            if (fs.existsSync(fp)) {
                console.log(`✅ 中文字體: ${fp}`);
                return fp;
            }
        }
        // Linux
        const linuxFont =
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc';
        if (fs.existsSync(linuxFont)) {
            console.log(`✅ 中文字體: ${linuxFont}`);
            return linuxFont;
        }
    } catch (e) {
        console.error('⚠️  字體偵測失敗:', e.message);
    }
    console.warn(
        '⚠️  未找到中文字體，PDF 將使用 Helvetica（中文可能無法顯示）'
    );
    return null;
})();

class ImageToPdf {
    constructor(config = {}) {
        this.config = config;
        this.pdfPath = config.pdf_path || './data/pdfs';
        this.sessions = new Map(); // userId -> { photos[], title, createdAt }

        ensureDir(this.pdfPath);
    }

    /**
     * 开始新的 PDF 收集会话
     */
    /**
     * 请求标题 - 用户发送 #TOPDF 时调用
     */
    requestTitle(userId) {
        if (this.sessions.has(userId)) {
            return {
                success: false,
                message:
                    '❌ 您已有一個進行中的 PDF 收集會話。\n請發送 *#cancel* 取消後再試。',
            };
        }

        this.sessions.set(userId, {
            photos: [],
            title: '',
            createdAt: Date.now(),
            state: 'waiting_for_title',
        });

        return {
            success: true,
            message:
                '📸 *PDF 生成 - 第一步*\n\n請輸入此 PDF 的標題（例如：地盤安全巡查報告）：',
        };
    }

    /**
     * 设置标题并开始收集照片
     */
    setTitle(userId, title) {
        const session = this.sessions.get(userId);
        if (!session || session.state !== 'waiting_for_title') return null;

        session.title = title.trim();
        session.state = 'collecting';

        return {
            success: true,
            message:
                '📸 *PDF 收集已開始*\n\n' +
                `📄 *標題:* ${session.title}\n` +
                '📷 *已收集:* 0 張照片\n\n' +
                '請發送照片（可附帶說明文字作為圖片描述）。\n' +
                '發送 *#done* 完成並生成 PDF。\n' +
                '發送 *#cancel* 取消。',
        };
    }

    /**
     * 添加照片到当前会话
     */
    async addPhoto(userId, photoBuffer, photoName, caption = '') {
        const session = this.sessions.get(userId);
        if (!session) return null;

        // 保存照片到临时目录
        const tmpDir = path.join(this.pdfPath, '.tmp');
        ensureDir(tmpDir);
        const fileName = `${Date.now()}_${photoName || 'photo'}`;
        const filePath = path.join(tmpDir, fileName);

        fs.writeFileSync(filePath, photoBuffer);

        session.photos.push({
            path: filePath,
            name: photoName || fileName,
            caption: caption || '',
            size: photoBuffer.length,
        });

        return session.photos.length;
    }

    /**
     * 取消会话
     */
    cancelSession(userId) {
        const session = this.sessions.get(userId);
        if (session) {
            // 清理临时文件
            session.photos.forEach((p) => {
                try {
                    fs.unlinkSync(p.path);
                } catch {}
            });
            this.sessions.delete(userId);
        }
        return { success: true, message: '❌ PDF 收集已取消。' };
    }

    /**
     * 完成并生成 PDF
     */
    async finalizePdf(userId) {
        const session = this.sessions.get(userId);
        if (!session) {
            throw new Error('没有进行中的 PDF 收集会话。');
        }

        if (session.photos.length === 0) {
            this.sessions.delete(userId);
            throw new Error('没有收到任何照片，请先发送照片。');
        }

        const pdfFileName = this.generatePdfFileName(userId, session.title);
        const pdfFilePath = path.join(this.pdfPath, pdfFileName);

        await this.createPdf(session.photos, session.title, pdfFilePath);

        // 清理临时文件
        session.photos.forEach((p) => {
            try {
                fs.unlinkSync(p.path);
            } catch {}
        });
        this.sessions.delete(userId);

        const stats = fs.statSync(pdfFilePath);
        return {
            pdfPath: pdfFilePath,
            fileName: pdfFileName,
            fileSize: stats.size,
            imageCount: session.photos.length,
            title: session.title,
        };
    }

    /**
     * 生成 PDF 文件
     */
    createPdf(photos, title, outputPath) {
        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({
                    size: 'A4',
                    margins: { top: 0, bottom: 0, left: 0, right: 0 },
                    autoFirstPage: false,
                });

                const fontPath =
                    CHINESE_FONT && fs.existsSync(CHINESE_FONT)
                        ? CHINESE_FONT
                        : null;
                if (fontPath) {
                    doc.registerFont('CJK', fontPath);
                }
                const f = fontPath ? 'CJK' : 'Helvetica';
                const hkTime = new Date(Date.now() + 8 * 60 * 60 * 1000)
                    .toISOString()
                    .replace('T', ' ')
                    .slice(0, 19);

                const stream = fs.createWriteStream(outputPath);
                doc.pipe(stream);

                // 网格布局参数 (每页 2x2)
                const margin = 40;
                const topOffset = 50; // 標題欄高度
                const pageW = 595.28; // A4 width in points
                const pageH = 841.89; // A4 height in points
                const gridW = (pageW - margin * 2 - 12) / 2; // 12 = gap between columns
                const gridH = (pageH - margin * 2 - topOffset - 8) / 2; // 8 = gap between rows
                const imgH = gridH - 55; // 55pt for caption below each photo

                const cellsPerPage = 4;
                const totalPages = Math.ceil(photos.length / cellsPerPage);

                for (let page = 0; page < totalPages; page++) {
                    doc.addPage();

                    // 繪製標題欄
                    doc.fontSize(14)
                        .font(f)
                        .fillColor('#333333')
                        .text(title || 'PDF 報告', margin, 15, {
                            width: pageW - margin * 2,
                            align: 'center',
                        });
                    doc.moveTo(margin, topOffset - 10)
                        .lineTo(pageW - margin, topOffset - 10)
                        .stroke('#cccccc');

                    const pagePhotos = photos.slice(
                        page * cellsPerPage,
                        (page + 1) * cellsPerPage
                    );

                    for (let idx = 0; idx < pagePhotos.length; idx++) {
                        const photo = pagePhotos[idx];
                        const col = idx % 2;
                        const row = Math.floor(idx / 2);
                        const x = margin + col * (gridW + 12);
                        const y = margin + topOffset + row * (gridH + 8);

                        try {
                            doc.image(photo.path, x, y, {
                                fit: [gridW, imgH],
                                align: 'center',
                                valign: 'center',
                            });
                        } catch (err) {
                            doc.fontSize(10)
                                .font(f)
                                .fillColor('red')
                                .text(
                                    '[!] 無法加載',
                                    x + 5,
                                    y + imgH / 2 - 10,
                                    { width: gridW - 10 }
                                )
                                .fillColor('black');
                        }

                        doc.rect(x, y, gridW, imgH).stroke('#cccccc');

                        const captionY = y + imgH + 6;
                        const desc = photo.caption
                            ? `相片描述：${photo.caption}`
                            : photo.name || '';
                        doc.fontSize(8)
                            .font(f)
                            .fillColor('black')
                            .text(desc, x, captionY, {
                                width: gridW,
                                height: 28,
                                ellipsis: true,
                                lineBreak: false,
                            });
                        doc.fontSize(7)
                            .font(f)
                            .fillColor('#888888')
                            .text(
                                `${hkTime}  |  ${formatFileSize(photo.size)}`,
                                x,
                                captionY + 22,
                                { width: gridW }
                            );
                    }

                    doc.fontSize(8)
                        .font(f)
                        .fillColor('#aaaaaa')
                        .text(
                            `${page + 1} / ${totalPages}`,
                            pageW / 2 - 20,
                            pageH - 30,
                            { width: 40, align: 'center' }
                        );
                }

                doc.end();

                stream.on('finish', () => resolve(true));
                stream.on('error', reject);
            } catch (error) {
                reject(error);
            }
        });
    }

    generatePdfFileName(userId, title) {
        const now = new Date();
        const ts = now
            .toISOString()
            .replace(/[-:]/g, '')
            .replace('T', '_')
            .replace(/\./g, '_')
            .slice(0, 21);
        const cleanTitle = (title || 'document')
            .replace(/[^a-zA-Z0-9一-鿿]/g, '_')
            .substring(0, 30);
        const cleanUserId = userId.replace('@c.us', '').replace(/[^\w]/g, '_');
        return `${ts}_${cleanUserId}_${cleanTitle}.pdf`;
    }

    /**
     * 格式化结果
     */
    formatResult(result) {
        return (
            '📄 *PDF 生成完成！*\n\n' +
            `📄 *標題:* ${result.title}\n` +
            `📷 *照片數量:* ${result.imageCount} 張\n` +
            `📁 *文件大小:* ${formatFileSize(result.fileSize)}\n` +
            `📄 *文件名:* ${result.fileName}\n\n` +
            '💡 PDF 已發送給您。'
        );
    }

    /**
     * 获取会话状态
     */
    getSessionStatus(userId) {
        const session = this.sessions.get(userId);
        if (!session) return null;
        return {
            title: session.title,
            photoCount: session.photos.length,
            createdAt: session.createdAt,
        };
    }

    hasSession(userId) {
        return this.sessions.has(userId);
    }

    isWaitingForTitle(userId) {
        const session = this.sessions.get(userId);
        return session && session.state === 'waiting_for_title';
    }

    // 清理超时会话（30 分钟）
    cleanupStaleSessions(timeoutMs = 30 * 60 * 1000) {
        const now = Date.now();
        for (const [userId, session] of this.sessions.entries()) {
            if (now - session.createdAt > timeoutMs) {
                session.photos.forEach((p) => {
                    try {
                        fs.unlinkSync(p.path);
                    } catch {}
                });
                this.sessions.delete(userId);
            }
        }
    }
}

module.exports = ImageToPdf;
