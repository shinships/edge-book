import { google } from 'googleapis';
import { config } from '../config';
import { Readable } from 'stream';
import * as fs from 'fs';

/** Error thrown by Docs/Drive calls that carries the HTTP status so callers can craft actionable replies. */
export class GoogleApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'GoogleApiError';
        this.status = status;
    }
}

export class GoogleService {
    private auth;
    private calendar;
    private drive;
    private docs;
    private saEmail: string | null = null;

    constructor() {
        this.auth = new google.auth.GoogleAuth({
            keyFile: config.googleCredentials,
            scopes: [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/drive',
                'https://www.googleapis.com/auth/documents'
            ],
        });

        this.calendar = google.calendar({ version: 'v3', auth: this.auth });
        this.drive = google.drive({ version: 'v3', auth: this.auth });
        this.docs = google.docs({ version: 'v1', auth: this.auth });
    }

    /** The service-account email users must share their Google Docs with (cached). Empty string if unavailable. */
    getServiceAccountEmail(): string {
        if (this.saEmail !== null) return this.saEmail;
        try {
            const raw = fs.readFileSync(config.googleCredentials, 'utf-8');
            this.saEmail = JSON.parse(raw).client_email || '';
        } catch {
            this.saEmail = '';
        }
        return this.saEmail || '';
    }

    /** Best-effort: the email of the account that OWNS a doc (the one whose Drive storage inline images consume). Null on failure. */
    async getDocOwnerEmail(docId: string): Promise<string | null> {
        try {
            const f = await this.drive.files.get({ fileId: docId, fields: 'owners(emailAddress)' });
            return f.data.owners?.[0]?.emailAddress || null;
        } catch {
            return null;
        }
    }

    async createCalendarEvent(eventData: { title: string; startTime: string; endTime?: string; description?: string }) {
        try {
            const startStr = eventData.startTime;
            // Default end time to 1 hour later if not provided
            let endStr = eventData.endTime;
            if (!endStr) {
                const startDate = new Date(startStr);
                startDate.setHours(startDate.getHours() + 1);
                endStr = startDate.toISOString();
            }

            const event = {
                summary: eventData.title,
                description: eventData.description,
                start: {
                    dateTime: startStr,
                    timeZone: 'Asia/Ho_Chi_Minh', // Default timezone, can be parameterized
                },
                end: {
                    dateTime: endStr,
                    timeZone: 'Asia/Ho_Chi_Minh',
                },
            };

            const response = await this.calendar.events.insert({
                calendarId: 'primary',
                requestBody: event,
            });

            return response.data.htmlLink;
        } catch (error) {
            console.error('Google Calendar Error:', error);
            throw new Error('Failed to create calendar event');
        }
    }

    async uploadFileToDrive(fileName: string, mimeType: string, content: any) {
        // Content should be a stream or buffer
        try {
            const fileMetadata: any = {
                name: fileName,
            };

            if (config.googleDriveFolderId) {
                fileMetadata.parents = [config.googleDriveFolderId];
            }

            // Convert buffer to stream if needed (googleapis prefers streams)
            let body = content;
            if (Buffer.isBuffer(content)) {
                body = new Readable();
                (body as Readable).push(content);
                (body as Readable).push(null);
            }

            const media = {
                mimeType: mimeType,
                body: body,
            };
            const response = await this.drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id, webViewLink, webContentLink',
            });
            // We need webContentLink for direct embedding, webViewLink for human viewing
            return response.data;
        } catch (error) {
            console.error('Drive Upload Error:', error);
            throw new Error('Failed to upload file to Drive');
        }
    }

    async appendToDocs(docId: string, text: string) {
        try {
            const requests = [
                {
                    insertText: {
                        text: text + '\n',
                        endOfSegmentLocation: { segmentId: '' }, // Append to body
                    },
                },
            ];

            await this.docs.documents.batchUpdate({
                documentId: docId,
                requestBody: { requests },
            });
            return true;
        } catch (error: any) {
            console.error('Docs Append Error:', error);
            throw new GoogleApiError('Failed to append to Google Doc', error?.code);
        }
    }

    async insertImageToDocs(docId: string, imageUrl: string, caption?: string) {
        const captionReq = {
            insertText: { text: caption ? `\n${caption}\n` : '\n', endOfSegmentLocation: { segmentId: '' } },
        };

        // Fast path: let Google fetch the original URL.
        try {
            await this.docs.documents.batchUpdate({
                documentId: docId,
                requestBody: { requests: [inlineImageRequest(imageUrl), captionReq] },
            });
            return true;
        } catch (error: any) {
            const detail = error?.response?.data?.error?.message || error?.message || String(error);
            console.warn('Docs Image Insert (direct) failed, retrying via Drive re-host:', detail);
        }

        // Fallback: Google's importer often can't retrieve the Telegram CDN URL.
        // Download the bytes, host them in Drive (public-readable), insert, then clean up.
        let fileId: string | null = null;
        try {
            fileId = await this.uploadTempImage(imageUrl);
            if (!fileId) throw new Error('temp upload failed');
            const hosted = `https://drive.google.com/uc?export=download&id=${fileId}`;
            await this.docs.documents.batchUpdate({
                documentId: docId,
                requestBody: { requests: [inlineImageRequest(hosted), captionReq] },
            });
            return true;
        } catch (error: any) {
            const detail = error?.response?.data?.error?.message || error?.message || String(error);
            console.error('Docs Image Insert Error:', detail);
            throw new GoogleApiError('Failed to insert image to Google Doc', error?.code);
        } finally {
            // Inline image bytes are copied into the doc on success — temp file is disposable.
            if (fileId) {
                this.drive.files.delete({ fileId }).catch(() => {});
            }
        }
    }

    // Download imageUrl and store it in Drive as a public-readable temp file so the
    // Docs importer can fetch it. Returns the Drive file id, or null on failure.
    private async uploadTempImage(imageUrl: string): Promise<string | null> {
        try {
            const resp = await fetch(imageUrl);
            if (!resp.ok) {
                console.error('uploadTempImage: download failed', resp.status);
                return null;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            const body = new Readable();
            body.push(buf);
            body.push(null);
            const requestBody: any = { name: `edgebook-img-${Date.now()}.jpg` };
            if (config.googleDriveFolderId) requestBody.parents = [config.googleDriveFolderId];
            const created = await this.drive.files.create({
                requestBody,
                media: { mimeType: 'image/jpeg', body },
                fields: 'id',
            });
            const id = created.data.id;
            if (!id) return null;
            await this.drive.permissions.create({ fileId: id, requestBody: { type: 'anyone', role: 'reader' } });
            return id;
        } catch (err: any) {
            console.error('uploadTempImage error:', err?.message || err);
            return null;
        }
    }
}

// Shared Docs request that appends an inline image at the end of the body.
function inlineImageRequest(uri: string) {
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
