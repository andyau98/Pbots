const axios = require('axios');
const cheerio = require('cheerio');

class RealNewsFetcher {
    constructor(config = {}) {
        this.config = config;
        this.userAgent =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        console.log('📰 真實新聞抓取工具已初始化（Google News RSS + cheerio）');
    }

    /**
     * 發送 HTTP GET 請求（使用 axios，自動處理 redirect 和 timeout）
     */
    async fetchUrl(url) {
        try {
            const res = await axios.get(url, {
                headers: { 'User-Agent': this.userAgent },
                timeout: 15000,
                maxRedirects: 5,
                responseType: 'text',
            });
            return res.data;
        } catch {
            return '';
        }
    }

    /**
     * 從 Google News RSS 搜索新聞
     */
    async searchGoogleNews(query) {
        try {
            const encodedQuery = encodeURIComponent(query);
            const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant`;
            const xml = await this.fetchUrl(url);

            if (!xml) return [];

            return this.parseGoogleNewsRss(xml);
        } catch (error) {
            console.error(
                `   ❌ Google News 搜索失敗 (${query}):`,
                error.message
            );
            return [];
        }
    }

    /**
     * 使用 cheerio 解析 Google News RSS XML
     */
    parseGoogleNewsRss(xml) {
        const articles = [];
        const $ = cheerio.load(xml, { xmlMode: true });

        $('item').each((_, item) => {
            const title = $(item).find('title').text().trim();
            const link = $(item).find('link').text().trim();
            const pubDate = $(item).find('pubDate').text().trim();
            const description = $(item).find('description').text().trim();

            if (!title || title === 'Google 新聞') return;

            // 從 title 中提取來源（格式：標題 - 來源名稱）
            let source = '';
            let cleanTitle = title;
            const sourceMatch = title.match(/ - ([^-]+)$/);
            if (sourceMatch) {
                source = sourceMatch[1].trim();
                cleanTitle = title
                    .substring(0, title.lastIndexOf(' - '))
                    .trim();
            }

            // 清理 description 中的 HTML
            const cleanDesc = description
                ? description
                      .replace(/<[^>]*>/g, '')
                      .replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&#39;/g, "'")
                      .replace(/&quot;/g, '"')
                      .replace(/&nbsp;/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim()
                : '';

            articles.push({
                title: cleanTitle,
                url: link,
                source: source,
                date: pubDate ? new Date(pubDate) : new Date(),
                description: cleanDesc,
                isReal: true,
            });
        });

        return articles;
    }

    /**
     * 獲取香港地盤意外新聞
     */
    async getConstructionAccidentNews() {
        const searchQueries = [
            '香港 地盤 意外',
            '香港 工業意外',
            '香港 地盤 工傷',
            '香港 建造 意外 安全',
        ];

        let allArticles = [];

        for (const query of searchQueries) {
            console.log(`   🔍 搜索: "${query}"`);
            const articles = await this.searchGoogleNews(query);
            console.log(`   ✅ "${query}" 找到 ${articles.length} 條結果`);
            allArticles.push(...articles);
        }

        // 去重（按 URL）
        const seen = new Set();
        const unique = allArticles.filter((a) => {
            if (seen.has(a.url)) return false;
            seen.add(a.url);
            return true;
        });

        // 按日期排序（新→舊）
        unique.sort((a, b) => b.date - a.date);

        console.log(`📰 總共找到 ${unique.length} 條真實地盤相關新聞`);

        return unique;
    }

    /**
     * 格式化新聞報告
     */
    formatNewsReport(articles) {
        const now = new Date();
        const hkTime = new Date(
            now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' })
        );

        if (!articles || articles.length === 0) {
            return (
                '🚧 *香港地盤意外新聞報告*\n\n' +
                `📅 報告時間: ${hkTime.toLocaleString('zh-HK', { hour12: false })}\n` +
                '📍 地區: 香港特別行政區\n' +
                '📰 來源: Google News\n\n' +
                '✅ *暫無新消息*\n' +
                '今日暫無新的地盤意外新聞報告。\n\n' +
                '💡 *地盤安全提示*\n' +
                '• 嚴格遵守安全操作規程\n' +
                '• 定期檢查施工設備\n' +
                '• 確保工人佩戴適當防護裝備'
            );
        }

        let report =
            '🚧 *香港地盤意外新聞報告*\n\n' +
            `📅 報告時間: ${hkTime.toLocaleString('zh-HK', { hour12: false })}\n` +
            '📍 地區: 香港特別行政區\n' +
            '📰 來源: Google News 即時新聞\n' +
            `📊 相關新聞: ${articles.length} 條\n\n`;

        // 顯示前 7 條
        const topArticles = articles.slice(0, 7);

        topArticles.forEach((article, index) => {
            const dateStr = article.date.toLocaleDateString('zh-HK', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            });
            report += '━━━━━━━━━━━━━━━━\n';
            report += `${index + 1}. *${article.title}*\n`;
            report += `📅 ${dateStr}  |  📢 ${article.source || '新聞來源'}\n`;

            if (article.description && article.description.length > 10) {
                report += `📝 ${article.description}\n`;
            }
            if (article.url) {
                report += `🔗 ${article.url}\n`;
            }
            report += '\n';
        });

        report +=
            '💡 *地盤安全提示*\n' +
            '• 嚴格遵守安全操作規程\n' +
            '• 定期檢查施工設備狀態\n' +
            '• 確保工人佩戴適當防護裝備\n' +
            '• 加強高空作業安全監管';

        return report;
    }
}

module.exports = RealNewsFetcher;
