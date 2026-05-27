/**
 * 工人考勤模組 (Worker Attendance)
 *
 * 功能：
 * - 每日 9:00 AM 自動發私訊給各判頭收集工人人數
 * - 支援手動觸發 #申報、#今日人數、#考勤報表
 * - 自動填入 HGRH 開工人數 Excel 表
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { dataStore } = require('../src/core/dataStore');
const { sessionManager } = require('../src/core/sessionManager');

// ========== Excel 路徑 ==========

const EXCEL_FILE = path.join(
    __dirname,
    '..',
    'Sample',
    'LabourSummary',
    'HGRH開工人數表.xlsx'
);

// ========== 判頭管理 ==========

function getForemen() {
    return dataStore._read('foremen.json', []);
}

function saveForemen(foremen) {
    dataStore._write('foremen.json', foremen);
}

function registerForeman(phone, name, company, groupId, excelColumn) {
    let foremen = getForemen();
    // 同一 WhatsApp 用戶只能登記一家公司：同 phone 就取代舊的
    const existingIdx = foremen.findIndex((f) => f.phone === phone);
    if (existingIdx >= 0) {
        const removed = foremen.splice(existingIdx, 1)[0];
        console.log(
            `🔄 用戶 ${phone} 重新登記: ${removed.company} → ${company}`
        );
    }
    const id = 'foreman_' + Date.now();
    foremen.push({ id, name, phone, company, group: groupId, excelColumn });
    saveForemen(foremen);
    return id;
}

function removeForeman(id) {
    let foremen = getForemen();
    foremen = foremen.filter((f) => f.id !== id);
    saveForemen(foremen);
}

// ========== Excel 讀寫 ==========

/**
 * 找出今天對應的行和指定欄位位置（使用 exceljs 保留格式）
 *
 * Excel 結構：
 *   Row 1: 空行
 *   Row 2: 標題（如 "HGRH 葛量洪醫院..."）
 *   Row 3: 欄位名稱（月份, 周, 天氣, 公司1, 公司2..., 總數）
 *   Row 4+: 每日數據（日期序號, 周, 天氣, 人數..., 總數）
 */
async function findTodayCell() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(EXCEL_FILE);

    const now = new Date();
    const monthStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 尋找當前月份 sheet
    let ws = wb.getWorksheet(monthStr);
    if (!ws) {
        // 嘗試模糊匹配
        for (const sheet of wb.worksheets) {
            if (sheet.name.trim() === monthStr) {
                ws = sheet;
                break;
            }
        }
    }
    if (!ws) {
        // 複製上一個 sheet 作為模板
        const lastWs = wb.worksheets[wb.worksheets.length - 1];
        ws = wb.addWorksheet(monthStr);
        // 複製欄寬
        if (lastWs.columns) {
            ws.columns = lastWs.columns.map(col => ({ ...col, header: undefined }));
        }
        // 複製合併儲存格
        if (lastWs.model.merges) {
            for (const merge of lastWs.model.merges) {
                ws.mergeCells(merge);
            }
        }
        // 複製結構（值 + 樣式）
        lastWs.eachRow({ includeEmpty: true }, (row, rowNum) => {
            row.eachCell({ includeEmpty: true }, (cell, colNum) => {
                const newCell = ws.getCell(rowNum, colNum);
                newCell.value = cell.value;
                if (cell.style) newCell.style = { ...cell.style };
            });
        });
    }

    // ---- 動態找出各欄位索引 ----
    // Excel 結構：日期欄 | 周 | 天氣 | 公司1 | 公司2... | 總數
    let headerRowNum = -1;
    let weekCol = -1; // 「周」欄（日期在其前一欄）
    let dateCol = -1; // 日期序號欄
    let weatherCol = -1; // 天氣欄
    let totalCol = -1; // 總數欄

    ws.eachRow({ includeEmpty: true }, (row, rowNum) => {
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
            const val = String(cell.value || '').trim();
            if (val === '周') {
                weekCol = colNum;
                dateCol = colNum - 1;
            }
            if (val === '天氣') weatherCol = colNum;
            if (val === '總數') totalCol = colNum;
        });
        if (
            dateCol >= 0 &&
            weatherCol >= 0 &&
            totalCol >= 0 &&
            headerRowNum === -1
        ) {
            headerRowNum = rowNum;
        }
    });

    if (headerRowNum === -1) {
        throw new Error(`找不到月份 ${monthStr} 的標題列`);
    }

    // 讀取標題列的公司名稱
    const headerRow = [];
    for (let c = 1; c <= totalCol; c++) {
        headerRow.push(String(ws.getCell(headerRowNum, c).value || '').trim());
    }
    const companyStartCol = weatherCol + 1; // 天氣欄之後第一個即為公司欄

    // ---- 固定行計算：每日一行，永不定位錯誤 ----
    // 結構：標題行後，第1天在 headerRowNum+1，第2天在 headerRowNum+2...
    // 今天 = headerRowNum + 今天的日期
    const dayOfMonth = now.getDate();
    const dataRowNum = headerRowNum + dayOfMonth;
    const weekNames = ['日', '一', '二', '三', '四', '五', '六'];

    // 若該行尚無日期，寫入日期／周
    const existingDate = ws.getCell(dataRowNum, dateCol).value;
    if (
        !existingDate ||
        (typeof existingDate === 'number' && existingDate < 1)
    ) {
        // 用 Asia/Hong_Kong 時區計算日期
        const hkNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
        // Excel 日期序列：1899-12-30 係第 0 日
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const todaySerial = Math.floor(
            (Date.UTC(hkNow.getFullYear(), hkNow.getMonth(), hkNow.getDate()) - excelEpoch.getTime()) / 86400000
        );
        // Lotus 123 閏年修正：Excel 錯誤地將 1900-02-29 當作有效日期
        const excelSerial = todaySerial + (todaySerial >= 61 ? 2 : 1);
        ws.getCell(dataRowNum, dateCol).value = excelSerial;
        ws.getCell(dataRowNum, weekCol).value = weekNames[hkNow.getDay()];
    }

    return {
        sheetName: monthStr,
        headerRow,
        headerRowNum,
        dataRowNum,
        dateCol,
        weatherCol,
        totalCol,
        companyStartCol,
        workbook: wb,
        worksheet: ws,
    };
}

