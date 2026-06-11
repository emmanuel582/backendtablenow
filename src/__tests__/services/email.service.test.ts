// Tests ciblés du service email après la montée nodemailer 6 -> 8.
// On NE valide pas la montée par la seule compilation TS : on vérifie le
// comportement réel au niveau du service (appels sendMail, destinataires,
// propagation d'erreur SMTP, parsing BCC entrant, entrées invalides).
//
// nodemailer est mocké (pas de vrai SMTP) ; mailparser reste réel pour
// parseBCCEmail. NB : la génération de l'alias BCC sortant `bcc+r-{id}@domaine`
// vit dans provisioning.service.ts — ici on couvre le parsing BCC entrant.

const mockSendMail = jest.fn();
const mockVerify = jest.fn((cb?: (e: Error | null) => void) => { if (cb) cb(null); });

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({ verify: mockVerify, sendMail: mockSendMail })),
}));

// email.service.ts throw au chargement si l'env SMTP manque → on la définit AVANT le require.
process.env.SMTP_HOST = 'smtp.test.local';
process.env.SMTP_PORT = '465';
process.env.SMTP_USER = 'smtp-user';
process.env.SMTP_PASS = 'smtp-pass';
process.env.EMAIL_FROM = 'info@tablenow.io';
process.env.FRONTEND_URL = 'https://app.tablenow.io';

// Require APRÈS env + mock (les import ES seraient hoistés avant les lignes ci-dessus).
import type EmailServiceDefault from '../../services/email.service';
const emailService = require('../../services/email.service').default as typeof EmailServiceDefault;

beforeEach(() => {
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: '<test-message-id>' });
});

describe('EmailService — envoi SMTP (nodemailer 8)', () => {
    it('sendBookingConfirmation envoie au bon destinataire avec le bon expéditeur/sujet', async () => {
        await emailService.sendBookingConfirmation({
            to: 'guest@example.com',
            restaurantName: 'Le Bistrot',
            guestName: 'Alice',
            date: '2026-05-03',
            time: '19:30',
            partySize: 4,
            confirmationNumber: 'TN-2026-0042',
        });
        expect(mockSendMail).toHaveBeenCalledTimes(1);
        const arg = mockSendMail.mock.calls[0][0];
        expect(arg.to).toBe('guest@example.com');
        expect(arg.from).toContain('info@tablenow.io');
        expect(arg.subject).toContain('Le Bistrot');
        expect(arg.html).toContain('TN-2026-0042');
    });

    it('sendVerificationEmail cible le destinataire et inclut le lien de vérification', async () => {
        await emailService.sendVerificationEmail('newuser@example.com', 'tok-123', 'Le Bistrot');
        const arg = mockSendMail.mock.calls[0][0];
        expect(arg.to).toBe('newuser@example.com');
        expect(arg.subject).toMatch(/vérifiez/i);
        expect(arg.html).toContain('https://app.tablenow.io/verify-email?token=tok-123');
    });

    it('sendRawEmail préserve une liste de destinataires multiples', async () => {
        await emailService.sendRawEmail({
            to: ['a@example.com', 'b@example.com'],
            subject: 'Sujet',
            html: '<p>hello</p>',
        });
        expect(mockSendMail.mock.calls[0][0].to).toEqual(['a@example.com', 'b@example.com']);
    });

    it('propage une erreur SMTP (entrée/destinataire invalide rejeté par le transport)', async () => {
        mockSendMail.mockRejectedValueOnce(new Error('550 5.1.3 Bad recipient address syntax'));
        await expect(
            emailService.sendRawEmail({ to: 'not-an-email', subject: 'x', text: 'y' }),
        ).rejects.toThrow(/550/);
    });
});

describe('EmailService — parsing BCC entrant (PMS)', () => {
    const raw = (from: string, subject: string, body: string) =>
        `From: ${from}\r\nTo: bcc+r-123@tablenow.io\r\nSubject: ${subject}\r\n\r\n${body}\r\n`;

    it('détecte une annulation Zenchef et la source', async () => {
        const r = await emailService.parseBCCEmail(
            raw('Zenchef <noreply@zenchef.com>', 'Reservation cancelled',
                'Cancelled. Contact john@example.com 12/05/2026 20:00 for 4 guests'),
        );
        expect(r.type).toBe('cancellation');
        expect(r.source).toBe('zenchef');
        expect(r.email).toBe('john@example.com');
    });

    it('détecte une nouvelle réservation SevenRooms', async () => {
        const r = await emailService.parseBCCEmail(
            raw('SevenRooms <noreply@sevenrooms.com>', 'New reservation', 'Booking for 2 people 01/06/2026 19:00'),
        );
        expect(r.type).toBe('new');
        expect(r.source).toBe('sevenrooms');
    });

    it('entrée invalide / inconnue → source unknown, type new, sans throw', async () => {
        const r = await emailService.parseBCCEmail(raw('Random <x@random.io>', 'hello', 'garbage content'));
        expect(r.source).toBe('unknown');
        expect(r.type).toBe('new');
    });
});
