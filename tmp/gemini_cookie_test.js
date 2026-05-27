/**
 * 測試 Gemini Web Cookie 方法
 *
 * 用 Puppeteer 連接用戶 Chrome，提取 Gemini cookies，
 * 然後用 cookies 直接 call Gemini backend API 識別相片文字。
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PHOTO_PATH = 'C:\\Users\\HFTC\\Desktop\\whatsapp 影材料相.jpg';
const USER_DATA_DIR = 'C:\\Users\\HFTC\\AppData\\Local\\Google\\Chrome\\User Data';
const LOCKFILE = path.join(USER_DATA_DIR, 'lockfile');

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function extractGeminiCookies() {
    console.log('=== 測試 Gemini Cookie 方法 ===\n');

    // 1. 暫時移除 lockfile（Chrome 正在運行，移除後再還原）
    let hadLock = false;
    if (fs.existsSync(LOCKFILE)) {
        console.log('發現 lockfile，暫時移除...');
        fs.unlinkSync(LOCKFILE);
        hadLock = true;
    }

    let browser;
    try {
        console.log('啟動 Chrome（用用戶 Profile 1）...');
        browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            userDataDir: USER_DATA_DIR,
            args: [
                '--profile-directory=Profile 1',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--remote-debugging-port=0',  // auto-assign
                '--no-first-run',
                '--disable-sync',
            ],
            headless: false,  // 需要見到畫面
        });

        const page = await browser.newPage();
        console.log('前往 gemini.google.com...');
        await page.goto('https://gemini.google.com', {
            waitUntil: 'networkidle0',
            timeout: 30000,
        });

        await sleep(2000);

        // 檢查是否已登入
        const url = page.url();
        console.log('當前 URL:', url);

        // 提取 cookies
        const cookies = await page.cookies('https://gemini.google.com');
        console.log(`\n找到 ${cookies.length} 個 cookies:`);
        for (const c of cookies) {
            console.log(`  ${c.name}: ${c.value.substring(0, 20)}...`);
        }

        // 檢查重點 cookies
        const sid = cookies.find(c => c.name === '__Secure-1PSID');
        const sidts = cookies.find(c => c.name === '__Secure-1PSIDTS');

        if (sid && sidts) {
            console.log('\n✅ 成功提取 Gemini cookies!');
            console.log(`__Secure-1PSID: ${sid.value.substring(0, 30)}...`);
            console.log(`__Secure-1PSIDTS: ${sidts.value.substring(0, 30)}...`);

            return { sid: sid.value, sidts: sidts.value };
        } else {
            console.log('\n❌ 未找到 Gemini cookies（可能未登入）');
            console.log('p 請確保已在 Chrome 登入 gemini.google.com');
            return null;
        }

    } catch (err) {
        console.error('\n❌ 錯誤:', err.message);
        return null;
    } finally {
        if (browser) {
            await browser.close();
            console.log('\nChrome 已關閉');
        }
        // 還原 lockfile
        if (hadLock && !fs.existsSync(LOCKFILE)) {
            fs.writeFileSync(LOCKFILE, '');
            console.log('lockfile 已還原');
        }
    }
}

async function testGeminiApi(sid, sidts) {
    console.log('\n=== 測試 Gemini API ===\n');

    if (!fs.existsSync(PHOTO_PATH)) {
        console.error('❌ 相片不存在:', PHOTO_PATH);
        return;
    }

    const photoBase64 = fs.readFileSync(PHOTO_PATH, { encoding: 'base64' });
    const mimeType = 'image/jpeg';

    // Gemini web API endpoint（reverse engineered from gemini.google.com）
    // 使用 undocumented API endpoint
    const API_URL = 'https://gemini.google.com/_/BardChatUi/data/assistant/launch';

    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Cookie': `__Secure-1PSID=${sid}; __Secure-1PSIDTS=${sidts}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Same-Domain': '1',
    };

    // Try using fetch (Node 18+)
    try {
        console.log('發送請求到 Gemini API...');

        // 第一種方法：Bard API format
        const formData = new URLSearchParams();
        formData.append('f.req', JSON.stringify([
            null,
            JSON.stringify([
                [null, null, null, null, null, null, null, null, [
                    [photoBase64, 1],
                    null,
                    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
                    null, null, null, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null,
                    null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
                    null, null, null, null, null, null, null, null, null, 0, 0, 1, null, null,
                ]]
            ]),
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        ]));

        const response = await fetch(API_URL, {
            method: 'POST',
            headers,
            body: formData,
        });

        const text = await response.text();
        console.log('Response status:', response.status);
        console.log('Response preview:', text.substring(0, 500));

    } catch (err) {
        console.error('Fetch error:', err.message);

        // 第二種方法：用 Node fetch + Gemini upload API
        console.log('\n嘗試第二種方法...');
        try {
            const uploadUrl = 'https://gemini.google.com/_/BardChatUi/data/assistant/upload';
            const uploadForm = new URLSearchParams();
            uploadForm.append('f.req', JSON.stringify([
                null, JSON.stringify([
                    [photoBase64, mimeType, null, 0]
                ])
            ]));

            const upResp = await fetch(uploadUrl, {
                method: 'POST',
                headers,
                body: uploadForm,
            });
            console.log('Upload response:', upResp.status, await upResp.text().then(t => t.substring(0, 300)));
        } catch (e2) {
            console.error('Upload error:', e2.message);
        }
    }
}

async function main() {
    const cookies = await extractGeminiCookies();
    if (cookies) {
        // 暫時唔 test API，先確認 cookies 可用
        console.log('\nCookies 提取成功！');
        console.log('下一步：用 cookies 測試 Gemini API');
        await testGeminiApi(cookies.sid, cookies.sidts);
    }
}

main().catch(console.error);
