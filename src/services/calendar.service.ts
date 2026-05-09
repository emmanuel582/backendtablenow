import crypto from 'crypto';
import { google } from 'googleapis';
import ical from 'ical-generator';

const TZ = 'Europe/Paris';

export class CalendarService {
    private createClient(tokens?: any) {
        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        if (tokens) client.setCredentials(tokens);
        return client;
    }

    /**
     * Generate a PKCE code_verifier + code_challenge (S256).
     * Both are generated server-side and the verifier is stored in a secure cookie
     * so the token exchange never touches the browser.
     */
    generatePKCE(): { codeVerifier: string; codeChallenge: string } {
        const codeVerifier  = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto
            .createHash('sha256')
            .update(codeVerifier)
            .digest('base64url');
        return { codeVerifier, codeChallenge };
    }

    /**
     * Build the Google OAuth authorization URL.
     * codeChallenge is the S256 hash of codeVerifier — never exposed to the browser.
     */
    getAuthUrl(state: string, codeChallenge: string): string {
        const client = this.createClient();
        return client.generateAuthUrl({
            access_type:           'offline',
            prompt:                'consent',
            scope:                 ['https://www.googleapis.com/auth/calendar'],
            state,
            code_challenge:        codeChallenge,
            code_challenge_method: 'S256',
        });
    }

    /**
     * Exchange the authorization code for tokens server-side.
     * codeVerifier must match what was used to derive the code_challenge.
     */
    async getTokensFromCode(code: string, codeVerifier: string): Promise<any> {
        const client = this.createClient();
        const { tokens } = await client.getToken({ code, codeVerifier });
        return tokens;
    }

    async createEvent(tokens: any, eventData: {
        summary: string;
        description?: string;
        start: Date;
        end: Date;
        attendees?: string[];
    }): Promise<any> {
        const client   = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const response = await calendar.events.insert({
            calendarId:  'primary',
            requestBody: {
                summary:     eventData.summary,
                description: eventData.description,
                start:       { dateTime: eventData.start.toISOString(), timeZone: TZ },
                end:         { dateTime: eventData.end.toISOString(),   timeZone: TZ },
                attendees:   eventData.attendees?.map(email => ({ email })),
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'email', minutes: 24 * 60 },
                        { method: 'popup', minutes: 60 },
                    ],
                },
            },
        });

        return response.data;
    }

    async updateEvent(tokens: any, eventId: string, eventData: {
        summary?: string;
        description?: string;
        start?: Date;
        end?: Date;
    }): Promise<any> {
        const client   = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const patch: any = {};
        if (eventData.summary)     patch.summary     = eventData.summary;
        if (eventData.description) patch.description = eventData.description;
        if (eventData.start)       patch.start = { dateTime: eventData.start.toISOString(), timeZone: TZ };
        if (eventData.end)         patch.end   = { dateTime: eventData.end.toISOString(),   timeZone: TZ };

        const response = await calendar.events.patch({
            calendarId: 'primary',
            eventId,
            requestBody: patch,
        });

        return response.data;
    }

    async deleteEvent(tokens: any, eventId: string): Promise<void> {
        const client   = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });
        await calendar.events.delete({ calendarId: 'primary', eventId });
    }

    async checkAvailability(tokens: any, startTime: Date, endTime: Date): Promise<boolean> {
        const client   = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: startTime.toISOString(),
                timeMax: endTime.toISOString(),
                items:   [{ id: 'primary' }],
            },
        });

        const busy = response.data.calendars?.primary?.busy || [];
        return busy.length === 0;
    }

    async findAvailableSlots(tokens: any, date: Date): Promise<string[]> {
        const client   = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const startOfDay = new Date(date);
        startOfDay.setHours(9, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(22, 0, 0, 0);

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                items:   [{ id: 'primary' }],
            },
        });

        const busySlots      = response.data.calendars?.primary?.busy || [];
        const availableSlots: string[] = [];
        let currentSlot      = new Date(startOfDay);

        while (currentSlot < endOfDay) {
            const endSlot = new Date(currentSlot.getTime() + 3600000);
            const isBusy  = busySlots.some((busy: any) => {
                const busyStart = new Date(busy.start!);
                const busyEnd   = new Date(busy.end!);
                return currentSlot < busyEnd && endSlot > busyStart;
            });
            if (!isBusy) {
                availableSlots.push(
                    currentSlot.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
                );
            }
            currentSlot = new Date(currentSlot.getTime() + 30 * 60000);
        }

        return availableSlots;
    }

    generateICalFile(eventData: {
        summary: string;
        description: string;
        start: Date;
        end: Date;
        location?: string;
    }): string {
        const calendar = ical({ name: 'TableNow Booking' });
        calendar.createEvent({
            start:       eventData.start,
            end:         eventData.end,
            summary:     eventData.summary,
            description: eventData.description,
            location:    eventData.location,
        });
        return calendar.toString();
    }
}

export default new CalendarService();
