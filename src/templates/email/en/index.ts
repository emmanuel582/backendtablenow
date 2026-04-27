/**
 * Email templates — English.
 */
import {
    EmailTemplates,
    VerificationData,
    BookingConfirmationData,
    RestaurantNotificationData,
} from '../types';
import { wrap, bookingDetailsList } from '../_shared';

const year = () => new Date().getFullYear();

const labels = {
    guest:           'Guest',
    email:           'Email',
    phone:           'Phone',
    date:            'Date',
    time:            'Time',
    partySize:       'Party Size',
    specialRequests: 'Special Requests',
    confirmation:    'Confirmation #',
    source:          'Source',
};

const en: EmailTemplates = {
    verification: {
        subject: () => 'Verify your TableNow account',
        html: (data: VerificationData) => wrap(
            'TableNow',
            `
            <h2>Welcome to TableNow, ${data.restaurantName}!</h2>
            <p>You're almost there! Please verify your email address to activate your account.</p>
            <p style="text-align: center;">
              <a href="${data.verificationUrl}" class="button" target="_blank">Verify Account</a>
            </p>
            <p>Once verified, you'll be redirected to login and your AI assistant will be ready!</p>
            <p>If the button doesn't work, copy this link:</p>
            <p style="word-break: break-all; color: #666;">${data.verificationUrl}</p>
            `,
            `© ${year()} TableNow. All rights reserved.`,
        ),
    },

    bookingConfirmation: {
        subject: (data: BookingConfirmationData) =>
            `Booking Confirmation — ${data.restaurantName}`,
        html: (data: BookingConfirmationData) => wrap(
            'Booking Confirmed',
            `
            <h2>Dear ${data.guestName},</h2>
            <p>Your reservation at ${data.restaurantName} has been confirmed!</p>

            <div class="booking-details">
              <div class="detail-row"><span class="label">Confirmation #:</span><span>${data.confirmationNumber}</span></div>
              <div class="detail-row"><span class="label">Restaurant:</span><span>${data.restaurantName}</span></div>
              <div class="detail-row"><span class="label">Date:</span><span>${data.date}</span></div>
              <div class="detail-row"><span class="label">Time:</span><span>${data.time}</span></div>
              <div class="detail-row"><span class="label">Party Size:</span><span>${data.partySize} guests</span></div>
            </div>

            <p>We look forward to serving you!</p>
            <p><small>If you need to modify or cancel your reservation, please contact the restaurant directly.</small></p>
            `,
            'Powered by TableNow',
        ),
    },

    restaurantNotification: {
        subject: (data: RestaurantNotificationData) => `TableNow Alert: ${data.subject}`,
        html: (data: RestaurantNotificationData) => wrap(
            'TableNow Notification',
            `
            <div class="alert">
              <h3>${data.subject}</h3>
              <p>${data.message}</p>
            </div>
            ${bookingDetailsList(data.bookingDetails || {}, labels)}
            <p><small>Timestamp: ${new Date().toISOString()}</small></p>
            `,
            `© ${year()} TableNow. All rights reserved.`,
        ),
    },
};

export default en;
