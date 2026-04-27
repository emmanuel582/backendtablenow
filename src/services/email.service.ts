import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { config } from '../lib/config';

/**
 * Service d'envoi d'emails (transactionnels + parsing entrant).
 *
 * Toute la configuration SMTP et l'adresse expéditrice sont lues depuis
 * src/lib/config.ts (validé au boot). Aucun fallback hardcodé : si la config
 * est invalide, le serveur refuse de démarrer avant même d'instancier ce
 * service.
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
                // Certaines passerelles SMTP (Resend, SendGrid) présentent des
                // certs qui ne valident pas en mode strict — on désactive la
                // vérification pour garder la compatibilité historique.
                rejectUnauthorized: false,
            },
        });

        // Vérification non bloquante : on log le résultat mais on n'empêche pas
        // le démarrage si le SMTP est temporairement inaccessible.
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
     */
    async sendVerificationEmail(
        to: string,
        verificationToken: string,
        restaurantName: string,
    ): Promise<void> {
        const verificationUrl = `${config.frontendUrl}/verify-email?token=${verificationToken}`;

        const mailOptions = {
            from: this.fromAddress,
            to,
            subject: 'Verify your TableNow account',
            html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #000; color: #fff; padding: 20px; text-align: center; }
            .content { padding: 30px 20px; background: #f9f9f9; }
            .button { display: inline-block; padding: 12px 30px; background: #000; color: #fff; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>TableNow</h1>
            </div>
            <div class="content">
              <h2>Welcome to TableNow, ${restaurantName}!</h2>
              <p>You're almost there! Please verify your email address to activate your account.</p>
              <p style="text-align: center;">
                <a href="${verificationUrl}" class="button" target="_blank">Verify Account</a>
              </p>
              <p>Once verified, you'll be redirected to login and your AI assistant will be ready!</p>
              <p>If the button doesn't work, copy this link:</p>
              <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} TableNow. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Verification email sent to ${to} via SMTP`);
        } catch (error: any) {
            console.error('Error sending verification email:', error.message);
            throw error;
        }
    }

    /**
     * Confirmation de réservation envoyée au client final.
     */
    async sendBookingConfirmation(data: {
        to: string;
        restaurantName: string;
        guestName: string;
        date: string;
        time: string;
        partySize: number;
        confirmationNumber: string;
    }): Promise<void> {
        const mailOptions = {
            from: this.fromAddress,
            to: data.to,
            subject: `Booking Confirmation - ${data.restaurantName}`,
            html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #000; color: #fff; padding: 20px; text-align: center; }
            .content { padding: 30px 20px; background: #f9f9f9; }
            .booking-details { background: #fff; padding: 20px; border-left: 4px solid #000; margin: 20px 0; }
            .detail-row { padding: 10px 0; border-bottom: 1px solid #eee; }
            .label { font-weight: bold; display: inline-block; width: 150px; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Booking Confirmed</h1>
            </div>
            <div class="content">
              <h2>Dear ${data.guestName},</h2>
              <p>Your reservation at ${data.restaurantName} has been confirmed!</p>

              <div class="booking-details">
                <div class="detail-row">
                  <span class="label">Confirmation #:</span>
                  <span>${data.confirmationNumber}</span>
                </div>
                <div class="detail-row">
                  <span class="label">Restaurant:</span>
                  <span>${data.restaurantName}</span>
                </div>
                <div class="detail-row">
                  <span class="label">Date:</span>
                  <span>${data.date}</span>
                </div>
                <div class="detail-row">
                  <span class="label">Time:</span>
                  <span>${data.time}</span>
                </div>
                <div class="detail-row">
                  <span class="label">Party Size:</span>
                  <span>${data.partySize} guests</span>
                </div>
              </div>

              <p>We look forward to serving you!</p>
              <p><small>If you need to modify or cancel your reservation, please contact the restaurant directly.</small></p>
            </div>
            <div class="footer">
              <p>Powered by TableNow</p>
            </div>
          </div>
        </body>
        </html>
      `,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Booking confirmation sent to ${data.to} via SMTP`);
        } catch (error: any) {
            console.error('Error sending booking confirmation:', error.message);
            throw error;
        }
    }

    /**
     * Notification interne envoyée à l'équipe restaurant (alertes diverses).
     */
    async sendRestaurantNotification(data: {
        to: string;
        subject: string;
        message: string;
        bookingDetails?: any;
    }): Promise<void> {
        const b = data.bookingDetails || {};
        const bookingSummary = b && Object.keys(b).length > 0 ? `
      <h4>Booking Details</h4>
      <ul style="padding-left:16px; line-height:1.6;">
        ${b.guest_name ? `<li><strong>Guest:</strong> ${b.guest_name}</li>` : ''}
        ${b.guest_email ? `<li><strong>Email:</strong> ${b.guest_email}</li>` : ''}
        ${b.guest_phone ? `<li><strong>Phone:</strong> ${b.guest_phone}</li>` : ''}
        ${b.booking_date ? `<li><strong>Date:</strong> ${b.booking_date}</li>` : ''}
        ${b.booking_time ? `<li><strong>Time:</strong> ${b.booking_time}</li>` : ''}
        ${b.party_size ? `<li><strong>Party Size:</strong> ${b.party_size}</li>` : ''}
        ${b.special_requests ? `<li><strong>Special Requests:</strong> ${b.special_requests}</li>` : ''}
        ${b.confirmation_number ? `<li><strong>Confirmation #:</strong> ${b.confirmation_number}</li>` : ''}
        ${b.source ? `<li><strong>Source:</strong> ${b.source}</li>` : ''}
      </ul>
    ` : '';

        const mailOptions = {
            from: this.fromAlertAddress,
            to: data.to,
            subject: `TableNow Alert: ${data.subject}`,
            html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #000; color: #fff; padding: 20px; text-align: center; }
            .content { padding: 30px 20px; background: #f9f9f9; }
            .alert { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>TableNow Notification</h1>
            </div>
            <div class="content">
              <div class="alert">
                <h3>${data.subject}</h3>
                <p>${data.message}</p>
              </div>
              ${bookingSummary}
              <p><small>Timestamp: ${new Date().toISOString()}</small></p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} TableNow. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Restaurant notification sent to ${data.to} via SMTP`);
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

            // Type d'événement déduit du sujet / corps
            let type: 'new' | 'modification' | 'cancellation' = 'new';
            if (subject.toLowerCase().includes('cancel') || text.toLowerCase().includes('cancelled')) {
                type = 'cancellation';
            } else if (subject.toLowerCase().includes('modif') || subject.toLowerCase().includes('update')) {
                type = 'modification';
            }

            // Source déduite de l'expéditeur
            let source: 'zenchef' | 'sevenrooms' | 'unknown' = 'unknown';
            if (parsed.from?.text.toLowerCase().includes('zenchef')) {
                source = 'zenchef';
            } else if (parsed.from?.text.toLowerCase().includes('sevenrooms')) {
                source = 'sevenrooms';
            }

            // Extraction des détails de réservation par regex sur le corps texte
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
     * Envoi brut sans template (utilisé pour les BCC vers le PMS du restaurant).
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
