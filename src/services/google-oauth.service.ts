import { google } from 'googleapis';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { db } from '../db';
import { googleOauthTokens } from '../db/schema';
import { eq } from 'drizzle-orm';
import { config, oauthEnabled } from '../config';

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const STATE_TTL_MS = 15 * 60_000;
const RESEARCH_DOC_NAME = 'EdgeBook Research';

// Result of an append attempt — lets index.ts decide whether to fall back to the
// SA flow, prompt a reconnect, or just report a transient error.
export type AppendResult = 'ok' | 'not_connected' | 'revoked' | 'error';

export interface OAuthDoc {
    id: string;
    name: string;
}

export interface OAuthConnection {
    docId: string | null;          // active doc
    docs: OAuthDoc[];              // all docs the bot created for this user
    email: string | null;
}

/**
 * Per-user Google OAuth flow for appending research into a Doc owned by the user
 * (no service-account email sharing). Scope is drive.file only — the bot can touch
 * exactly the doc it created, nothing else. Refresh tokens are stored AES-256-GCM
 * encrypted. Entirely separate from GoogleService (which keeps using the SA for
 * calendar / photo uploads / manual Add Doc).
 */
export class GoogleOAuthService {
    // 32-byte key derived from the configured secret (any length input → sha256).
    private get key(): Buffer {
        return crypto.createHash('sha256').update(config.tokenEncKey).digest();
    }

    private get redirectUri(): string {
        return `${config.oauthPublicBaseUrl}/oauth/google/callback`;
    }

    isEnabled(): boolean {
        return oauthEnabled;
    }

    private newClient() {
        return new google.auth.OAuth2(
            config.googleOAuthClientId,
            config.googleOAuthClientSecret,
            this.redirectUri,
        );
    }

    // --- AES-256-GCM helpers (format: iv:authTag:ciphertext, all base64) ---

    private encrypt(plain: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [iv, tag, enc].map((b) => b.toString('base64')).join(':');
    }

