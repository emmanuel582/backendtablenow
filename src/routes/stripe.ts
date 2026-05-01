import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import supabase from '../config/supabase';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });

const PRICE_IDS: Record<string, string> = {
    en_cas:      process.env.STRIPE_PRICE_EN_CAS!,
    miam:        process.env.STRIPE_PRICE_MIAM!,
    fin_gourmet: process.env.STRIPE_PRICE_FIN_GOURMET!,
};

/**
 * POST /api/stripe/create-checkout-session
 */
router.post('/create-checkout-session', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { plan } = req.body;
        const restaurantId = req.user!.restaurantId;

        if (!PRICE_IDS[plan]) {
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

        const session = await stripe.checkout.sessions.create({
            customer:             customerId,
            payment_method_types: ['card'],
            line_items:           [{ price: PRICE_IDS[plan], quantity: 1 }],
            mode:                 'subscription',
            subscription_data:    { trial_period_days: 7 },
            success_url:          `https://app.tablenow.io/r/${restaurant.slug}/dashboard?subscribed=true`,
            cancel_url:           `https://app.tablenow.io/pricing`,
            locale:               'fr',
        });

        res.json({ url: session.url });
    } catch (err: any) {
        console.error('Stripe checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/stripe/webhook
 * IMPORTANT: raw body is captured in server.ts BEFORE express.json()
 */
router.post('/webhook', async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).send('Missing signature');

    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET!,
        );
    } catch (err: any) {
        return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
        if (event.type === 'customer.subscription.updated') {
            const sub    = event.data.object as Stripe.Subscription;
            const status = sub.status;
            const { data } = await supabase
                .from('restaurants')
                .select('id')
                .eq('stripe_customer_id', sub.customer as string)
                .single();

            if (data) {
                await supabase.from('restaurants').update({
                    stripe_subscription_id: sub.id,
                    plan:      status === 'active' ? 'paid' : 'trial',
                    is_active: ['active', 'trialing'].includes(status),
                }).eq('id', data.id);
            }
        }

        if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object as Stripe.Subscription;
            const { data } = await supabase
                .from('restaurants')
                .select('id')
                .eq('stripe_customer_id', sub.customer as string)
                .single();

            if (data) {
                await supabase.from('restaurants').update({
                    is_active: false,
                    plan:      'expired',
                }).eq('id', data.id);
            }
        }
    } catch (err) {
        console.error('Webhook processing error:', err);
    }

    res.json({ received: true });
});

export default router;
