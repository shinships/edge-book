import OpenAI from 'openai';
import { config } from '../config';
import { UserService, UserProfile } from './user.service';
import { TradeAnalytics } from './trade.service';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

const MAX_HISTORY_MESSAGES = 50;

export class AIService {
    private client: OpenAI;
    private userService: UserService;
    private chatHistories: Map<number, ChatMessage[]>;

    constructor() {
        this.client = new OpenAI({
            apiKey: config.vertexKeyApiKey,
            baseURL: config.vertexKeyBaseUrl,
        });
        this.userService = new UserService();
        this.chatHistories = new Map();
    }

    getUserService(): UserService {
        return this.userService;
    }

    private getSystemInstruction(profile: UserProfile): string {
        const name = profile.fullName || 'bạn';
        const job = profile.jobTitle ? ` Nghề nghiệp: ${profile.jobTitle}.` : '';
        const notes = profile.notes && profile.notes.length > 0
            ? `\nGhi chú về người dùng:\n- ${profile.notes.join('\n- ')}`
            : '';

        return `Bạn là trợ lý cá nhân thân thiết của ${name} — gọi là "S" (viết tắt của Shin Assistant).${job}
${notes}

TÍNH CÁCH & GIỌNG ĐIỆU:
- Vui vẻ, năng lượng tích cực, dùng emoji vừa phải 🎯
- Thân mật như bạn bè thân, KHÔNG cứng nhắc hay formal
- Trả lời NGẮN GỌN — ưu tiên súc tích hơn dài dòng
- Dùng tiếng Việt là chính, mix tiếng Anh tự nhiên khi cần

KHI BRAINSTORMING:
- Chủ động đề xuất ý tưởng bất ngờ, góc nhìn mới
- Hỏi ngược lại để đào sâu hơn nếu cần
- Dùng bullet points khi liệt kê ý tưởng để dễ đọc
- Khuyến khích và build on top of ý tưởng của người dùng

FORMAT TRẢ LỜI:
- KHÔNG dùng ** để in đậm, KHÔNG dùng # cho heading
- KHÔNG hiển thị URL dài — dùng [Tên nguồn](URL) nếu cần link
- Dấu gạch dưới _ phải được escape thành \\_
- Emoji: dùng tự nhiên, không quá 2-3 cái mỗi tin`;
    }

    private getOrCreateHistory(userId: number): ChatMessage[] {
        if (!this.chatHistories.has(userId)) {
            const profile = this.userService.getUser(userId);
            const systemMessage: ChatMessage = {
                role: 'system',
                content: this.getSystemInstruction(profile),
            };
            this.chatHistories.set(userId, [systemMessage]);
        }
        return this.chatHistories.get(userId)!;
    }

    refreshSession(userId: number) {
        this.chatHistories.delete(userId);
    }