    private decrypt(payload: string): string {
        const [ivB64, tagB64, dataB64] = payload.split(':');
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        const data = Buffer.from(dataB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }

    // --- Stateless CSRF state (HMAC-signed, carries userId + expiry) ---

    private signState(userId: number): string {
        const nonce = crypto.randomBytes(8).toString('hex');
        const payload = `${userId}.${nonce}.${Date.now() + STATE_TTL_MS}`;
        const sig = crypto.createHmac('sha256', config.tokenEncKey).update(payload).digest('base64url');
        return `${Buffer.from(payload).toString('base64url')}.${sig}`;
    }

    verifyState(state: string): number | null {
        try {
            const [payloadB64, sig] = state.split('.');
            if (!payloadB64 || !sig) return null;
            const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
            const expected = crypto.createHmac('sha256', config.tokenEncKey).update(payload).digest('base64url');
            // Constant-time compare; lengths must match or timingSafeEqual throws.
            if (sig.length !== expected.length ||
                !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
            const [userIdStr, , expStr] = payload.split('.');
            if (Date.now() > Number(expStr)) return null;
            const userId = Number(userIdStr);
            return Number.isFinite(userId) ? userId : null;
        } catch {
            return null;
        }
    }

    // --- Public flow ---

    getAuthUrl(userId: number): string {
        return this.newClient().generateAuthUrl({
            access_type: 'offline',     // request a refresh token
            prompt: 'consent',          // force consent so refresh_token is always returned
            scope: [DRIVE_FILE_SCOPE],
            state: this.signState(userId),
        });
    }

    // Exchange the code, (re)use or create the user's research doc, persist the
    // encrypted refresh token. Returns the connection info, or null on failure.
    async handleCallback(code: string, state: string): Promise<{ userId: number; docId: string | null; email: string | null } | null> {
        const userId = this.verifyState(state);
        if (userId === null) return null;

        const client = this.newClient();
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) {
            // No refresh token (user had already granted and prompt didn't re-consent).
            // Without it we can't append later — treat as failure so user retries.
            return null;
        }
        client.setCredentials(tokens);

        // Reuse existing docs on reconnect; otherwise create the default research doc.
        const [existing] = await db.select().from(googleOauthTokens).where(eq(googleOauthTokens.userId, userId));
        let docs = this.effectiveDocs(existing);
        let docId = existing?.docId ?? null;
        if (docs.length === 0) {
            const id = await this.createDocFile(client, RESEARCH_DOC_NAME);
            docs = [{ id, name: RESEARCH_DOC_NAME }];
            docId = id;
        }

        const email = await this.fetchEmail(client);
        const enc = this.encrypt(tokens.refresh_token);
        const now = new Date();

        await db.insert(googleOauthTokens)
            .values({ userId, refreshTokenEnc: enc, docId, docs, email, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
                target: googleOauthTokens.userId,
                set: { refreshTokenEnc: enc, docId, docs, email, updatedAt: now },
            });

        return { userId, docId, email };
    }

    // Effective doc list for a row — lazily synthesises a single-entry list from a
    // legacy `docId` (rows created before multi-doc) so old connections keep working.
    private effectiveDocs(row: typeof googleOauthTokens.$inferSelect | undefined): OAuthDoc[] {
        if (!row) return [];
        if (row.docs && row.docs.length > 0) return row.docs;
        if (row.docId) return [{ id: row.docId, name: RESEARCH_DOC_NAME }];
        return [];
    }

    private async createDocFile(client: any, name: string): Promise<string> {
        const drive = google.drive({ version: 'v3', auth: client });
        const res = await drive.files.create({
            requestBody: { name, mimeType: 'application/vnd.google-apps.document' },
            fields: 'id',
        });
        return res.data.id!;
    }

    // Build a user-authed OAuth2 client from the stored refresh token. Returns null
    // if the user isn't connected or the token can't be decrypted.
    private async userClient(userId: number): Promise<any | null> {
        const [row] = await db.select().from(googleOauthTokens).where(eq(googleOauthTokens.userId, userId));
        if (!row) return null;
        let refreshToken: string;
        try {
            refreshToken = this.decrypt(row.refreshTokenEnc);
        } catch {
            return null;
        }
        const client = this.newClient();
        client.setCredentials({ refresh_token: refreshToken });
        return client;
    }

    // Best-effort: the connected account's email (for display). drive.about.get is
    // available under drive.file scope. Null on failure — email is non-essential.
    private async fetchEmail(client: any): Promise<string | null> {
        try {
            const drive = google.drive({ version: 'v3', auth: client });
            const about = await drive.about.get({ fields: 'user(emailAddress)' });
            return about.data.user?.emailAddress ?? null;
        } catch {
            return null;
        }
    }

    async getConnection(userId: number): Promise<OAuthConnection | null> {
        if (!oauthEnabled) return null;
        const [row] = await db.select().from(googleOauthTokens).where(eq(googleOauthTokens.userId, userId));
        if (!row) return null;
        return { docId: row.docId, docs: this.effectiveDocs(row), email: row.email };
    }

    async disconnect(userId: number): Promise<boolean> {
        const res = await db.delete(googleOauthTokens).where(eq(googleOauthTokens.userId, userId)).returning();
        return res.length > 0;
    }

    // Create a new doc in the user's Drive, add it to the list, and make it active.
    // Returns the new doc, or null if the user isn't connected / creation failed.
    async createDoc(userId: number, name: string): Promise<OAuthDoc | null> {
        if (!oauthEnabled) return null;
        const client = await this.userClient(userId);
        if (!client) return null;
        const [row] = await db.select().from(googleOauthTokens).where(eq(googleOauthTokens.userId, userId));
        if (!row) return null;
        try {
            const id = await this.createDocFile(client, name);
            const docs = [...this.effectiveDocs(row), { id, name }];
            await db.update(googleOauthTokens)
                .set({ docs, docId: id, updatedAt: new Date() })
                .where(eq(googleOauthTokens.userId, userId));
            return { id, name };
        } catch (err) {
            console.error('OAuth createDoc error:', err);
            return null;
        }
    }

    // Switch the active doc by 1-based index or (case-insensitive) name. Returns the
    // newly-active doc, or null if not found / not connected.
    async setActiveDoc(userId: number, indexOrName: string): Promise<OAuthDoc | null> {
        const conn = await this.getConnection(userId);
        if (!conn || conn.docs.length === 0) return null;
        let target: OAuthDoc | undefined;
        const idx = Number(indexOrName);
        if (Number.isInteger(idx) && idx >= 1 && idx <= conn.docs.length) {
            target = conn.docs[idx - 1];
        } else {
            const q = indexOrName.trim().toLowerCase();
            target = conn.docs.find((d) => d.name.toLowerCase() === q);
        }
        if (!target) return null;
        await db.update(googleOauthTokens)
            .set({ docId: target.id, updatedAt: new Date() })
            .where(eq(googleOauthTokens.userId, userId));
        return target;
    }

    // Append text to the user's research doc. Returns a status so the caller can
    // fall back to the SA flow ('not_connected') or prompt a reconnect ('revoked').
    async appendForUser(userId: number, text: string): Promise<AppendResult> {
        const ctx = await this.userDocClient(userId);
        if (ctx === 'not_connected' || ctx === 'error') return ctx;
        const res = await this.runBatch(ctx.client, ctx.docId, [{
            insertText: { text: text + '\n', endOfSegmentLocation: { segmentId: '' } },
        }], 'append');
        if (res === 'revoked') await this.disconnect(userId);
        return res;
    }

    // Insert an inline image into the user's research doc, optionally followed by a
    // caption. First lets Google fetch imageUrl directly (cheap); if that fails
    // (Google's image importer frequently can't retrieve the Telegram CDN URL), it
    // downloads the bytes and re-hosts them in the user's Drive, inserts from there,
    // then deletes the temp file. Same fallback semantics as appendForUser.
    async insertImageForUser(userId: number, imageUrl: string, caption?: string): Promise<AppendResult> {
        const ctx = await this.userDocClient(userId);
        if (ctx === 'not_connected' || ctx === 'error') return ctx;
        const { client, docId } = ctx;
        const captionReq = {
            insertText: { text: caption ? `\n${caption}\n` : '\n', endOfSegmentLocation: { segmentId: '' } },
        };

        // Fast path: let Google fetch the original URL.
        let res = await this.runBatch(client, docId, [imageRequest(imageUrl), captionReq], 'image');
        if (res === 'ok') return 'ok';
        if (res === 'revoked') { await this.disconnect(userId); return 'revoked'; }

        // Fallback: re-host the bytes in the user's Drive and insert from there.
        const fileId = await this.uploadTempImage(client, imageUrl);
        if (!fileId) return 'error';
        const hosted = `https://drive.google.com/uc?export=download&id=${fileId}`;
        res = await this.runBatch(client, docId, [imageRequest(hosted), captionReq], 'image-hosted');
        // Inline image bytes are copied into the doc on success — temp file is disposable.
        this.deleteDriveFile(client, fileId).catch(() => {});
        if (res === 'revoked') { await this.disconnect(userId); return 'revoked'; }
        return res;
    }

    // Resolve the user's active OAuth doc + an authed client, or a failure status.
    private async userDocClient(userId: number): Promise<{ client: any; docId: string } | 'not_connected' | 'error'> {
        if (!oauthEnabled) return 'not_connected';
        const [row] = await db.select().from(googleOauthTokens).where(eq(googleOauthTokens.userId, userId));
        if (!row || !row.docId) return 'not_connected';
        let refreshToken: string;
        try {
            refreshToken = this.decrypt(row.refreshTokenEnc);
        } catch {
            return 'error';
        }
        const client = this.newClient();
        client.setCredentials({ refresh_token: refreshToken });
        return { client, docId: row.docId };
    }

    // Run a Docs batchUpdate with an already-authed client. Surfaces Google's detailed
    // error reason in logs. Returns 'revoked' on auth loss (caller disconnects).
    private async runBatch(client: any, docId: string, requests: any[], op: string): Promise<AppendResult> {
        const docs = google.docs({ version: 'v1', auth: client });
        try {
            await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
            return 'ok';
        } catch (err: any) {
            const detail = err?.response?.data?.error?.message || err?.message || String(err);
            const blob = String(detail) + String(err?.response?.data?.error || '');
            if (blob.includes('invalid_grant') || err?.code === 401) return 'revoked';
            console.error(`OAuth ${op} error:`, detail);
            return 'error';
        }
    }

    // Download imageUrl and store it in the user's Drive as a public-readable temp
    // file (so Google's importer can fetch it). Returns the Drive file id, or null.
    private async uploadTempImage(client: any, imageUrl: string): Promise<string | null> {
        try {
            const resp = await fetch(imageUrl);
            if (!resp.ok) {
                console.error('uploadTempImage: download failed', resp.status);
                return null;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            const drive = google.drive({ version: 'v3', auth: client });
            const body = new Readable();
            body.push(buf);
            body.push(null);
            const created = await drive.files.create({
                requestBody: { name: `edgebook-img-${Date.now()}.jpg` },
                media: { mimeType: 'image/jpeg', body },
                fields: 'id',
            });
            const id = created.data.id;
            if (!id) return null;
            await drive.permissions.create({ fileId: id, requestBody: { type: 'anyone', role: 'reader' } });
            return id;
        } catch (err: any) {
            console.error('uploadTempImage error:', err?.message || err);
            return null;
        }
    }

    private async deleteDriveFile(client: any, fileId: string): Promise<void> {
        const drive = google.drive({ version: 'v3', auth: client });
        await drive.files.delete({ fileId });
    }
}

// Shared Docs request that appends an inline image at the end of the body.
function imageRequest(uri: string) {
    return {
        insertInlineImage: {
            uri,
            endOfSegmentLocation: { segmentId: '' },
            objectSize: {
                height: { magnitude: 300, unit: 'PT' },
                width: { magnitude: 400, unit: 'PT' },
            },
        },
    };
}
