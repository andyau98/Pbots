const axios = require('axios');
const cheerio = require('cheerio');

class RealNewsFetcher {
    constructor(config = {}) {
        this.config = config;
        this.userAgent =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        console.log('📰 真實新聞抓取工具已初始化（Google News RSS + cheerio）');
        this.urlCache = new Map(); // 緩存已解析的 URL
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
     * 從 Google News 文章頁面提取真實文章 URL
     */
    async extractRealUrl(googleNewsUrl) {
        // 檢查緩存
        if (this.urlCache.has(googleNewsUrl)) {
            return this.urlCache.get(googleNewsUrl);
        }
        
        try {
            // 嘗試直接提取 URL 參數
            const urlMatch = googleNewsUrl.match(/[?&]url=([^&]+)/);
            if (urlMatch && urlMatch[1]) {
                try {
                    const realUrl = decodeURIComponent(urlMatch[1]);
                    this.urlCache.set(googleNewsUrl, realUrl);
                    return realUrl;
                } catch {}
            }
            
            // 嘗試 fetch HTML 並提取 og:url
            const html = await this.fetchUrl(googleNewsUrl);
            if (html) {
                const $ = cheerio.load(html);
                
                // 嘗試多種方式提取真實 URL
                const ogUrl = $('meta[property="og:url"]').attr('content');
                if (ogUrl && !ogUrl.includes('news.google.com')) {
                    this.urlCache.set(googleNewsUrl, ogUrl);
                    return ogUrl;
                }
                
                const canonical = $('link[rel="canonical"]').attr('href');
                if (canonical && !canonical.includes('news.google.com')) {
                    this.urlCache.set(googleNewsUrl, canonical);
                    return canonical;
                }
                
                // 嘗試搵 anylink
                const anyLink = $('a.anylink, a[rel="noopener"]').first().attr('href');
                if (anyLink && anyLink.startsWith('http') && !anyLink.includes('news.google.com')) {
                    this.urlCache.set(googleNewsUrl, anyLink);
                    return anyLink;
                }
            }
        } catch {}
        
        // 如果都提取唔到，返回原始 URL
        this.urlCache.set(googleNewsUrl, googleNewsUrl);
        return googleNewsUrl;
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

            const articles = this.parseGoogleNewsRss(xml);
            
            // 提取真實 URL（非同步，不阻塞）
            const articleCount = articles.length;
            console.log(`   📰 找到 ${articleCount} 篇文章，正在提取真實連結...`);
            
            // 使用 Promise.all 並行提取，但限制並發數量避免被封
            const realUrlPromises = articles.map((article, index) => {
                return this.extractRealUrl(article.url).then(realUrl => {
                    article.url = realUrl;
                    if ((index + 1) % 5 === 0) {
                        console.log(`   ⏳ 已處理 ${index + 1}/${articleCount} 篇`);
                    }
                    return article;
                });
            });
            
            return Promise.all(realUrlPromises);
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
                url: link, // 原始 Google News 連結，稍後會被 extractRealUrl 替換
                source: source,
                date: pubDate ? new Date(pubDate) : new Date(),
                description: cleanDesc,
                isReal: false,
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
            '📰 來源: Google News（顯示原始文章連結）\n' +
            `📊 相關新聞: ${articles.length} 條\n\n`;

        // 顯示前 7 條
        const topArticles = articles.slice(0, 7);

        topArticles.forEach((article, index) => {
            const dateStr = article.date.toLocaleDateString('zh-HK', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            });
            
            // 縮短 URL 顯示（使用真實連結）
            let shortUrl = article.url;
            try {
                const urlObj = new URL(article.url);
                shortUrl = urlObj.hostname.replace('www.', '') + urlObj.pathname;
                if (shortUrl.length > 50) {
                    shortUrl = shortUrl.substring(0, 47) + '...';
                }
            } catch {
                shortUrl = article.url.substring(0, 50) + '...';
            }
            
            report += '━━━━━━━━━━━━━━━━\n';
            report += `${index + 1}. *${article.title}*\n`;
            report += `📅 ${dateStr}  |  📢 ${article.source || shortUrl}\n`;

            if (article.description && article.description.length > 10) {
                report += `📝 ${article.description}\n`;
            }
            report += `\n🔗 ${article.url}\n`;
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
