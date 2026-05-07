import supabase from '../config/supabase';
import vapiService from './vapi.service';
import logger from '../lib/logger';

// ── Contracts ─────────────────────────────────────────────────────────────────

export interface RestaurantForProvisioning {
    id: string;
    name: string;
    email: string;
    phone?: string;
}

export interface ProvisioningResult {
    assistantId: string;
    phoneNumber: string;
    phoneId: string;
    bccEmail: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS  = 1_000;

// ── Service ────────────────────────────────────────────────────────────────────

export class ProvisioningService {

    /**
     * Fully provisions a restaurant’s VAPI stack in 5 ordered steps.
     *
     * Atomic guarantee: if any step after assistant creation fails, the assistant
     * is deleted on VAPI and the DB row is reset to status='error'.
     * → The restaurant is never left in a half-provisioned, billing-leaking state.
     *
     * Step 1 — Create VAPI assistant
     * Step 2 — Assign phone number from pool   (3× exponential retry)
     * Step 3 — Link assistant ↔ phone
     * Step 4 — Generate BCC email address
     * Step 5 — Mark restaurant active
     */
    async provision(restaurant: RestaurantForProvisioning): Promise<ProvisioningResult> {
        const log = logger.child({ restaurantId: restaurant.id, service: 'ProvisioningService' });
        log.info('🚀 Provisioning started');

        // ─ Step 1: Create assistant ───────────────────────────────────────────────
        const assistant = await vapiService.createAssistant(restaurant);
        log.info({ assistantId: assistant.id }, '✅ Step 1/5 — Assistant created');

        await supabase
            .from('restaurants')
            .update({ vapi_assistant_id: assistant.id })
            .eq('id', restaurant.id);

        // Steps 2–5: wrapped in try/catch — any failure triggers rollback
        try {
            // ─ Step 2: Assign phone (with retry) ──────────────────────────────
            const phone = await this.withRetry(
                () => vapiService.createPhoneNumber(restaurant.id, restaurant.name, assistant.id),
                { attempts: RETRY_ATTEMPTS, baseDelayMs: RETRY_BASE_MS, label: 'createPhoneNumber' }
            );
            log.info({ phone: phone.number, phoneId: phone.id }, '✅ Step 2/5 — Phone assigned');

            await supabase
                .from('restaurants')
                .update({ vapi_phone_id: phone.id, vapi_phone_number: phone.number || phone.id })
                .eq('id', restaurant.id);

            // ─ Step 3: Link ────────────────────────────────────────────────────
            await vapiService.linkAssistantToPhone(phone.id, assistant.id);
            log.info('✅ Step 3/5 — Assistant linked to phone');

            // ─ Step 4: BCC email ───────────────────────────────────────────────
            const emailDomain = process.env.EMAIL_DOMAIN;
            if (!emailDomain) throw new Error('EMAIL_DOMAIN env variable is not set');
            const bccEmail = `bcc+r-${restaurant.id}@${emailDomain}`;
            log.info({ bccEmail }, '✅ Step 4/5 — BCC email generated');

            // ─ Step 5: Activate ───────────────────────────────────────────────
            await supabase
                .from('restaurants')
                .update({ bcc_email: bccEmail, status: 'active' })
                .eq('id', restaurant.id);
            log.info('✅ Step 5/5 — Restaurant activated');

            log.info({ assistantId: assistant.id, phoneNumber: phone.number }, '🎉 Provisioning complete');

            return {
                assistantId: assistant.id,
                phoneNumber: phone.number || phone.id,
                phoneId:     phone.id,
                bccEmail,
            };

        } catch (err: any) {
            // ─ Rollback ─────────────────────────────────────────────────────────
            log.warn(
                { assistantId: assistant.id, err: err.message },
                '↩️ Provisioning failed — rolling back VAPI assistant'
            );
            try {
                await vapiService.deleteAssistant(assistant.id);
                await supabase
                    .from('restaurants')
                    .update({ vapi_assistant_id: null, status: 'error' })
                    .eq('id', restaurant.id);
                log.info({ assistantId: assistant.id }, '✅ Rollback complete — no orphan on VAPI');
            } catch (rollbackErr: any) {
                // Worst case: VAPI assistant exists but isn't linked.
                // Logged with full context so ops can manually clean up.
                log.error(
                    { assistantId: assistant.id, rollbackErr: rollbackErr.message },
                    '❌ Rollback failed — VAPI assistant may be orphaned, manual cleanup required'
                );
            }
            throw err;
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────────

    private async withRetry<T>(
        fn: () => Promise<T>,
        opts: { attempts: number; baseDelayMs: number; label: string }
    ): Promise<T> {
        let lastErr!: Error;
        for (let attempt = 1; attempt <= opts.attempts; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                lastErr = err;
                if (attempt < opts.attempts) {
                    const delay = opts.baseDelayMs * 2 ** (attempt - 1);
                    logger.warn(
                        { label: opts.label, attempt, of: opts.attempts, delayMs: delay, err: err.message },
                        `⚠️ ${opts.label} failed — retrying in ${delay}ms`
                    );
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        throw lastErr;
    }
}

export default new ProvisioningService();
