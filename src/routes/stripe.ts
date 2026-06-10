import { Router, Request, Response } from 'express';
import logger from '../lib/logger';
import Stripe from 'stripe';
import supabase from '../config/supabase';
import { config } from '../lib/config';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

// Stripe est une intégration optionnelle et remplaçable : le client n'est instancié
// qu'à la première utilisation, et uniquement si une clé est configurée. Le serveur
// démarre donc même sans Stripe ; les routes renvoient alors un 503 explicite au lieu
// de crasher au boot (l'ancien `new Stripe(undefined!)` au chargement du module).
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
    if (!_stripe) {
        _stripe = new Stripe(config.stripe.secretKey as string, { apiVersion: '2024-04-10' });
    }
    return _stripe;
}

const PRICE_IDS = config.stripe.prices; // { en_cas, miam, fin_gourmet }

/**
 * POST /api/stripe/create-checkout-session
 */
router.post('/create-checkout-session', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!config.stripe.isConfigured) {
        return res.status(503).json({ error: 'Paiement momentanément indisponible (Stripe non configuré).' });
    }
    try {
        const { plan } = req.body;
        const restaurantId = req.user!.restaurantId;

        const priceId = PRICE_IDS[plan as keyof typeof PRICE_IDS];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .select('id, email, name, slug, stripe_customer_id')
            .eq('id', restaurantId)
            .single();

        if (error || !restaurant) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        const stripe = getStripe();

        // Create or reuse Stripe customer
        let customerId = restaurant.stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email:    restaurant.email,
                name:     restaurant.name,
                metadata: { restaurant_id: restaurant.id },
            });
            customerId = customer.id;
            await supabase
                .from('restaurants')
                .update({ stripe_customer_id: customerId })
                .eq('id', restaurant.id);
        }

        // URLs pilotées par config.frontendUrl (source unique du domaine) — plus de
        // domaine en dur. cancel_url renvoie vers la page billing réelle (/r/:slug/billing).
        const session = await stripe.checkout.sessions.create({
            customer:             customerId,
            payment_method_types: ['card'],
            line_items:           [{ price: priceId, quantity: 1 }],
            mode:                 'subscription',
            subscription_data:    { trial_period_days: 7 },
            success_url:          `${config.frontendUrl}/r/${restaurant.slug}/dashboard?subscribed=true`,
            cancel_url:           `${config.frontendUrl}/r/${restaurant.slug}/billing`,
            locale:               'fr',
        });

        res.json({ url: session.url });
    } catch (err: any) {
        logger.error({ err }, 'Stripe checkout error');
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/stripe/webhook
 * IMPORTANT: raw body is captured in server.ts BEFORE express.json()
 *
 * Source de vérité abonnement : Stripe émet les événements, le backend écrit le statut
 * exploitable dans restaurants (plan / is_active / stripe_subscription_id). Le frontend
 * ne décide jamais seul qu'un abonnement est actif.
 */
router.post('/webhook', async (req: Request, res: Response) => {
    if (!config.stripe.isConfigured) {
        return res.status(503).send('Stripe not configured');
    }
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).send('Missing signature');

    let event: Stripe.Event;
    try {
        event = getStripe().webhooks.constructEvent(
            req.body,
            sig,
            config.stripe.webhookSecret as string,
        );
    } catch (err: any) {
        return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
        switch (event.type) {
            // Lien immédiat dès la fin du checkout (avant même subscription.updated).
            case 'checkout.session.completed': {
                const session        = event.data.object as Stripe.Checkout.Session;
                const customerId      = session.customer as string | null;
                const subscriptionId  = session.subscription as string | null;
                if (customerId) {
                    const { data } = await supabase
                        .from('restaurants').select('id').eq('stripe_customer_id', customerId).single();
                    if (data) {
                        await supabase.from('restaurants').update({
                            stripe_subscription_id: subscriptionId,
                            plan:      'paid',
                            is_active: true,
                        }).eq('id', data.id);
                    }
                }
                break;
            }

            case 'customer.subscription.updated': {
                const sub    = event.data.object as Stripe.Subscription;
                const status = sub.status;
                const { data } = await supabase
                    .from('restaurants').select('id').eq('stripe_customer_id', sub.customer as string).single();
                if (data) {
                    await supabase.from('restaurants').update({
                        stripe_subscription_id: sub.id,
                        plan:      status === 'active' ? 'paid' : 'trial',
                        is_active: ['active', 'trialing'].includes(status),
                    }).eq('id', data.id);
                }
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object as Stripe.Subscription;
                const { data } = await supabase
                    .from('restaurants').select('id').eq('stripe_customer_id', sub.customer as string).single();
                if (data) {
                    await supabase.from('restaurants').update({
                        is_active: false,
                        plan:      'expired',
                    }).eq('id', data.id);
                }
                break;
            }

            default:
                logger.debug({ type: event.type }, 'Unhandled Stripe event');
        }
    } catch (err) {
        logger.error({ err }, 'Stripe webhook processing error');
    }

    res.json({ received: true });
});

export default router;
