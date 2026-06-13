import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface UserProfile {
    id: number;
    username?: string;
    fullName?: string;
    jobTitle?: string;
    notes?: string[];

    // Multi-Docs Support
    activeDocId?: string;
    docAliases?: Record<string, string>;

    // Growth / attribution
    acquisitionSource?: string;
    createdAt?: string;
}

type UserRow = typeof users.$inferSelect;

function toProfile(row: UserRow): UserProfile {
    return {
        id: row.id,
        username: row.username ?? undefined,
        fullName: row.fullName ?? undefined,
        jobTitle: row.jobTitle ?? undefined,
        notes: row.notes ?? [],
        activeDocId: row.activeDocId ?? undefined,
        docAliases: (row.docAliases as Record<string, string>) ?? {},
        acquisitionSource: row.acquisitionSource ?? undefined,
        createdAt: row.createdAt?.toISOString() ?? undefined,
    };
}

export class UserService {
    // acquisitionSource/createdAt are only recorded on first insert (first-touch attribution);
    // onConflictDoNothing means they're ignored for existing users.
    async getUser(id: number, acquisitionSource?: string): Promise<UserProfile> {
        await db.insert(users).values({
            id,
            notes: [],
            docAliases: {},
            acquisitionSource: acquisitionSource ?? null,
            createdAt: new Date(),
        }).onConflictDoNothing();
        const [row] = await db.select().from(users).where(eq(users.id, id));
        return toProfile(row!);
    }

    // Like getUser, but also reports whether this call inserted the row
    // (brand-new user) — used by /start to scope referral recording to a
    // user's very first /start.
    async createIfNew(id: number, acquisitionSource?: string): Promise<{ user: UserProfile; isNew: boolean }> {
        const inserted = await db.insert(users).values({
            id,
            notes: [],
            docAliases: {},
            acquisitionSource: acquisitionSource ?? null,
            createdAt: new Date(),
        }).onConflictDoNothing().returning();

        if (inserted.length > 0) return { user: toProfile(inserted[0]), isNew: true };

        const [row] = await db.select().from(users).where(eq(users.id, id));
        return { user: toProfile(row!), isNew: false };
    }

    async updateUser(id: number, updates: Partial<UserProfile>): Promise<UserProfile> {
        await this.getUser(id); // ensure exists
        const set: Partial<typeof users.$inferInsert> = {};
        if (updates.username !== undefined) set.username = updates.username;
        if (updates.fullName !== undefined) set.fullName = updates.fullName;
        if (updates.jobTitle !== undefined) set.jobTitle = updates.jobTitle;
        if (updates.notes !== undefined) set.notes = updates.notes;
        if (updates.activeDocId !== undefined) set.activeDocId = updates.activeDocId;
        if (updates.docAliases !== undefined) set.docAliases = updates.docAliases;
        const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
        return toProfile(row!);
    }

    async addNote(id: number, note: string): Promise<UserProfile> {
        const user = await this.getUser(id);
        const notes = [...(user.notes ?? []), note];
        const [row] = await db.update(users).set({ notes }).where(eq(users.id, id)).returning();
        return toProfile(row!);
    }

    // --- Docs Management ---

    async setDocAlias(id: number, alias: string, docId: string): Promise<UserProfile> {
        const user = await this.getUser(id);
        const docAliases = { ...(user.docAliases ?? {}), [alias.toLowerCase()]: docId };
        const activeDocId = user.activeDocId ?? docId; // auto-set first doc as active
        const [row] = await db.update(users)
            .set({ docAliases, activeDocId })
            .where(eq(users.id, id))
            .returning();
        return toProfile(row!);
    }

    async setActiveDoc(id: number, aliasOrId: string): Promise<boolean> {
        const user = await this.getUser(id);
        const alias = aliasOrId.toLowerCase();

        let newDocId: string | undefined;
        if (user.docAliases && user.docAliases[alias]) {
            newDocId = user.docAliases[alias];
        } else if (aliasOrId.length > 20) {
            newDocId = aliasOrId;
        }

        if (newDocId) {
            await db.update(users).set({ activeDocId: newDocId }).where(eq(users.id, id));
            return true;
        }
        return false;
    }

    async getActiveDocId(id: number): Promise<string | undefined> {
        const user = await this.getUser(id);
        return user.activeDocId;
    }

    // Reverse-lookup: the alias the active doc was saved under (if any).
    async getActiveDocAlias(id: number): Promise<string | undefined> {
        const user = await this.getUser(id);
        if (!user.activeDocId || !user.docAliases) return undefined;
        return Object.keys(user.docAliases)
            .find((a) => user.docAliases![a] === user.activeDocId);
    }
}