/**
 * 寫入工人數到 Excel（使用 exceljs 保留原有格式）
 */
async function writeWorkerCount(excelColumn, count) {
    const info = await findTodayCell();
    const {
        sheetName,
        headerRow,
        dataRowNum,
        companyStartCol,
        totalCol,
        workbook,
        worksheet: ws,
    } = info;

    // 動態找出公司欄位索引
    let colNum = -1;
    for (let i = companyStartCol; i < totalCol; i++) {
        if (String(headerRow[i - 1] || '').trim() === excelColumn.trim()) {
            colNum = i;
            break;
        }
    }

    if (colNum === -1) {
        const available = [];
        for (let i = companyStartCol; i < totalCol; i++) {
            available.push(String(headerRow[i - 1] || '').trim());
        }
        throw new Error(
            `找不到 Excel 欄位: "${excelColumn}" (可用: ${available.join(', ')})`
        );
    }

    // 寫入工人數（保留原有格式）
    ws.getCell(dataRowNum, colNum).value = count;

    // 重新計算總數（SUM formula）
    const parts = [];
    for (let c = companyStartCol; c < totalCol; c++) {
        parts.push(`+${ws.getCell(dataRowNum, c).address}`);
    }
    ws.getCell(dataRowNum, totalCol).value = {
        formula: parts.join('').replace(/^\+/, ''),
    };

    // 儲存（保留所有原有格式、樣式、合併儲存格）
    await workbook.xlsx.writeFile(EXCEL_FILE);
    console.log(
        `📊 Excel 已更新: ${sheetName}, Row ${dataRowNum}, Col "${excelColumn}" = ${count}`
    );

    return {
        sheetName,
        row: dataRowNum,
        column: excelColumn,
        count,
        outputPath: EXCEL_FILE,
    };
}

/** 獲取今日已申報數據 */
async function getTodayReport() {
    try {
        const info = await findTodayCell();
        const {
            headerRow,
            dataRowNum,
            companyStartCol,
            totalCol,
            worksheet: ws,
        } = info;

        const counts = {};
        let calcTotal = 0;
        for (let c = companyStartCol; c < totalCol; c++) {
            const company = String(headerRow[c - 1] || '').trim();
            const val = ws.getCell(dataRowNum, c).value;
            const num =
                val !== undefined && val !== null && val !== ''
                    ? Number(val) || 0
                    : 0;
            if (company) {
                counts[company] = num;
                calcTotal += num;
            }
        }
        // 手動計算總數（公式 cell 讀取不直接給數字）
        const formulaVal = ws.getCell(dataRowNum, totalCol).value;
        const total = typeof formulaVal === 'number' ? formulaVal : calcTotal;
        const companies = [];
        for (let c = companyStartCol; c < totalCol; c++) {
            companies.push(String(headerRow[c - 1] || '').trim());
        }
        return { headerRow: companies, counts, total };
    } catch {
        return null;
    }
}

