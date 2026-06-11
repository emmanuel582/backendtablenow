// Tests ciblés du service Google Calendar après neutralisation de la vuln
// googleapis (override uuid >=11.1.1 sur gaxios/googleapis-common ; googleapis
// reste en 128, API inchangée). On vérifie les chemins OAuth + create/update/delete
// avec des mocks cohérents de `googleapis`.
//
// ⚠️ Ceci NE remplace PAS un test runtime avec un vrai compte Google : le consentement
// OAuth réel, l'échange de code authentique et la création/suppression d'événements
// sur un agenda réel restent à valider en conditions réelles (voir rapport).

const mockGenerateAuthUrl = jest.fn();
const mockGetToken = jest.fn();
const mockSetCredentials = jest.fn();
const mockOn = jest.fn();
const mockEventsInsert = jest.fn();
const mockEventsPatch = jest.fn();
const mockEventsDelete = jest.fn();
const mockUserinfoGet = jest.fn();
const mockCalendar = jest.fn(() => ({
    events: { insert: mockEventsInsert, patch: mockEventsPatch, delete: mockEventsDelete },
}));
const mockOauth2 = jest.fn(() => ({ userinfo: { get: mockUserinfoGet } }));
const mockOAuth2Ctor = jest.fn().mockImplementation(() => ({
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
    setCredentials: mockSetCredentials,
    on: mockOn,
}));

jest.mock('googleapis', () => ({
    google: {
        auth: { OAuth2: mockOAuth2Ctor },
        calendar: mockCalendar,
        oauth2: mockOauth2,
    },
}));

import calendarService from '../../services/calendar.service';

beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?state=st-123');
    mockGetToken.mockResolvedValue({ tokens: { access_token: 'at', refresh_token: 'rt' } });
    mockEventsInsert.mockResolvedValue({ data: { id: 'evt-1', htmlLink: 'https://cal.google/evt-1' } });
    mockEventsPatch.mockResolvedValue({ data: { id: 'evt-1', htmlLink: 'https://cal.google/evt-1' } });
    mockEventsDelete.mockResolvedValue({});
    mockUserinfoGet.mockResolvedValue({ data: { email: 'owner@gmail.com' } });
});

const TOKENS = { access_token: 'at', refresh_token: 'rt' };
const EV = {
    summary: 'Réservation — Alice (4)',
    start: new Date('2026-05-03T17:30:00.000Z'),
    end: new Date('2026-05-03T19:30:00.000Z'),
    timeZone: 'Europe/Paris',
};

describe('CalendarService — OAuth', () => {
    it('getAuthUrl demande les scopes calendar + userinfo.email et propage le state', () => {
        const url = calendarService.getAuthUrl('st-123');
        expect(url).toContain('https://accounts.google.com');
        const arg = mockGenerateAuthUrl.mock.calls[0][0];
        expect(arg.state).toBe('st-123');
        expect(arg.scope).toEqual(expect.arrayContaining([
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
        ]));
    });

    it('getTokensFromCode échange le code et renvoie les tokens', async () => {
        const tokens = await calendarService.getTokensFromCode('auth-code-xyz');
        expect(mockGetToken).toHaveBeenCalledWith('auth-code-xyz');
        expect(tokens).toEqual({ access_token: 'at', refresh_token: 'rt' });
    });

    it('getAccountEmail lit le profil userinfo (v2)', async () => {
        const email = await calendarService.getAccountEmail(TOKENS);
        expect(mockOauth2).toHaveBeenCalledWith(expect.objectContaining({ version: 'v2' }));
        expect(mockUserinfoGet).toHaveBeenCalled();
        expect(email).toBe('owner@gmail.com');
    });

    it('getAccountEmail renvoie null si l’appel échoue (best-effort)', async () => {
        mockUserinfoGet.mockRejectedValueOnce(new Error('401'));
        expect(await calendarService.getAccountEmail(TOKENS)).toBeNull();
    });
});

describe('CalendarService — events CRUD', () => {
    it('createEvent insère l’événement (calendarId, RFC3339 + timeZone) et renvoie id/url', async () => {
        const res = await calendarService.createEvent(TOKENS, EV);
        expect(mockCalendar).toHaveBeenCalledWith(expect.objectContaining({ version: 'v3' }));
        const arg = mockEventsInsert.mock.calls[0][0];
        expect(arg.calendarId).toBe('primary');
        expect(arg.requestBody.summary).toBe(EV.summary);
        expect(arg.requestBody.start).toEqual({ dateTime: EV.start.toISOString(), timeZone: 'Europe/Paris' });
        expect(arg.requestBody.end).toEqual({ dateTime: EV.end.toISOString(), timeZone: 'Europe/Paris' });
        expect(res).toEqual({ id: 'evt-1', url: 'https://cal.google/evt-1' });
    });

    it('createEvent respecte un calendarId explicite', async () => {
        await calendarService.createEvent(TOKENS, EV, 'cal-XYZ');
        expect(mockEventsInsert.mock.calls[0][0].calendarId).toBe('cal-XYZ');
    });

    it('updateEvent patche l’événement ciblé et renvoie id', async () => {
        const res = await calendarService.updateEvent(TOKENS, 'evt-1', EV);
        const arg = mockEventsPatch.mock.calls[0][0];
        expect(arg.calendarId).toBe('primary');
        expect(arg.eventId).toBe('evt-1');
        expect(arg.requestBody.summary).toBe(EV.summary);
        expect(res.id).toBe('evt-1');
    });

    it('deleteEvent supprime l’événement ciblé', async () => {
        await calendarService.deleteEvent(TOKENS, 'evt-1');
        expect(mockEventsDelete).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'evt-1' });
    });
});
