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

    getAuthUrl(state: string): string {
        const client = this.createClient();
        return client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: ['https://www.googleapis.com/auth/calendar'],
            state,
        });
    }

    async getTokensFromCode(code: string): Promise<any> {
        const client = this.createClient();
        const { tokens } = await client.getToken(code);
        return tokens;
    }

    async createEvent(tokens: any, eventData: {
        summary: string;
        description?: string;
        start: Date | string;
        end: Date | string;
        attendees?: string[];
    }): Promise<any> {
        const client = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        // Si on reçoit une chaîne, c'est une heure LOCALE naïve (ex "2026-06-05T20:00:00")
        // → on la passe telle quelle avec timeZone : Google la place dans le bon fuseau
        // (DST-safe). Convertir en UTC (toISOString) décalerait l'event de l'offset Paris.
        const fmt = (v: Date | string) => (typeof v === 'string' ? v : v.toISOString());

        const response = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: eventData.summary,
                description: eventData.description,
                start: { dateTime: fmt(eventData.start), timeZone: TZ },
                end:   { dateTime: fmt(eventData.end),   timeZone: TZ },
                attendees: eventData.attendees?.map(email => ({ email })),
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
        const client = this.createClient(tokens);
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
        const client = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });
        await calendar.events.delete({ calendarId: 'primary', eventId });
    }

    async checkAvailability(tokens: any, startTime: Date, endTime: Date): Promise<boolean> {
        const client = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: startTime.toISOString(),
                timeMax: endTime.toISOString(),
                items: [{ id: 'primary' }],
            },
        });

        const busy = response.data.calendars?.primary?.busy || [];
        return busy.length === 0;
    }

    async findAvailableSlots(tokens: any, date: Date): Promise<string[]> {
        const client = this.createClient(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const startOfDay = new Date(date);
        startOfDay.setHours(9, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(22, 0, 0, 0);

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                items: [{ id: 'primary' }],
            },
        });

        const busySlots = response.data.calendars?.primary?.busy || [];
        const availableSlots: string[] = [];
        let currentSlot = new Date(startOfDay);

        while (currentSlot < endOfDay) {
            const endSlot = new Date(currentSlot.getTime() + 3600000);
            const isBusy = busySlots.some((busy: any) => {
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
            start: eventData.start,
            end: eventData.end,
            summary: eventData.summary,
            description: eventData.description,
            location: eventData.location,
        });
        return calendar.toString();
    }
}

export default new CalendarService();
