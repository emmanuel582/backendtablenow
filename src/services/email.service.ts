import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { config } from '../lib/config';
import { getTemplates, SupportedLanguage } from '../templates/email';

/**
 * Service d'envoi d'emails (transactionnels + parsing entrant).
 *
 * Toute la configuration SMTP et l'adresse expéditrice sont lues depuis
 * src/lib/config.ts (validé au boot). Les contenus FR/EN vivent dans
 * src/templates/email/{fr,en}/. Chaque méthode publique accepte un paramètre
 * `language` ('fr' par défaut) — l'appelant est responsable de fournir la
 * langue capturée côté DB (restaurants.language ou bookings.guest_language).
 */
export class EmailService {
    private readonly fromAddress = `TableNow <${config.email.from}>`;
    private readonly fromAlertAddress = `TableNow Alert <${config.email.from}>`;
    private readonly transporter: nodemailer.Transporter;

    constructor() {
        // Connexion SMTP — secure=true uniquement sur le port 465 (TLS implicite).
        // Sur 587, on laisse nodemailer faire un STARTTLS opportuniste.
        this.transporter = nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.port === 465,
            auth: {
                user: config.smtp.user,
                pass: config.smtp.pass,
            },
            tls: {
                rejectUnauthorized: false,
            },
        });

        // Vérification non bloquante.
        this.transporter.verify((error) => {
            if (error) {
                console.error('❌ SMTP connection error:', error);
            } else {
                console.log('✅ SMTP transporter initialized');
            }
        });
    }

    /**
     * Email de vérification d'inscription envoyé au restaurateur.
     * @param language Langue choisie par le restaurateur à l'inscription.
     */
    async sendVerificationEmail(
        to: string,
        verificationToken: string,
        restaurantName: string,
        language: SupportedLanguage = 'fr',
    ): Promise<void> {
        const t = getTemplates(language).verification;
        const data = {
            verificationUrl: `${config.frontendUrl}/verify-email?token=${verificationToken}`,
            restaurantName,
        };

        try {
            await this.transporter.sendMail({
                from:    this.fromAddress,
                to,
                subject: t.subject(data),
                html:    t.html(data),
            });
            console.log(`Verification email sent to ${to} via SMTP (lang=${language})`);
        } catch (error: any) {
            console.error('Error sending verification email:', error.message);
            throw error;
        }
    }

    /**
     * Confirmation de réservation envoyée au client final.
     * @param language Langue capturée au moment de la réservation
     *                 (bookings.guest_language).
     */
    async sendBookingConfirmation(data: {
        to: string;
        restaurantName: string;
        guestName: string;
        date: string;
        time: string;
        partySize: number;
        confirmationNumber: string;
        language?: SupportedLanguage;
    }): Promise<void> {
        const language = data.language ?? 'fr';
        const t = getTemplates(language).bookingConfirmation;
        const tplData = {
            restaurantName:     data.restaurantName,
            guestName:          data.guestName,
            date:               data.date,
            time:               data.time,
            partySize:          data.partySize,
            confirmationNumber: data.confirmationNumber,
        };

        try {
            await this.transporter.sendMail({
                from:    this.fromAddress,
                to:      data.to,
                subject: t.subject(tplData),
                html:    t.html(tplData),
            });
            console.log(`Booking confirmation sent to ${data.to} via SMTP (lang=${language})`);
        } catch (error: any) {
            console.error('Error sending booking confirmation:', error.message);
            throw error;
        }
    }

    /**
     * Notification interne envoyée à l'équipe restaurant (alertes diverses).
     * @param language Langue du restaurant (restaurants.language).
     */
    async sendRestaurantNotification(data: {
        to: string;
        subject: string;
        message: string;
        bookingDetails?: any;
        language?: SupportedLanguage;
    }): Promise<void> {
        const language = data.language ?? 'fr';
        const t = getTemplates(language).restaurantNotification;
        const tplData = {
            subject:        data.subject,
            message:        data.message,
            bookingDetails: data.bookingDetails,
        };

        try {
            await this.transporter.sendMail({
                from:    this.fromAlertAddress,
                to:      data.to,
                subject: t.subject(tplData),
                html:    t.html(tplData),
            });
            console.log(`Restaurant notification sent to ${data.to} via SMTP (lang=${language})`);
        } catch (error: any) {
            console.error('Error sending restaurant notification:', error.message);
            throw error;
        }
    }

    /**
     * Parse un email entrant (BCC reçu depuis Zenchef ou SevenRooms) et
     * extrait les détails de la réservation par regex sur le corps texte.
     */
    async parseBCCEmail(rawEmail: string): Promise<{
        type: 'new' | 'modification' | 'cancellation';
        guestName?: string;
        email?: string;
        phone?: string;
        date?: string;
        time?: string;
        partySize?: number;
        confirmationNumber?: string;
        source: 'zenchef' | 'sevenrooms' | 'unknown';
    }> {
        try {
            const parsed = await simpleParser(rawEmail);

            const subject = parsed.subject || '';
            const text = parsed.text || '';

            let type: 'new' | 'modification' | 'cancellation' = 'new';
            if (subject.toLowerCase().includes('cancel') || text.toLowerCase().includes('cancelled')) {
                type = 'cancellation';
            } else if (subject.toLowerCase().includes('modif') || subject.toLowerCase().includes('update')) {
                type = 'modification';
            }

            let source: 'zenchef' | 'sevenrooms' | 'unknown' = 'unknown';
            if (parsed.from?.text.toLowerCase().includes('zenchef')) {
                source = 'zenchef';
            } else if (parsed.from?.text.toLowerCase().includes('sevenrooms')) {
                source = 'sevenrooms';
            }

            const emailRegex     = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/;
            const phoneRegex     = /(\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9})/;
            const dateRegex      = /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/;
            const timeRegex      = /(\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)?)/;
            const partySizeRegex = /(\d+)\s*(?:guest|person|people|pax)/i;

            return {
                type,
                source,
                email:     text.match(emailRegex)?.[1],
                phone:     text.match(phoneRegex)?.[1],
                date:      text.match(dateRegex)?.[1],
                time:      text.match(timeRegex)?.[1],
                partySize: parseInt(text.match(partySizeRegex)?.[1] || '0'),
                guestName: parsed.from?.text.split('<')[0].trim(),
            };
        } catch (error: any) {
            console.error('Error parsing BCC email:', error.message);
            throw error;
        }
    }

    /**
     * Envoi brut sans template (utilisé pour les BCC vers le PMS du
     * restaurant — le contenu est composé en amont par l'appelant et reste
     * libre).
     */
    async sendRawEmail(options: {
        to: string | string[];
        subject: string;
        html?: string;
        text?: string;
    }): Promise<void> {
        await this.transporter.sendMail({
            from: this.fromAddress,
            ...options,
        });
    }
}

export default new EmailService();
