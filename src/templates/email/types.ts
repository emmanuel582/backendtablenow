/**
 * Templates emails — type partagé.
 *
 * Chaque langue exporte un objet conforme à `EmailTemplates`. La signature
 * publique du EmailService reste stable : on passe `language` en paramètre,
 * le service choisit le bon template.
 */

export type SupportedLanguage = 'fr' | 'en';

export interface VerificationData {
    verificationUrl: string;
    restaurantName: string;
}

export interface BookingConfirmationData {
    restaurantName: string;
    guestName: string;
    date: string;
    time: string;
    partySize: number;
    confirmationNumber: string;
}

export interface RestaurantNotificationData {
    subject: string;
    message: string;
    bookingDetails?: Record<string, any>;
}

export interface EmailTemplate<TData> {
    subject: (data: TData) => string;
    html:    (data: TData) => string;
}

export interface EmailTemplates {
    verification:          EmailTemplate<VerificationData>;
    bookingConfirmation:   EmailTemplate<BookingConfirmationData>;
    restaurantNotification: EmailTemplate<RestaurantNotificationData>;
}
