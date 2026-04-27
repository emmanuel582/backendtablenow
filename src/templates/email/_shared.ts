/**
 * Helpers HTML partagés entre toutes les langues.
 * Chaque template définit son propre wording, mais le shell (header/footer/CSS)
 * est commun pour garantir une identité visuelle cohérente.
 */

export const baseStyles = `
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #000; color: #fff; padding: 20px; text-align: center; }
    .content { padding: 30px 20px; background: #f9f9f9; }
    .button { display: inline-block; padding: 12px 30px; background: #000; color: #fff; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    .booking-details { background: #fff; padding: 20px; border-left: 4px solid #000; margin: 20px 0; }
    .detail-row { padding: 10px 0; border-bottom: 1px solid #eee; }
    .label { font-weight: bold; display: inline-block; width: 150px; }
    .alert { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
`;

/** Wrap a block of body HTML in the standard email shell. */
export function wrap(headerTitle: string, bodyHtml: string, footerText: string): string {
    return `
<!DOCTYPE html>
<html>
<head><style>${baseStyles}</style></head>
<body>
  <div class="container">
    <div class="header"><h1>${headerTitle}</h1></div>
    <div class="content">${bodyHtml}</div>
    <div class="footer"><p>${footerText}</p></div>
  </div>
</body>
</html>`;
}

/**
 * Génère la liste HTML des détails de réservation pour l'email de notification
 * restaurant. Les libellés varient par langue, c'est pour ça qu'on les passe.
 */
export interface BookingDetailLabels {
    guest: string;
    email: string;
    phone: string;
    date: string;
    time: string;
    partySize: string;
    specialRequests: string;
    confirmation: string;
    source: string;
}

export function bookingDetailsList(
    details: Record<string, any>,
    labels: BookingDetailLabels,
): string {
    if (!details || Object.keys(details).length === 0) return '';
    const rows = [
        details.guest_name           && `<li><strong>${labels.guest}:</strong> ${details.guest_name}</li>`,
        details.guest_email          && `<li><strong>${labels.email}:</strong> ${details.guest_email}</li>`,
        details.guest_phone          && `<li><strong>${labels.phone}:</strong> ${details.guest_phone}</li>`,
        details.booking_date         && `<li><strong>${labels.date}:</strong> ${details.booking_date}</li>`,
        details.booking_time         && `<li><strong>${labels.time}:</strong> ${details.booking_time}</li>`,
        details.party_size           && `<li><strong>${labels.partySize}:</strong> ${details.party_size}</li>`,
        details.special_requests     && `<li><strong>${labels.specialRequests}:</strong> ${details.special_requests}</li>`,
        details.confirmation_number  && `<li><strong>${labels.confirmation}:</strong> ${details.confirmation_number}</li>`,
        details.source               && `<li><strong>${labels.source}:</strong> ${details.source}</li>`,
    ].filter(Boolean);
    return `<h4>${labels.guest === 'Client' ? 'Détails de la réservation' : 'Booking Details'}</h4>
<ul style="padding-left:16px; line-height:1.6;">${rows.join('')}</ul>`;
}
