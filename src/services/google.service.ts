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
        try {
            const requests: any[] = [
                {
                    insertInlineImage: {
                        uri: imageUrl,
                        endOfSegmentLocation: { segmentId: '' }, // Append to end of body
                        objectSize: {
                            height: { magnitude: 300, unit: 'PT' }, // Resize to reasonable height
                            width: { magnitude: 400, unit: 'PT' }
                        }
                    }
                }
            ];

            if (caption) {
                requests.push({
                    insertText: {
                        text: `\n${caption}\n`,
                        endOfSegmentLocation: { segmentId: '' },
                    }
                });
            } else {
                requests.push({
                    insertText: {
                        text: '\n',
                        endOfSegmentLocation: { segmentId: '' },
                    }
                });
            }

            await this.docs.documents.batchUpdate({
                documentId: docId,
                requestBody: { requests },
            });
            return true;
        } catch (error: any) {
            console.error('Docs Image Insert Error:', error);
            if (error.response) {
                console.error('Docs Error Details:', JSON.stringify(error.response.data, null, 2));
            }
            throw new GoogleApiError('Failed to insert image to Google Doc', error?.code);
        }
    }
}
