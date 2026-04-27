/**
 * Templates emails — Français.
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
    guest:           'Client',
    email:           'Email',
    phone:           'Téléphone',
    date:            'Date',
    time:            'Heure',
    partySize:       'Couverts',
    specialRequests: 'Demandes spéciales',
    confirmation:    'Confirmation #',
    source:          'Source',
};

const fr: EmailTemplates = {
    verification: {
        subject: () => 'Vérifiez votre compte TableNow',
        html: (data: VerificationData) => wrap(
            'TableNow',
            `
            <h2>Bienvenue sur TableNow, ${data.restaurantName} !</h2>
            <p>Vous y êtes presque ! Veuillez vérifier votre adresse email pour activer votre compte.</p>
            <p style="text-align: center;">
              <a href="${data.verificationUrl}" class="button" target="_blank">Vérifier mon compte</a>
            </p>
            <p>Une fois validé, vous serez redirigé vers la connexion et votre assistant IA sera prêt !</p>
            <p>Si le bouton ne fonctionne pas, copiez ce lien :</p>
            <p style="word-break: break-all; color: #666;">${data.verificationUrl}</p>
            `,
            `© ${year()} TableNow. Tous droits réservés.`,
        ),
    },

    bookingConfirmation: {
        subject: (data: BookingConfirmationData) =>
            `Confirmation de réservation — ${data.restaurantName}`,
        html: (data: BookingConfirmationData) => wrap(
            'Réservation confirmée',
            `
            <h2>Bonjour ${data.guestName},</h2>
            <p>Votre réservation chez ${data.restaurantName} est confirmée !</p>

            <div class="booking-details">
              <div class="detail-row"><span class="label">Confirmation #&nbsp;:</span><span>${data.confirmationNumber}</span></div>
              <div class="detail-row"><span class="label">Restaurant&nbsp;:</span><span>${data.restaurantName}</span></div>
              <div class="detail-row"><span class="label">Date&nbsp;:</span><span>${data.date}</span></div>
              <div class="detail-row"><span class="label">Heure&nbsp;:</span><span>${data.time}</span></div>
              <div class="detail-row"><span class="label">Couverts&nbsp;:</span><span>${data.partySize}</span></div>
            </div>

            <p>Nous avons hâte de vous accueillir !</p>
            <p><small>Pour modifier ou annuler votre réservation, merci de contacter directement le restaurant.</small></p>
            `,
            'Propulsé par TableNow',
        ),
    },

    restaurantNotification: {
        subject: (data: RestaurantNotificationData) => `Alerte TableNow : ${data.subject}`,
        html: (data: RestaurantNotificationData) => wrap(
            'Notification TableNow',
            `
            <div class="alert">
              <h3>${data.subject}</h3>
              <p>${data.message}</p>
            </div>
            ${bookingDetailsList(data.bookingDetails || {}, labels)}
            <p><small>Horodatage&nbsp;: ${new Date().toISOString()}</small></p>
            `,
            `© ${year()} TableNow. Tous droits réservés.`,
        ),
    },
};

export default fr;
