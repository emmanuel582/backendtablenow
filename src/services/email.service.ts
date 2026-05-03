import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

// ── Fail fast if SMTP env is missing — never fall back to hardcoded credentials
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
    throw new Error(
        'Missing required SMTP environment variables: SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM'
    );
}

export class EmailService {
    private readonly fromEmail = EMAIL_FROM as string;
    private readonly transporter: nodemailer.Transporter;

    constructor() {
        this.transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS,
            },
            tls: { rejectUnauthorized: false },
        });

        this.transporter.verify((error) => {
            if (error) {
                console.error('❌ SMTP connection error:', error);
            } else {
                console.log('✅ SMTP transporter initialized');
            }
        });
    }

    /**
     * Send verification email
     */
    async sendVerificationEmail(to: string, verificationToken: string, restaurantName: string): Promise<void> {
        const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

        await this.transporter.sendMail({
            from: `TableNow <${this.fromEmail}>`,
            to,
            subject: 'Vérifiez votre compte TableNow',
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
            <div class="header"><h1>TableNow</h1></div>
            <div class="content">
              <h2>Bienvenue sur TableNow, ${restaurantName} !</h2>
              <p>Vous y êtes presque ! Vérifiez votre adresse e-mail pour activer votre compte.</p>
              <p style="text-align: center;">
                <a href="${verificationUrl}" class="button" target="_blank">Vérifier mon compte</a>
              </p>
              <p>Une fois vérifié, votre assistant IA sera configuré automatiquement.</p>
              <p>Si le bouton ne fonctionne pas, copiez ce lien :</p>
              <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
            </div>
            <div class="footer"><p>© ${new Date().getFullYear()} TableNow. Tous droits réservés.</p></div>
          </div>
        </body>
        </html>
      `,
        });

        console.log(`Verification email sent to ${to}`);
    }

    /**
     * Send booking confirmation email — fully in French
     */
    async sendBookingConfirmation(data: {
        to: string;
        restaurantName: string;
        guestName: string;
        date: string;
        time: string;
        partySize: number;
        confirmationNumber: string;
        language?: 'fr' | 'en';
    }): Promise<void> {
        const lang = data.language === 'en' ? 'en' : 'fr';
        // Format date as DD/MM/YYYY for display
        const displayDate = data.date.split('-').reverse().join('/');

        await this.transporter.sendMail({
            from: `TableNow <${this.fromEmail}>`,
            to: data.to,
            subject: lang === 'en'
                ? `Booking confirmation — ${data.restaurantName}`
                : `Confirmation de réservation — ${data.restaurantName}`,
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
            .label { font-weight: bold; display: inline-block; width: 180px; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header"><h1>${lang === 'en' ? 'Booking confirmed' : 'Réservation confirmée'}</h1></div>
            <div class="content">
              <h2>${lang === 'en' ? `Hello ${data.guestName},` : `Bonjour ${data.guestName},`}</h2>
              <p>${lang === 'en' ? `Your reservation at <strong>${data.restaurantName}</strong> is confirmed.` : `Votre réservation chez <strong>${data.restaurantName}</strong> est confirmée.`}</p>
              <div class="booking-details">
                <div class="detail-row"><span class="label">${lang === 'en' ? 'Confirmation #:' : 'Numéro de confirmation :'}</span><span>${data.confirmationNumber}</span></div>
                <div class="detail-row"><span class="label">${lang === 'en' ? 'Restaurant:' : 'Restaurant :'}</span><span>${data.restaurantName}</span></div>
                <div class="detail-row"><span class="label">${lang === 'en' ? 'Date:' : 'Date :'}</span><span>${displayDate}</span></div>
                <div class="detail-row"><span class="label">${lang === 'en' ? 'Time:' : 'Heure :'}</span><span>${data.time}</span></div>
                <div class="detail-row"><span class="label">${lang === 'en' ? 'Guests:' : 'Nombre de personnes :'}</span><span>${data.partySize} ${lang === 'en' ? `guest${data.partySize > 1 ? 's' : ''}` : `personne${data.partySize > 1 ? 's' : ''}`}</span></div>
              </div>
              <p>${lang === 'en' ? 'We look forward to welcoming you!' : 'Nous avons hâte de vous accueillir !'}</p>
              <p><small>${lang === 'en' ? 'To modify or cancel, please contact the restaurant directly.' : 'Pour modifier ou annuler votre réservation, contactez directement le restaurant.'}</small></p>
            </div>
            <div class="footer"><p>${lang === 'en' ? 'Powered by TableNow' : 'Propulsé par TableNow'}</p></div>
          </div>
        </body>
        </html>
      `,
        });

        console.log(`Booking confirmation sent to ${data.to}`);
    }

    /**
     * Send notification to restaurant
     */
    async sendRestaurantNotification(data: {
        to: string;
        subject: string;
        message: string;
        bookingDetails?: any;
    }): Promise<void> {
        const b = data.bookingDetails || {};
        const bookingSummary = b && Object.keys(b).length > 0 ? `
      <h4>Détails de la réservation</h4>
      <ul style="padding-left:16px; line-height:1.6;">
        ${b.guest_name    ? `<li><strong>Client :</strong> ${b.guest_name}</li>` : ''}
        ${b.guest_email   ? `<li><strong>Email :</strong> ${b.guest_email}</li>` : ''}
        ${b.guest_phone   ? `<li><strong>Téléphone :</strong> ${b.guest_phone}</li>` : ''}
        ${b.booking_date  ? `<li><strong>Date :</strong> ${b.booking_date}</li>` : ''}
        ${b.booking_time  ? `<li><strong>Heure :</strong> ${b.booking_time}</li>` : ''}
        ${b.party_size    ? `<li><strong>Couverts :</strong> ${b.party_size}</li>` : ''}
        ${b.special_requests ? `<li><strong>Demandes spéciales :</strong> ${b.special_requests}</li>` : ''}
        ${b.confirmation_number ? `<li><strong>Confirmation n° :</strong> ${b.confirmation_number}</li>` : ''}
        ${b.source        ? `<li><strong>Source :</strong> ${b.source}</li>` : ''}
      </ul>
    ` : '';

        await this.transporter.sendMail({
            from: `TableNow <${this.fromEmail}>`,
            to: data.to,
            subject: `TableNow — ${data.subject}`,
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
            <div class="header"><h1>TableNow</h1></div>
            <div class="content">
              <div class="alert">
                <h3>${data.subject}</h3>
                <p>${data.message}</p>
              </div>
              ${bookingSummary}
              <p><small>Horodatage : ${new Date().toISOString()}</small></p>
            </div>
            <div class="footer"><p>© ${new Date().getFullYear()} TableNow. Tous droits réservés.</p></div>
          </div>
        </body>
        </html>
      `,
        });

        console.log(`Restaurant notification sent to ${data.to}`);
    }

    /**
     * Parse BCC email from Zenchef/SevenRooms
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
        if (parsed.from?.text.toLowerCase().includes('zenchef')) source = 'zenchef';
        else if (parsed.from?.text.toLowerCase().includes('sevenrooms')) source = 'sevenrooms';

        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/;
        const phoneRegex = /(\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9})/;
        const dateRegex = /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/;
        const timeRegex = /(\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)?)/;
        const partySizeRegex = /(\d+)\s*(?:guest|person|people|pax)/i;

        return {
            type,
            source,
            email: text.match(emailRegex)?.[1],
            phone: text.match(phoneRegex)?.[1],
            date: text.match(dateRegex)?.[1],
            time: text.match(timeRegex)?.[1],
            partySize: parseInt(text.match(partySizeRegex)?.[1] || '0'),
            guestName: parsed.from?.text.split('<')[0].trim(),
        };
    }

    async sendRawEmail(options: {
        to: string | string[];
        subject: string;
        html?: string;
        text?: string;
    }): Promise<void> {
        await this.transporter.sendMail({
            from: `TableNow <${this.fromEmail}>`,
            ...options,
        });
    }
}

export default new EmailService();
