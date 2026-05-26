import OpenAI from 'openai';
import { config } from '../config';
import { UserService, UserProfile } from './user.service';

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
}
