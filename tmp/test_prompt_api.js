/**
 * 測試 Chrome Built-in Prompt API (Gemini Nano)
 *
 * Chrome 148 支援 LanguageModel API，可以用本地 AI 分析圖片。
 * 唔需要 API key，唔需要 cookies，完全免費。
 *
 * 運行：node tmp/test_prompt_api.js
 */

const puppeteer = require('puppeteer');
const path = require('path');

const PHOTO_PATH = 'C:\\Users\\HFTC\\Desktop\\whatsapp 影材料相.jpg';
const USER_DATA_DIR = 'C:\\Users\\HFTC\\AppData\\Local\\Google\\Chrome\\User Data';
const LOCKFILE = path.join(USER_DATA_DIR, 'lockfile');

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    console.log('=== 測試 Chrome Built-in Prompt API ===\n');

    // 用全新 Profile（唔影響用戶原本嘅 Chrome）
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--headless=new',
            '--enable-features=PromptAPIForGeminiNano,OptimizationGuideOnDeviceModel',
            '--optimization-guide-on-device-model-install',
        ],
    });

    try {
        const page = await browser.newPage();

        // 檢查 Prompt API 係咪可用
        const result = await page.evaluate(async () => {
            const report = {};

            // Check 1: 有冇 ai 物件
            report.hasAi = typeof self !== 'undefined' && 'ai' in self;
            report.aiKeys = report.hasAi ? Object.keys(self.ai) : [];

            // Check 2: languageModel 可用
            if (report.hasAi && self.ai.languageModel) {
                try {
                    const capabilities = await self.ai.languageModel.capabilities();
                    report.capabilities = {
                        available: capabilities.available,
                        defaultTopK: capabilities.defaultTopK,
                        maxTopK: capabilities.maxTopK,
                        supportsLanguage: typeof capabilities.supportsLanguage === 'function' ?
                            capabilities.supportsLanguage('zh') : 'unknown',
                    };
                } catch (e) {
                    report.lmError = e.message;
                }
            }

            report.navigatorAI = 'languageModel' in navigator ? navigator.languageModel?.capabilities?.() : null;
            try {
                // 嘗試其他 AI APIs
                const canCreate = await self.ai?.languageModel?.capabilities?.();
                report.canCreateText = canCreate?.available;
            } catch (e) {
                report.otherError = e.message;
            }

            return report;
        });

        console.log('檢測結果：');
        console.log(JSON.stringify(result, null, 2));

        // 如果可用，試用圖片分析
        if (result.capabilities && result.capabilities.available === 'readily') {
            console.log('\n✅ Prompt API 可用！嘗試分析圖片...');

            // 讀取圖片做 base64
            const fs = require('fs');
            const imgBase64 = fs.readFileSync(PHOTO_PATH, { encoding: 'base64' });
            const dataUrl = `data:image/jpeg;base64,${imgBase64}`;

            // Create session with the image
            const analyzeResult = await page.evaluate(async (imgDataUrl) => {
                try {
                    const session = await self.ai.languageModel.create({
                        systemPrompt: '你係工地物料標籤識別助手。請列出相片中所有圖紙編號（drawing numbers）。只需回覆圖號，用逗號分隔。',
                    });

                    const result = await session.prompt(imgDataUrl);
                    session.destroy();
                    return { success: true, text: result };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }, dataUrl);

            console.log('分析結果：', analyzeResult);
        } else {
            console.log('\n❌ Prompt API 未就緒');
            console.log('請喺 Chrome 開啟 chrome://flags/#prompt-api-for-gemini-nano');
            console.log('及 chrome://flags/#optimization-guide-on-device-model');
            console.log('然後下載 Gemini Nano 模型（約 2GB）');
        }

    } finally {
        await browser.close();
        console.log('\nChrome 已關閉');
    }
}

main().catch(console.error);
