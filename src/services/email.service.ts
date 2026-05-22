import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import logger from '../lib/logger';

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
                logger.error({ action: 'smtp_init', error: error.message }, 'SMTP connection error');
            } else {
                logger.info({ action: 'smtp_init' }, 'SMTP transporter initialized');
            }
        });
    }

    /**
     * Send verification email
     */
    async sendVerificationEmail(to: string, verificationToken: string, _restaurantName: string): Promise<void> {
        const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

        try {
            const info = await this.transporter.sendMail({
                from: `TableNow <${this.fromEmail}>`,
                to,
                subject: 'Vérifiez votre compte TableNow',
                html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#0a0a0a;border-radius:12px;overflow:hidden">
    <div style="padding:32px 32px 0;text-align:center">
      <h1 style="font-size:28px;font-weight:700;color:#fff;margin:0">Table<span style="color:#b8f000">Now</span></h1>
    </div>
    <div style="padding:32px;background:#111;margin:24px;border-radius:12px;border:1px solid #1a1a1a">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;border:2px solid #b8f000;background:#0a0a0a">
          <span style="font-size:28px">✉</span>
        </div>
      </div>
      <h2 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 12px 0;text-align:center">Vérifiez votre email</h2>
      <p style="font-size:14px;color:#888;text-align:center;margin:0 0 24px 0;line-height:1.6">
        Un lien de vérification a été envoyé à<br>
        <strong style="color:#fff">${to}</strong>
      </p>
      <p style="font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#555;margin:0 0 14px 0">UNE FOIS ACTIVÉ</p>
      <div style="margin-bottom:24px">
        <div style="display:flex;align-items:flex-start;gap:12px;padding:8px 0">
          <span style="color:#b8f000;font-size:14px;line-height:1.6;flex-shrink:0">●</span>
          <span style="font-size:13px;color:#ccc;line-height:1.6">Votre assistant IA est configuré selon les standards de votre établissement</span>
        </div>
        <div style="display:flex;align-items:flex-start;gap:12px;padding:8px 0">
          <span style="color:#b8f000;font-size:14px;line-height:1.6;flex-shrink:0">●</span>
          <span style="font-size:13px;color:#ccc;line-height:1.6">Une ligne téléphonique dédiée vous est attribuée</span>
        </div>
        <div style="display:flex;align-items:flex-start;gap:12px;padding:8px 0">
          <span style="color:#b8f000;font-size:14px;line-height:1.6;flex-shrink:0">●</span>
          <span style="font-size:13px;color:#ccc;line-height:1.6">Une adresse BCC privée est créée pour centraliser vos réservations (zenchef, sevenrooms …)</span>
        </div>
      </div>
      <a href="${verificationUrl}" style="display:block;background:#b8f000;color:#000;text-align:center;padding:14px;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;margin-bottom:20px">J'ai vérifié mon email →</a>
      <p style="font-size:12px;color:#666;text-align:center;margin:0">Pas reçu ? Vérifiez vos spams ou <a href="${verificationUrl}" style="color:#b8f000;text-decoration:underline">renvoyez l'email</a></p>
    </div>
    <div style="padding:18px;background:#000;text-align:center;border-top:1px solid #1a1a1a">
      <p style="font-size:11px;color:#555;margin:0">© 2026 TableNow. Tous droits réservés.</p>
    </div>
  </div>
</body></html>`,
            });

            logger.info({
                recipient: to,
                template: 'verification',
                trigger: 'register',
                messageId: info.messageId,
            }, 'Verification email sent');
        } catch (error) {
            logger.error({
                recipient: to,
                template: 'verification',
                trigger: 'register',
                error: error instanceof Error ? error.message : String(error),
            }, 'Verification email failed');
            throw error;
        }
    }

    /**
     * Send booking confirmation email — template dark+lime validé
     */
    async sendBookingConfirmation(data: {
        to: string;
        restaurantName: string;
        restaurantAddress?: string;
        restaurantPhone?: string;
        guestName: string;
        date: string;
        time: string;
        partySize: number;
        confirmationNumber: string;
        language?: 'fr' | 'en';
    }): Promise<void> {
        // Format confirmationNumber → TN-2026-XXXX
        const rawNum = data.confirmationNumber || '';
        const seq = rawNum.replace(/\D/g, '').slice(-4).padStart(4, '0');
        const confirmationNumber = rawNum.startsWith('TN-') ? rawNum : `TN-2026-${seq}`;

        // Format dateLong : "Samedi 3 mai 2026"
        const [y, m, d] = data.date.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dateLong = dateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const dateCapitalized = dateLong.charAt(0).toUpperCase() + dateLong.slice(1);

        // Format time : "19h30"
        const timeFmt = data.time.replace(':', 'h');

        const restaurantAddress = data.restaurantAddress || '';
        const restaurantPhone   = data.restaurantPhone   || '';

        try {
            const info = await this.transporter.sendMail({
                from: `TableNow <${this.fromEmail}>`,
                to: data.to,
                subject: `Réservation confirmée — ${data.restaurantName}`,
                html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#0a0a0a;border-radius:12px;overflow:hidden">
    <div style="padding:32px 32px 0;text-align:center">
      <h1 style="font-size:24px;font-weight:700;color:#fff;margin:0">Table<span style="color:#b8f000">Now</span></h1>
    </div>
    <div style="padding:32px">
      <h2 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 8px 0">Réservation confirmée</h2>
      <p style="font-size:14px;color:#ccc;margin:0 0 24px 0;line-height:1.7">Bonjour M. ${data.guestName},<br>Votre réservation chez <strong style="color:#fff">${data.restaurantName}</strong> est confirmée. Au plaisir de vous recevoir.</p>
      <p style="font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#666;margin:0 0 14px 0">— Détails de votre réservation</p>
      <div style="background:#111;border:1px solid #1a1a1a;border-radius:10px;margin-bottom:24px;overflow:hidden">
        <div style="padding:12px 18px;border-bottom:1px solid #1a1a1a;display:flex"><span style="font-size:13px;font-weight:600;color:#888;width:170px;flex-shrink:0">N° de confirmation</span><span style="font-size:13px;color:#fff;font-family:monospace;font-weight:700">${confirmationNumber}</span></div>
        <div style="padding:12px 18px;border-bottom:1px solid #1a1a1a;display:flex"><span style="font-size:13px;font-weight:600;color:#888;width:170px;flex-shrink:0">Restaurant</span><span style="font-size:13px;color:#fff">${data.restaurantName}${restaurantAddress ? `<br><span style="font-size:12px;color:#666">${restaurantAddress}</span>` : ''}</span></div>
        <div style="padding:12px 18px;border-bottom:1px solid #1a1a1a;display:flex"><span style="font-size:13px;font-weight:600;color:#888;width:170px;flex-shrink:0">Date</span><span style="font-size:13px;color:#fff">${dateCapitalized}</span></div>
        <div style="padding:12px 18px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center"><span style="font-size:13px;font-weight:600;color:#888;width:170px;flex-shrink:0">Heure</span><span style="font-size:18px;font-weight:700;color:#b8f000">${timeFmt}</span></div>
        <div style="padding:12px 18px;display:flex"><span style="font-size:13px;font-weight:600;color:#888;width:170px;flex-shrink:0">Nombre de personnes</span><span style="font-size:13px;color:#fff">${data.partySize} couverts</span></div>
      </div>
      <p style="font-size:12px;color:#888;margin:0 0 6px 0;line-height:1.6">Pour toute modification ou annulation, merci de contacter directement le restaurant :</p>
      <p style="font-size:13px;color:#fff;font-weight:600;margin:0">${data.restaurantName}${restaurantPhone ? ` &nbsp;·&nbsp; ${restaurantPhone}` : ''}</p>
    </div>
    <div style="padding:18px;background:#000;text-align:center;border-top:1px solid #1a1a1a">
      <p style="font-size:11px;color:#555;margin:0">© 2026 TableNow. Tous droits réservés.</p>
    </div>
  </div>
</body></html>`,
            });

            logger.info({
                recipient: data.to,
                template: 'booking_confirmation',
                trigger: 'booking_created',
                messageId: info.messageId,
            }, 'Booking confirmation email sent');
        } catch (error) {
            logger.error({
                recipient: data.to,
                template: 'booking_confirmation',
                trigger: 'booking_created',
                error: error instanceof Error ? error.message : String(error),
            }, 'Booking confirmation email failed');
            throw error;
        }
    }

    /**
     * Send notification to restaurant
     */
    async sendRestaurantNotification(data: {
        to: string;
        subject: string;
        message: string;
        bookingDetails?: any;
        trigger?: 'provisioning' | 'vapi' | 'booking_created';
    }): Promise<void> {
        const b = data.bookingDetails || {};
        const trigger = data.trigger || 'provisioning';
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

        try {
            const info = await this.transporter.sendMail({
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

            logger.info({
                recipient: data.to,
                template: 'notification',
                trigger,
                messageId: info.messageId,
            }, 'Notification email sent');
        } catch (error) {
            logger.error({
                recipient: data.to,
                template: 'notification',
                trigger,
                error: error instanceof Error ? error.message : String(error),
            }, 'Notification email failed');
            throw error;
        }
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
        trigger?: 'trial' | 'cron' | 'manual';
    }): Promise<void> {
        const trigger = options.trigger || 'manual';
        const recipient = Array.isArray(options.to) ? options.to[0] : options.to;

        try {
            const info = await this.transporter.sendMail({
                from: `TableNow <${this.fromEmail}>`,
                to: options.to,
                subject: options.subject,
                html: options.html,
                text: options.text,
            });

            logger.info({
                recipient,
                template: 'raw',
                trigger,
                messageId: info.messageId,
            }, 'Raw email sent');
        } catch (error) {
            logger.error({
                recipient,
                template: 'raw',
                trigger,
                error: error instanceof Error ? error.message : String(error),
            }, 'Raw email failed');
            throw error;
        }
    }
}

export default new EmailService();