// ========== 讀取 Excel 欄位（公司列表） ==========

/**
 * 從 Excel 範本讀取當前月份的分判商欄位名稱（動態定位）
 * @returns {Promise<Array<{index: number, name: string}>>}
 */
async function getExcelColumns() {
    try {
        const { headerRow, companyStartCol, totalCol } = await findTodayCell();
        const columns = [];
        for (let i = companyStartCol; i < totalCol; i++) {
            const name = String(headerRow[i - 1] || '').trim();
            if (name && name !== '') {
                columns.push({ index: i, name });
            }
        }
        return columns;
    } catch (e) {
        console.error('❌ 讀取 Excel 欄位失敗:', e.message);
        return [];
    }
}

// ========== SessionManager Handler（考勤） ==========

function makeAttendanceHandler(foreman) {
    return {
        name: `考勤申報 (${foreman.company})`,

        async start(ctx) {
            ctx.count = 0;
            ctx.foreman = foreman;

            // 檢查今日是否已有申報記錄
            const today = await getTodayReport();
            const existing =
                today && today.counts[foreman.company] !== undefined
                    ? today.counts[foreman.company]
                    : null;
            ctx.existingCount = existing;

            if (existing !== null) {
                return {
                    question:
                        `📋 *今日已申報: ${existing} 人*\n\n` +
                        `🏢 公司: *${foreman.company}*\n` +
                        `📅 日期: ${new Date().toLocaleDateString('zh-HK')}\n\n` +
                        `如需修改，請輸入新的工人總數：\n` +
                        `輸入 *#cancel* 保留目前數字`,
                };
            }

            return {
                question:
                    `📋 *今日開工人數申報*\n\n` +
                    `🏢 公司: *${foreman.company}*\n` +
                    `📅 日期: ${new Date().toLocaleDateString('zh-HK')}\n\n` +
                    `請輸入今日 *${foreman.company}* 的工人總數：`,
            };
        },

        async handleReply(ctx, replyMessage) {
            const input = replyMessage.body.trim();

            if (input === '#cancel') {
                return {
                    done: true,
                    result: `❌ *${foreman.company}* 考勤申報已取消`,
                };
            }

            // 等待確認階段
            if (ctx.waitingConfirm) {
                if (
                    ['y', 'yes', '是', '確認', 'ok'].includes(
                        input.toLowerCase()
                    )
                ) {
                    try {
                        const result = await writeWorkerCount(
                            foreman.excelColumn,
                            ctx.count
                        );
                        const isModify = ctx.existingCount !== null;
                        return {
                            done: true,
                            result:
                                `✅ *${isModify ? '已修改申報' : '已完成申報'}*\n\n` +
                                `🏢 公司: *${foreman.company}*\n` +
                                `👷 工人數: *${ctx.count} 人*` +
                                (isModify
                                    ? ` (原: ${ctx.existingCount} 人)`
                                    : '') +
                                `\n` +
                                `📅 日期: ${new Date().toLocaleDateString('zh-HK')}\n` +
                                `📊 Excel: ${result.sheetName}`,
                        };
                    } catch (error) {
                        return {
                            done: true,
                            result: `❌ Excel 寫入失敗: ${error.message}`,
                        };
                    }
                }

                // 重新輸入
                ctx.waitingConfirm = false;
                ctx.count = 0;
                return {
                    question: `請重新輸入 *${foreman.company}* 今日工人總數：`,
                };
            }

            // 解析人數
            const numMatch = input.match(/(\d+)/);
            if (!numMatch) {
                return {
                    question: `❌ 請輸入數字。\n\n請輸入 *${foreman.company}* 今日工人總數：`,
                };
            }

            ctx.count = parseInt(numMatch[0], 10);
            ctx.waitingConfirm = true;

            const isModify = ctx.existingCount !== null;
            return {
                question:
                    `✅ *收到: ${ctx.count} 人*\n\n` +
                    (isModify
                        ? `(原申報: ${ctx.existingCount} 人 → 修改為 ${ctx.count} 人)\n\n`
                        : '') +
                    `確認 *${foreman.company}* 今日工人數為 *${ctx.count} 人*？\n\n` +
                    `回覆 \`y\` 確認並寫入 Excel\n` +
                    `回覆其他內容重新輸入人數`,
            };
        },

        async onTimeout(ctx) {
            return `⏰ *${ctx.foreman.company}* 考勤申報已超時，請重新發起 #申報。`;
        },

        async onCancel(ctx) {
            return `❌ *${ctx.foreman.company}* 考勤申報已取消。`;
        },
    };
}

