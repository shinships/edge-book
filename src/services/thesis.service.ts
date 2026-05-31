import * as fs from 'fs';
import * as path from 'path';

// --- Interfaces ---

export type Stance = 'bullish' | 'bearish';

export interface ThesisItem {
    id: string;
    userId: number;
    ticker: string;            // 'BTC'
    stance: Stance;            // bullish | bearish
    text: string;              // the thesis statement
    status: 'active' | 'closed';
    conflictCount: number;     // # of contradicting research items seen
    createdAt: string;         // ISO
    closedAt?: string;         // ISO
}

export interface UserTheses {
    userId: number;
    items: ThesisItem[];
}

// A research item is considered to contradict a thesis when its sentiment is
// clearly opposite to the thesis stance. Mirrors the 0.2 threshold used for the
// sentiment emoji elsewhere, so "neutral" research never triggers a conflict.
const CONFLICT_THRESHOLD = 0.2;

// --- Service ---

export class ThesisService {
    private dataPath: string;
    private theses: Map<number, ThesisItem[]>;

    constructor() {
        this.dataPath = path.resolve(__dirname, '../../data/theses.json');
        this.theses = new Map();
        this.loadData();
    }

    // --- Persistence ---

    private loadData() {
        if (fs.existsSync(this.dataPath)) {
            try {
                const rawData = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(rawData);
                if (Array.isArray(parsed)) {
                    parsed.forEach((u: UserTheses) => this.theses.set(u.userId, u.items));
                }
            } catch (error) {
                console.error('Error loading thesis data:', error);
            }
        }
    }

    private saveData() {
        try {
            const data: UserTheses[] = Array.from(this.theses.entries()).map(([userId, items]) => ({
                userId,
                items,
            }));
            const dir = path.dirname(this.dataPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmp = `${this.dataPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, this.dataPath);
        } catch (error) {
            console.error('Error saving thesis data:', error);
        }
    }

    private generateId(): string {
        return `th_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    // --- Accessors ---

    getTheses(userId: number): ThesisItem[] {
        if (!this.theses.has(userId)) {
            this.theses.set(userId, []);
        }
        return this.theses.get(userId)!;
    }

    getActiveTheses(userId: number): ThesisItem[] {
        return this.getTheses(userId).filter((t) => t.status === 'active');
    }

    // --- Mutations ---

    addThesis(userId: number, ticker: string, stance: Stance, text: string): ThesisItem {
        const items = this.getTheses(userId);
        const thesis: ThesisItem = {
            id: this.generateId(),
            userId,
            ticker: ticker.toUpperCase(),
            stance,
            text: text.trim(),
            status: 'active',
            conflictCount: 0,
            createdAt: new Date().toISOString(),
        };
        items.push(thesis);
        this.saveData();
        return thesis;
    }

    /**
     * Close an active thesis. `selector` is either a 1-based index into the
     * active-thesis list, or a ticker (closes the most-recent active thesis for
     * that ticker). Returns the closed thesis, or null if nothing matched.
     */
    closeThesis(userId: number, selector: string): ThesisItem | null {
        const active = this.getActiveTheses(userId);
        if (active.length === 0) return null;

        let target: ThesisItem | undefined;
        if (/^\d+$/.test(selector)) {
            const idx = parseInt(selector, 10) - 1;
            target = active[idx];
        } else {
            const upper = selector.toUpperCase();
            // most recent active thesis for this ticker
            target = [...active].reverse().find((t) => t.ticker === upper);
        }
        if (!target) return null;

        target.status = 'closed';
        target.closedAt = new Date().toISOString();
        this.saveData();
        return target;
    }

    /**
     * Find active theses for `ticker` that the given research `sentiment`
     * contradicts (bullish thesis vs clearly bearish data, or vice versa).
     * Increments each conflicting thesis's conflictCount and persists.
     */
    findConflicts(userId: number, ticker: string, sentiment: number): ThesisItem[] {
        const upper = ticker.toUpperCase();
        const conflicts = this.getActiveTheses(userId).filter((t) => {
            if (t.ticker !== upper) return false;
            return t.stance === 'bullish'
                ? sentiment <= -CONFLICT_THRESHOLD
                : sentiment >= CONFLICT_THRESHOLD;
        });
        if (conflicts.length > 0) {
            conflicts.forEach((t) => { t.conflictCount++; });
            this.saveData();
        }
        return conflicts;
    }
}
