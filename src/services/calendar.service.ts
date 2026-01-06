import { google } from 'googleapis';
import ical from 'ical-generator';

export class CalendarService {
    private oauth2Client: any;

    constructor() {
        this.oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
    }

    /**
     * Get authorization URL for Google Calendar
     */
    getAuthUrl(): string {
        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/calendar']
        });
    }

    /**
     * Exchange authorization code for tokens
     */
    async getTokensFromCode(code: string): Promise<any> {
        try {
            const { tokens } = await this.oauth2Client.getToken(code);
            return tokens;
        } catch (error: any) {
            console.error('Error getting tokens:', error.message);
            throw error;
        }
    }

    /**
     * Create calendar event
     */
    async createEvent(tokens: any, eventData: {
        summary: string;
        description?: string;
        start: Date;
        end: Date;
        attendees?: string[];
    }): Promise<any> {
        try {
            this.oauth2Client.setCredentials(tokens);
            const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

            const event = {
                summary: eventData.summary,
                description: eventData.description,
                start: {
                    dateTime: eventData.start.toISOString(),
                    timeZone: 'UTC'
                },
                end: {
                    dateTime: eventData.end.toISOString(),
                    timeZone: 'UTC'
                },
                attendees: eventData.attendees?.map(email => ({ email })),
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'email', minutes: 24 * 60 },
                        { method: 'popup', minutes: 60 }
                    ]
                }
            };

            const response = await calendar.events.insert({
                calendarId: 'primary',
                requestBody: event
            });

            return response.data;
        } catch (error: any) {
            console.error('Error creating calendar event:', error.message);
            throw error;
        }
    }

    /**
     * Update calendar event
     */
    async updateEvent(tokens: any, eventId: string, eventData: {
        summary?: string;
        description?: string;
        start?: Date;
        end?: Date;
    }): Promise<any> {
        try {
            this.oauth2Client.setCredentials(tokens);
            const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

            const event: any = {};
            if (eventData.summary) event.summary = eventData.summary;
            if (eventData.description) event.description = eventData.description;
            if (eventData.start) {
                event.start = {
                    dateTime: eventData.start.toISOString(),
                    timeZone: 'UTC'
                };
            }
            if (eventData.end) {
                event.end = {
                    dateTime: eventData.end.toISOString(),
                    timeZone: 'UTC'
                };
            }

            const response = await calendar.events.patch({
                calendarId: 'primary',
                eventId,
                requestBody: event
            });

            return response.data;
        } catch (error: any) {
            console.error('Error updating calendar event:', error.message);
            throw error;
        }
    }

    /**
     * Delete calendar event
     */
    async deleteEvent(tokens: any, eventId: string): Promise<void> {
        try {
            this.oauth2Client.setCredentials(tokens);
            const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

            await calendar.events.delete({
                calendarId: 'primary',
                eventId
            });
        } catch (error: any) {
            console.error('Error deleting calendar event:', error.message);
            throw error;
        }
    }

    /**
     * Check availability in calendar
     */
    async checkAvailability(tokens: any, startTime: Date, endTime: Date): Promise<boolean> {
        try {
            this.oauth2Client.setCredentials(tokens);
            const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

            const response = await calendar.freebusy.query({
                requestBody: {
                    timeMin: startTime.toISOString(),
                    timeMax: endTime.toISOString(),
                    items: [{ id: 'primary' }]
                }
            });

            const busy = response.data.calendars?.primary?.busy || [];
            return busy.length === 0;
        } catch (error: any) {
            console.error('Error checking availability:', error.message);
            throw error;
        }
    }

    /**
     * Find available slots for a given day
     */
    async findAvailableSlots(tokens: any, date: Date): Promise<string[]> {
        try {
            this.oauth2Client.setCredentials(tokens);
            const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

            // Set time range for the whole day (e.g., 9 AM to 10 PM)
            const startOfDay = new Date(date);
            startOfDay.setHours(9, 0, 0, 0);

            const endOfDay = new Date(date);
            endOfDay.setHours(22, 0, 0, 0);

            const response = await calendar.freebusy.query({
                requestBody: {
                    timeMin: startOfDay.toISOString(),
                    timeMax: endOfDay.toISOString(),
                    items: [{ id: 'primary' }]
                }
            });

            const busySlots = response.data.calendars?.primary?.busy || [];

            // Generate all potential slots (every 30 mins)
            const availableSlots: string[] = [];
            let currentSlot = new Date(startOfDay);

            while (currentSlot < endOfDay) {
                const endSlot = new Date(currentSlot.getTime() + 60 * 60 * 1000); // 1 hour slots

                // Check if this slot overlaps with any busy slot
                const isBusy = busySlots.some((busy: any) => {
                    const busyStart = new Date(busy.start!);
                    const busyEnd = new Date(busy.end!);
                    return (currentSlot < busyEnd && endSlot > busyStart);
                });

                if (!isBusy) {
                    availableSlots.push(currentSlot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
                }

                currentSlot = new Date(currentSlot.getTime() + 30 * 60 * 1000); // Increment by 30 mins
            }

            return availableSlots;
        } catch (error: any) {
            console.error('Error finding available slots:', error.message);
            return [];
        }
    }

    /**
     * Generate iCal file for booking
     */
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
            location: eventData.location
        });

        return calendar.toString();
    }
}

export default new CalendarService();