// ========== 每日申報任務（由 scheduler 調用） ==========

async function dailyAttendanceTask(client, foremen) {
    console.log(
        `📋 [Attendance] 開始每日考勤申報，共 ${foremen.length} 位判頭`
    );
    for (const foreman of foremen) {
        try {
            const handler = makeAttendanceHandler(foreman);
            const userId = foreman.phone;
            // 使用 SessionManager 啟動會話（私訊模式，originId = 判頭的電話）
            let originId = foreman.phone;
            if (!originId.includes('@')) originId = originId + '@c.us';

            await sessionManager.start(userId, originId, handler, {}, client);
            console.log(
                `📋 [Attendance] 已向 ${foreman.name}(${foreman.company}) 發送申報請求`
            );
        } catch (error) {
            console.error(
                `❌ [Attendance] 發送給 ${foreman.name} 失敗:`,
                error.message
            );
        }
    }
}

// ========== 匯出 ==========

// ========== 登記判頭 Session Handler ==========

function makeRegisterForemanHandler() {
    return {
        name: '登記判頭',

        async start(ctx) {
            // 讀取 Excel 欄位
            const columns = await getExcelColumns();

            if (columns.length === 0) {
                return {
                    done: true,
                    result: '❌ 無法讀取 Excel 欄位，請確認範本檔案存在。',
                };
            }

            ctx.columns = columns;
            ctx.step = 'select_company';

            let question = '📋 *登記判頭*\n\n';
            question += '請選擇所屬公司（輸入數字）：\n\n';
            columns.forEach((col, i) => {
                question += `${i + 1}. ${col.name}\n`;
            });
            question += '\n輸入 *#cancel* 取消';

            return { question };
        },

        async handleReply(ctx, replyMessage) {
            const input = replyMessage.body.trim();

            if (input === '#cancel') {
                return { done: true, result: '❌ *登記判頭已取消*' };
            }

            if (ctx.step === 'select_company') {
                const num = parseInt(input, 10);
                if (!num || num < 1 || num > ctx.columns.length) {
                    let retry = `❌ 請輸入 1-${ctx.columns.length} 之間的數字：\n\n`;
                    ctx.columns.forEach((col, i) => {
                        retry += `${i + 1}. ${col.name}\n`;
                    });
                    return { question: retry };
                }

                const selected = ctx.columns[num - 1];
                ctx.company = selected.name;
                ctx.excelColumn = selected.name;
                ctx.step = 'confirm';

                return {
                    question:
                        `✅ 已選擇: *${selected.name}*\n\n` +
                        `確認登記？\n` +
                        `回覆 \`y\` 確認\n` +
                        `回覆其他內容重新選擇`,
                };
            }

            if (ctx.step === 'confirm') {
                if (
                    ['y', 'yes', '是', '確認', 'ok'].includes(
                        input.toLowerCase()
                    )
                ) {
                    const id = registerForeman(
                        ctx.userId, // 自動擷取 WhatsApp ID
                        ctx.pushname || '', // 自動擷取 WhatsApp 名稱
                        ctx.company,
                        ctx.groupId || '',
                        ctx.excelColumn
                    );
                    return {
                        done: true,
                        result:
                            '✅ *判頭已登記*\n\n' +
                            `🆔 ${id}\n` +
                            `👤 ${ctx.pushname || ctx.userId}\n` +
                            `📱 ${ctx.userId}\n` +
                            `🏢 ${ctx.company}\n` +
                            `📊 Excel欄位: ${ctx.excelColumn}\n\n` +
                            '💡 每日 9:00 AM 自動發送申報請求。也可隨時發送 `#申報`。',
                    };
                }

                // 重新選擇
                ctx.step = 'select_company';
                let question = '請重新選擇公司（輸入數字）：\n\n';
                ctx.columns.forEach((col, i) => {
                    question += `${i + 1}. ${col.name}\n`;
                });
                return { question };
            }

            return { done: true, result: '❌ 未知步驟，登記已取消。' };
        },

        async onTimeout() {
            return '⏰ *登記判頭已超時*，請重新發起。';
        },

        async onCancel() {
            return '❌ *登記判頭已取消*';
        },
    };
}

// ========== 匯出 ==========

module.exports = {
    getForemen,
    registerForeman,
    removeForeman,
    writeWorkerCount,
    getTodayReport,
    getExcelColumns,
    makeAttendanceHandler,
    makeRegisterForemanHandler,
    dailyAttendanceTask,
};
