import * as fs from 'fs';
import * as path from 'path';

export interface UserProfile {
    id: number;
    username?: string;
    fullName?: string; // Tên hiển thị do người dùng đặt
    jobTitle?: string;
    notes?: string[];  // Những ghi nhớ đặc biệt

    // Multi-Docs Support
    activeDocId?: string;
    docAliases?: Record<string, string>; // e.g. "work" -> "1abc...", "notes" -> "1xyz..."
}

export class UserService {
    private dataPath: string;
    private users: Map<number, UserProfile>;

    constructor() {
        this.dataPath = path.resolve(__dirname, '../../data/users.json');
        this.users = new Map();
        this.loadData();
    }

    private loadData() {
        if (fs.existsSync(this.dataPath)) {
            try {
                const rawData = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(rawData);
                if (Array.isArray(parsed)) {
                    parsed.forEach((u: UserProfile) => this.users.set(u.id, u));
                }
            } catch (error) {
                console.error('Error loading user data:', error);
            }
        }
    }

    private saveData() {
        try {
            const data = Array.from(this.users.values());
            fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Error saving user data:', error);
        }
    }

    getUser(id: number): UserProfile {
        if (!this.users.has(id)) {
            // Create default profile if not exists
            const newProfile: UserProfile = { id, notes: [], docAliases: {} };
            this.users.set(id, newProfile);
            this.saveData();
        }
        return this.users.get(id)!;
    }

    updateUser(id: number, updates: Partial<UserProfile>) {
        const user = this.getUser(id);
        const updated = { ...user, ...updates };
        this.users.set(id, updated);
        this.saveData();
        return updated;
    }

    addNote(id: number, note: string) {
        const user = this.getUser(id);
        if (!user.notes) user.notes = [];
        user.notes.push(note);
        this.saveData();
        return user;
    }

    // --- Docs Management ---

    setDocAlias(id: number, alias: string, docId: string) {
        const user = this.getUser(id);
        if (!user.docAliases) user.docAliases = {};
        user.docAliases[alias.toLowerCase()] = docId;

        // Auto-set as active if it's the first one
        if (!user.activeDocId) {
            user.activeDocId = docId;
        }

        this.saveData();
        return user;
    }

    setActiveDoc(id: number, aliasOrId: string): boolean {
        const user = this.getUser(id);
        const alias = aliasOrId.toLowerCase();

        // Check if it's a known alias
        if (user.docAliases && user.docAliases[alias]) {
            user.activeDocId = user.docAliases[alias];
            this.saveData();
            return true;
        }

        // Assume it is a raw ID if it looks like one (simple check)
        if (aliasOrId.length > 20) {
            user.activeDocId = aliasOrId;
            this.saveData();
            return true;
        }

        return false;
    }

    getActiveDocId(id: number): string | undefined {
        const user = this.getUser(id);
        return user.activeDocId;
    }

    // Reverse-lookup: the alias the active doc was saved under (if any).
    getActiveDocAlias(id: number): string | undefined {
        const user = this.getUser(id);
        if (!user.activeDocId || !user.docAliases) return undefined;
        return Object.keys(user.docAliases)
            .find((alias) => user.docAliases![alias] === user.activeDocId);
    }
}