    async chat(prompt: string, userId: number): Promise<string> {
        try {
            const history = this.getOrCreateHistory(userId);

            // Add user message
            history.push({ role: 'user', content: prompt });

            // Trim history if too long (keep system prompt + recent messages)
            if (history.length > MAX_HISTORY_MESSAGES + 1) {
                const systemMsg = history[0];
                const recentMessages = history.slice(-(MAX_HISTORY_MESSAGES));
                history.length = 0;
                history.push(systemMsg, ...recentMessages);
            }

            const completion = await this.client.chat.completions.create({
                model: config.chatModel,  // Sonnet — smart chat
                messages: history,
            });

            let text = completion.choices[0]?.message?.content || 'No response from AI.';

            // Add assistant response to history
            history.push({ role: 'assistant', content: text });

            // Post-processing for Telegram Markdown compatibility
            text = text.replace(/\*/g, '');
            text = text.replace(/(^|\n)#+\s/g, '$1');
            text = text.replace(/_/g, '\\_');

            return text;
        } catch (error) {
            console.error('AI API Error:', error);
            return 'Xin lỗi, tôi đang gặp sự cố khi kết nối với AI.';
        }
    }

    async analyzeForCalendar(text: string): Promise<any> {
        const prompt = `
        Analyze the following text and extract calendar event details if present.
        Return ONLY a JSON object with keys: title (string), startTime (ISO string), endTime (ISO string), description (string, optional).
        If no event is found, return null.
        Text: "${text}"
        `;

        try {
            const completion = await this.client.chat.completions.create({
                model: config.fastModel,  // Haiku — simple extraction task
                messages: [
                    { role: 'system', content: 'You are a JSON extraction assistant. Only output valid JSON or null.' },
                    { role: 'user', content: prompt },
                ],
            });

            const textResponse = completion.choices[0]?.message?.content || '';
            // Simple cleanup to handle potential markdown code blocks
            const jsonStr = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (error) {
            console.error('AI Calendar Analysis Error:', error);
            return null;
        }
    }

    // --- Research OS: AI-Powered Methods ---

    /**
     * Generate a daily digest summary from research items.
     */
    async generateDigest(digestData: {
        totalItems: number;
        topTickers: { ticker: string; count: number; items: { content: string; sentiment: number; sourceName?: string }[] }[];
        uncategorized: { content: string }[];
    }): Promise<string> {
        if (digestData.totalItems === 0) {
            return '📭 Không có research mới trong 24 giờ qua.';
        }

        // Build context for AI
        const tickerSummaries = digestData.topTickers.slice(0, 5).map(t => {
            const snippets = t.items.slice(0, 5).map(i => {
                const source = i.sourceName ? `[${i.sourceName}]` : '';
                return `${source} ${i.content.substring(0, 200)}`;
            }).join('\n');
            const avgSentiment = t.items.reduce((sum, i) => sum + i.sentiment, 0) / t.items.length;
            return `--- ${t.ticker} (${t.count} mentions, sentiment: ${avgSentiment.toFixed(2)}) ---\n${snippets}`;
        }).join('\n\n');

        const prompt = `Tạo Daily Research Digest từ data sau. Format ngắn gọn, dễ đọc trên Telegram (không dùng ** hay #).

Tổng: ${digestData.totalItems} items

${tickerSummaries}

${digestData.uncategorized.length > 0 ? `\nKhác (${digestData.uncategorized.length} items): ${digestData.uncategorized.slice(0, 3).map(i => i.content.substring(0, 100)).join('; ')}` : ''}

Format yêu cầu:
1. Header với emoji và ngày
2. Top tickers với số mentions
3. Mỗi ticker: 2-3 bullet key insights + sentiment emoji (🟢/🟡/🔴)
4. Action items hoặc things to watch (nếu có)
5. Giữ ngắn, tối đa 400 từ`;

        try {
            const completion = await this.client.chat.completions.create({
                model: config.fastModel,
                messages: [
                    { role: 'system', content: 'Bạn là research analyst assistant. Tạo digest ngắn gọn, insight-driven, không dùng markdown formatting (* # _).' },
                    { role: 'user', content: prompt },
                ],
            });

            let text = completion.choices[0]?.message?.content || 'Không thể tạo digest.';
            // Clean markdown
            text = text.replace(/\*/g, '');
            text = text.replace(/(^|\n)#+\s/g, '$1');
            text = text.replace(/_/g, '\\_');
            return text;
        } catch (error) {
            console.error('AI Digest Error:', error);
            return '⚠️ Lỗi khi tạo digest. Vui lòng thử lại sau.';
        }
    }

    /**
     * Answer a question about the user's saved research.
     */
    async askAboutResearch(question: string, researchItems: { content: string; tickers: string[]; sourceName?: string; createdAt: string }[]): Promise<string> {
        if (researchItems.length === 0) {
            return '📭 Bạn chưa lưu research nào. Forward messages vào bot để bắt đầu!';
        }

        // Build context from recent research (limit to avoid token overflow)
        const context = researchItems.slice(-30).map((item, idx) => {
            const date = new Date(item.createdAt).toLocaleDateString('vi-VN');
            const source = item.sourceName ? `[${item.sourceName}]` : '';
            const tickers = item.tickers.length > 0 ? `(${item.tickers.join(', ')})` : '';
            return `${idx + 1}. ${date} ${source} ${tickers}: ${item.content.substring(0, 300)}`;
        }).join('\n');

        const prompt = `Dựa trên research data đã lưu của user, trả lời câu hỏi sau.

RESEARCH DATA (${researchItems.length} items, showing recent):
${context}

CÂU HỎI: ${question}

Trả lời ngắn gọn, cite source nếu có. Không dùng markdown formatting.`;

        try {
            const completion = await this.client.chat.completions.create({
                model: config.chatModel,
                messages: [
                    { role: 'system', content: 'Bạn là research assistant. Trả lời dựa trên data user đã lưu. Ngắn gọn, chính xác, không dùng * # _.' },
                    { role: 'user', content: prompt },
                ],
            });

            let text = completion.choices[0]?.message?.content || 'Không thể trả lời.';
            text = text.replace(/\*/g, '');
            text = text.replace(/(^|\n)#+\s/g, '$1');
            text = text.replace(/_/g, '\\_');
            return text;
        } catch (error) {
            console.error('AI Research Q&A Error:', error);
            return '⚠️ Lỗi khi phân tích research. Vui lòng thử lại sau.';
        }
    }

    /**
     * Generate a short coaching insight from a trader's performance breakdown.
     * Returns an empty string on failure so callers can simply skip the section.
     */
    async generateTradeInsight(analytics: TradeAnalytics): Promise<string> {
        if (analytics.closedCount === 0) return '';

        const tickerLines = analytics.byTicker
            .slice(0, 8)
            .map((t) => `${t.ticker}: ${t.trades} lệnh, win ${t.winRate}%, PnL ${t.totalPnl}%`)
            .join('\n');
        const dirLines = analytics.byDirection
            .map((d) => `${d.direction}: ${d.trades} lệnh, win ${d.winRate}%, PnL ${d.totalPnl}%`)
            .join('\n');
        const monthLines = analytics.byMonth
            .map((m) => `${m.month}: ${m.trades} lệnh, win ${m.winRate}%, PnL ${m.totalPnl}%`)
            .join('\n');

        const prompt = `Phân tích hiệu suất giao dịch của trader dưới đây và đưa ra nhận xét hữu ích.

Tổng lệnh đã đóng: ${analytics.closedCount}
${analytics.avgHoldHours !== null ? `Thời gian giữ lệnh trung bình: ${analytics.avgHoldHours} giờ\n` : ''}
THEO TICKER:
${tickerLines}

THEO HƯỚNG:
${dirLines}

THEO THÁNG:
${monthLines}

Yêu cầu: 3-5 bullet ngắn gọn, insight thực chiến (điểm mạnh, điểm yếu, ticker/hướng nên tập trung hay tránh, gợi ý cải thiện). Không dùng markdown (* # _). Tiếng Việt.`;

        try {
            const completion = await this.client.chat.completions.create({
                model: config.chatModel,
                messages: [
                    { role: 'system', content: 'Bạn là trading performance coach. Đưa nhận xét sắc bén, thực tế, dựa trên số liệu. Không dùng * # _.' },
                    { role: 'user', content: prompt },
                ],
            });

            let text = completion.choices[0]?.message?.content || '';
            text = text.replace(/\*/g, '');
            text = text.replace(/(^|\n)#+\s/g, '$1');
            text = text.replace(/_/g, '\\_');
            return text.trim();
        } catch (error) {
            console.error('AI Trade Insight Error:', error);
            return '';
        }
    }
}
