import supabase from '../config/supabase';
import emailService from '../services/email.service';
import { config } from '../lib/config';

function trialEmailHtml(name: string, daysLeft: number, slug: string): string {
    const isExpired = daysLeft === 0;
    const title = isExpired
        ? 'Votre essai est terminé'
        : `Votre essai expire ${daysLeft === 1 ? 'demain' : 'dans 2 jours'}`;

    const body = isExpired
        ? `Votre période d'essai gratuit TableNow est <strong style="color:white">terminée</strong> et votre assistant IA a été mis en pause.`
        : `Votre période d'essai gratuit TableNow arrive à son terme <strong style="color:white">${daysLeft === 1 ? 'demain' : 'dans 2 jours'}</strong>.`;

    // Deep-link to the restaurant's billing page. config.frontendUrl is the single
    // domain source; slug scopes the link to this restaurant.
    const billingUrl = `${config.frontendUrl}/r/${slug}/billing`;

    return `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:white;padding:40px;border-radius:16px">
      <div style="color:#b8f000;font-size:24px;font-weight:900;margin-bottom:24px">TableNow</div>
      <h1 style="font-size:26px;font-weight:700;margin-bottom:8px">${title}</h1>
      <div style="width:40px;height:3px;background:#b8f000;margin-bottom:24px"></div>
      <p style="color:#888;line-height:1.6">Bonjour ${name},</p>
      <p style="color:#888;line-height:1.6">${body}</p>
      <p style="color:#888;line-height:1.6">Pour continuer à ne manquer aucun appel et gérer vos réservations 24h/24, activez votre abonnement maintenant.</p>
      <div style="background:#1a1a1a;border-left:3px solid #b8f000;padding:16px;border-radius:8px;margin:24px 0">
        <p style="color:#888;margin:0">
          ${isExpired
            ? "Vos données et votre configuration sont conservées. Aucune action manuelle n'est nécessaire après souscription."
            : "À l'expiration, votre assistant IA sera mis en pause et ne répondra plus aux appels entrants."
          }
        </p>
      </div>
      <a href="${billingUrl}"
         style="display:inline-block;background:#b8f000;color:black;font-weight:700;padding:14px 28px;border-radius:12px;text-decoration:none">
        Activer mon abonnement →
      </a>
      <p style="color:#555;font-size:12px;margin-top:32px">Des questions ? Répondez à cet email, nous lisons chaque message.</p>
      <p style="color:#555;font-size:12px">TableNow · Your Restaurant Host(ess) 24/7</p>
    </div>
  `;
}

export async function checkTrialEmails(): Promise<void> {
    const now = new Date();

    // J-2: expires in 47–49 hours
    const j2Start = new Date(now.getTime() + 47 * 3600000);
    const j2End   = new Date(now.getTime() + 49 * 3600000);
    const { data: j2List } = await supabase
        .from('restaurants')
        .select('id, name, email, slug, owner_name')
        .gte('trial_ends_at', j2Start.toISOString())
        .lte('trial_ends_at', j2End.toISOString())
        .eq('trial_email_j2_sent', false)
        .eq('is_active', true);

    for (const r of j2List || []) {
        await emailService.sendRawEmail({
            to:      r.email,
            subject: 'Votre essai TableNow expire dans 2 jours',
            html:    trialEmailHtml(r.owner_name || r.name, 2, r.slug),
        });
        await supabase.from('restaurants').update({ trial_email_j2_sent: true }).eq('id', r.id);
    }

    // J-1: expires in 23–25 hours
    const j1Start = new Date(now.getTime() + 23 * 3600000);
    const j1End   = new Date(now.getTime() + 25 * 3600000);
    const { data: j1List } = await supabase
        .from('restaurants')
        .select('id, name, email, slug, owner_name')
        .gte('trial_ends_at', j1Start.toISOString())
        .lte('trial_ends_at', j1End.toISOString())
        .eq('trial_email_j1_sent', false)
        .eq('is_active', true);

    for (const r of j1List || []) {
        await emailService.sendRawEmail({
            to:      r.email,
            subject: 'Votre essai TableNow expire demain',
            html:    trialEmailHtml(r.owner_name || r.name, 1, r.slug),
        });
        await supabase.from('restaurants').update({ trial_email_j1_sent: true }).eq('id', r.id);
    }

    // J0: trial expired, not yet notified
    const { data: j0List } = await supabase
        .from('restaurants')
        .select('id, name, email, slug, owner_name')
        .lt('trial_ends_at', now.toISOString())
        .eq('trial_email_j0_sent', false)
        .eq('is_active', true);

    for (const r of j0List || []) {
        await emailService.sendRawEmail({
            to:      r.email,
            subject: 'Votre essai TableNow est terminé',
            html:    trialEmailHtml(r.owner_name || r.name, 0, r.slug),
        });
        await supabase.from('restaurants').update({
            trial_email_j0_sent: true,
            is_active:           false,
        }).eq('id', r.id);
    }
}
