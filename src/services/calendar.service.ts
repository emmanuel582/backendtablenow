import { google } from 'googleapis';

/**
 * Low-level Google Calendar client: OAuth helpers + event CRUD.
 *
 * Higher-level fan-out across all of a restaurant's connected calendars lives in
 * calendarSync.service.ts. The universal (any-calendar) subscribe feed lives in
 * ics.service.ts. This file is Google-specific and is wired in as one provider
 * adapter by the sync service.
 *
 * Event times are passed as correct UTC instants (Date). We send them as RFC3339
 * with the restaurant timeZone so Google displays the right wall-clock — there is
 * no naive UTC conversion here.
 */

export interface GoogleEventInput {
    summary: string;
    description?: string;
    start: Date;       // correct UTC instant
    end: Date;         // correct UTC instant
    timeZone: string;  // IANA zone for display, e.g. "Europe/Paris"
    attendees?: string[];
    location?: string;
}

export class CalendarService {
    private createClient(tokens?: any) {
        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI,
        );
        if (tokens) {
            client.setCredentials(tokens);
            // Capture silently-refreshed access tokens so the caller can persist them.
            client.on('tokens', (refreshed) => {
                Object.assign(tokens, refreshed);
            });
        }
        return client;
    }

    getAuthUrl(state: string): string {
        const client = this.createClient();
        return client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/userinfo.email',
            ],
            state,
        });
    }

    async getTokensFromCode(code: string): Promise<any> {
        const client = this.createClient();
        const { tokens } = await client.getToken(code);
        return tokens;
    }

    /** Best-effort account email for a set of tokens (used to label a connection). */
    async getAccountEmail(tokens: any): Promise<string | null> {
        try {
            const client = this.createClient(tokens);
            const oauth2 = google.oauth2({ version: 'v2', auth: client });
            const { data } = await oauth2.userinfo.get();
            return data.email || null;
        } catch {
            return null;
        }
    }

    async createEvent(tokens: any, ev: GoogleEventInput, calendarId = 'primary'): Promise<{ id: string; url?: string }> {
        const calendar = google.calendar({ version: 'v3', auth: this.createClient(tokens) });
        const { data } = await calendar.events.insert({
            calendarId,
            requestBody: {
                summary: ev.summary,
                description: ev.description,
                location: ev.location,
                start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
                end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
                attendees: ev.attendees?.map((email) => ({ email })),
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'email', minutes: 24 * 60 },
                        { method: 'popup', minutes: 60 },
                    ],
                },
            },
        });
        return { id: data.id!, url: data.htmlLink || undefined };
    }

    async updateEvent(tokens: any, eventId: string, ev: GoogleEventInput, calendarId = 'primary'): Promise<{ id: string; url?: string }> {
        const calendar = google.calendar({ version: 'v3', auth: this.createClient(tokens) });
        const { data } = await calendar.events.patch({
            calendarId,
            eventId,
            requestBody: {
                summary: ev.summary,
                description: ev.description,
                location: ev.location,
                start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
                end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
            },
        });
        return { id: data.id!, url: data.htmlLink || undefined };
    }

    async deleteEvent(tokens: any, eventId: string, calendarId = 'primary'): Promise<void> {
        const calendar = google.calendar({ version: 'v3', auth: this.createClient(tokens) });
        await calendar.events.delete({ calendarId, eventId });
    }
}

export default new CalendarService();
