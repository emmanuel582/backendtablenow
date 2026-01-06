import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

dotenv.config();

export class EmailService {
  private fromEmail = process.env.EMAIL_FROM || '"TableNow" <tablenow101@gmail.com>';
  private transporter;

  constructor() {
    // Configure nodemailer with SendGrid SMTP
    const port = Number(process.env.SMTP_PORT) || 465;
    const isSecure = port === 465;

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
      port: port,
      secure: isSecure,
      auth: {
        user: process.env.SMTP_USER || 'apikey',
        pass: process.env.SMTP_PASS,
      },
      // Increase timeouts and add more robust connection settings
      connectionTimeout: 10000, // 10 seconds
      greetingTimeout: 10000,
      socketTimeout: 20000,
      tls: {
        // Do not fail on invalid certs (useful for some proxies/firewalls)
        rejectUnauthorized: false
      }
    });

    // Verify connection on startup
    this.transporter.verify((error, success) => {
      if (error) {
        console.error('❌ SMTP Connection Error:', error);
      } else {
        console.log('✅ SMTP Server is ready to take messages');
      }
    });
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(to: string, verificationToken: string, restaurantName: string): Promise<void> {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    const mailOptions = {
      to,
      from: this.fromEmail,
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
      `
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`Verification email sent to ${to}. Message ID: ${info.messageId}`);
    } catch (error: any) {
      console.error('Error sending verification email:', error.message);
      throw error;
    }
  }

  /**
   * Send booking confirmation email
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
      to: data.to,
      from: this.fromEmail,
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
      `
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`Booking confirmation sent to ${data.to}. Message ID: ${info.messageId}`);
    } catch (error: any) {
      console.error('Error sending booking confirmation:', error.message);
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
      to: data.to,
      from: this.fromEmail,
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
      `
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`Restaurant notification sent to ${data.to}. Message ID: ${info.messageId}`);
    } catch (error: any) {
      console.error('Error sending restaurant notification:', error.message);
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
    try {
      const parsed = await simpleParser(rawEmail);

      const subject = parsed.subject || '';
      const text = parsed.text || '';
      const html = parsed.html || '';

      // Determine email type
      let type: 'new' | 'modification' | 'cancellation' = 'new';
      if (subject.toLowerCase().includes('cancel') || text.toLowerCase().includes('cancelled')) {
        type = 'cancellation';
      } else if (subject.toLowerCase().includes('modif') || subject.toLowerCase().includes('update')) {
        type = 'modification';
      }

      // Determine source
      let source: 'zenchef' | 'sevenrooms' | 'unknown' = 'unknown';
      if (parsed.from?.text.toLowerCase().includes('zenchef')) {
        source = 'zenchef';
      } else if (parsed.from?.text.toLowerCase().includes('sevenrooms')) {
        source = 'sevenrooms';
      }

      // Extract booking details using regex patterns
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
        guestName: parsed.from?.text.split('<')[0].trim()
      };
    } catch (error: any) {
      console.error('Error parsing BCC email:', error.message);
      throw error;
    }
  }
}

export default new EmailService();
