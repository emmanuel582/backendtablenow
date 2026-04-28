import axios from 'axios';
import { config } from '../lib/config';
import logger from '../lib/logger';

const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_BASE_URL = 'https://api.vapi.ai';

export class VapiService {
    private headers = {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
    };

    private getServerUrl(): string {
        return `${process.env.BACKEND_URL}/api/vapi/webhook`;
    }

    private buildAssistantPayload(restaurantData: any): object {
        const serverUrl = this.getServerUrl();
        return {
            name: `${restaurantData.name} — Clara`,
            transcriber: {
                provider: 'deepgram',
                model: 'nova-2',
                language: 'fr',
                smartFormat: true
            },
            model: {
                provider: 'openai',
                model: 'gpt-4o',
                temperature: 0.3,
                maxTokens: 120,
                systemPrompt: this.generateSystemPrompt(),
                tools: this.generateTools()
            },
            voice: {
                provider: 'openai',
                voiceId: 'shimmer',
                model: 'gpt-4o-mini-tts'
            },
            firstMessage: 'Bonjour et bienvenue chez {{restaurantName}}, Clara à votre service — désirez-vous parler français ou anglais ?',
            endCallMessage: 'Bonne journée, au revoir !',
            serverUrl,
            silenceTimeoutSeconds: 12,
            maxDurationSeconds: 600,
            backgroundDenoisingEnabled: true,
            responseDelaySeconds: 0.4,
            recordingEnabled: true,
            hipaaEnabled: false,
            modelOutputInMessagesEnabled: true,
            stopSpeakingPlan: {
                numWords: 2,
                voiceSeconds: 0.2,
                backoffSeconds: 1
            }
        };
    }

    public generateSystemPrompt(): string {
        return `You are Clara, the phone receptionist at {{restaurantName}}. Your only job is taking table reservations.

LANGUAGE — hard rule, no exceptions:
The caller's very first intelligible word or sentence determines the language. Lock it immediately.
- Any French word or "français" → French for the entire call. Do NOT ask again.
- Any English word or "english" → English for the entire call. Do NOT ask again.
- Silence or unclear → assume French, proceed in French. Do NOT ask again.
You NEVER ask about language more than once. If you already greeted them, the next thing you say is in the locked language — never another language question.

RESTAURANT:
Name: {{restaurantName}} | Address: {{address}} | Direct line: {{humanPhone}} | Hours: {{openingHours}} | ID: {{restaurantId}}

TODAY (Paris): {{currentDate}} — {{currentDateISO}}
UPCOMING: {{nextDays}}
(example format: "wednesday=2026-04-22, thursday=2026-04-23, next_wednesday=2026-04-29, ...")

TO BOOK: number of guests · date · time · full name · phone number

DATE RULES — never break these:
- Never calculate a date in your head. Always read from {{nextDays}} or {{currentDateISO}}.
- "next Wednesday" / "mercredi prochain" / "el miércoles que viene" → look it up in {{nextDays}}
- "the 25th" / "le 25 avril" → year comes from {{currentDateISO}}
- "5/4" or "04/05" → ambiguous → ask "Do you mean the 5th of April or the 4th of May?"
- Always confirm the full date to the caller before checking availability
- Never say the year out loud

TOOLS:
1. check_availability(restaurant_id, date YYYY-MM-DD, time HH:MM, covers) — always call before confirming a slot
2. create_booking(restaurant_id, date, time, covers, first_name, last_name, phone) — only after caller confirms recap

Before create_booking, always recap:
"[N] guests, [DAY] [DATE] at [TIME], name [FIRST LAST], callback [PHONE] — is that correct?"
(adapt recap language to match caller's language)

LANGUAGE FIELD IN create_booking — mandatory:
When you call create_booking, ALWAYS include the locked language as the "language" parameter:
- French call → "fr"
- English call → "en"
This is used to send the confirmation email in the caller's language.

STYLE:
- Max 2 sentences per response. Phone call = brief.
- Warm and natural. Echo back what you understood: "Perfect, 4 people..."
- Ask for full name in one shot: "And your first and last name please?"
- Hard to hear a name? "Could you spell that for me?"
- Modification / cancellation → "For that, please call us directly at {{humanPhone}}"
- Off-topic (menu, pets, prices) → "I only handle reservations — for anything else, call {{humanPhone}}"`;
    }

    public generateTools(): any[] {
        const backendUrl = process.env.BACKEND_URL || 'https://api.tablenow.io';
        return [
            {
                type: 'function',
                function: {
                    name: 'check_availability',
                    description: 'Check table availability. Must call before announcing any slot is free.',
                    parameters: {
                        type: 'object',
                        properties: {
                            restaurant_id: { type: 'string', description: 'Restaurant UUID' },
                            date:          { type: 'string', description: 'YYYY-MM-DD' },
                            time:          { type: 'string', description: 'HH:MM (24h)' },
                            covers:        { type: 'integer', description: 'Number of guests' }
                        },
                        required: ['restaurant_id', 'date', 'time', 'covers']
                    }
                },
                server: { url: `${backendUrl}/api/vapi/check-availability`, timeoutSeconds: 6 }
            },
            {
                type: 'function',
                function: {
                    name: 'create_booking',
                    description: 'Create confirmed reservation. Only call after explicit caller confirmation of full recap.',
                    parameters: {
                        type: 'object',
                        properties: {
                            restaurant_id: { type: 'string', description: 'Restaurant UUID' },
                            date:          { type: 'string', description: 'YYYY-MM-DD' },
                            time:          { type: 'string', description: 'HH:MM (24h)' },
                            covers:        { type: 'integer', description: 'Number of guests' },
                            first_name:    { type: 'string', description: 'First name' },
                            last_name:     { type: 'string', description: 'Last name' },
                            phone:         { type: 'string', description: 'Caller phone number' },
                            language:      { type: 'string', enum: ['fr', 'en'], description: 'Locked language of the call: "fr" or "en"' }
                        },
                        required: ['restaurant_id', 'date', 'time', 'covers', 'first_name', 'last_name', 'phone', 'language']
                    }
                },
                server: { url: `${backendUrl}/api/vapi/create-booking`, timeoutSeconds: 10 }
            }
        ];
    }

    async createAssistant(restaurantData: any): Promise<any> {
        try {
            console.log(`🚀 Creating VAPI Assistant for ${restaurantData.name}...`);
            const response = await axios.post(
                `${VAPI_BASE_URL}/assistant`,
                this.buildAssistantPayload(restaurantData),
                { headers: this.headers }
            );
            console.log(`✅ Assistant created: ${response.data.id}`);
            return response.data;
        } catch (error: any) {
            console.error('Error creating VAPI assistant:', error.response?.data || error.message);
            throw error;
        }
    }

    async updateAssistant(assistantId: string, restaurantData: any): Promise<any> {
        try {
            console.log(`🔄 Updating VAPI Assistant ${assistantId}...`);
            const response = await axios.patch(
                `${VAPI_BASE_URL}/assistant/${assistantId}`,
                this.buildAssistantPayload(restaurantData),
                { headers: this.headers }
            );
            console.log(`✅ Assistant ${assistantId} updated`);
            return response.data;
        } catch (error: any) {
            if (error.response?.status === 404) {
                console.warn(`⚠️  Assistant ${assistantId} not found (404)`);
                return null;
            }
            console.error('❌ Error updating VAPI assistant:', error.response?.data || error.message);
            throw error;
        }
    }

    async checkAssistantExists(assistantId: string): Promise<boolean> {
        try {
            await axios.get(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: this.headers });
            return true;
        } catch (error: any) {
            if (error.response?.status === 404) return false;
            throw error;
        }
    }

    /**
     * Provisionne un numéro de téléphone VAPI pour un restaurant.
     *
     * Mode 'pool' (défaut) : cherche un numéro déjà acheté et libre dans le compte.
     * Mode 'dynamic'       : achat à la volée — NON IMPLÉMENTÉ pour l'instant, throw.
     *
     * @param assistantIdForCleanupOnFailure  Si fourni, l'assistant VAPI sera supprimé
     *   côté VAPI en cas d'échec ici. Évite les orphelins : assistant créé + payé,
     *   mais sans numéro lié → impossible de recevoir des appels.
     */
    async createPhoneNumber(
        restaurantId: string,
        restaurantName: string,
        assistantIdForCleanupOnFailure?: string
    ): Promise<any> {
        const mode = config.vapi.provisioningMode;
        try {
            if (mode === 'dynamic') {
                // Placeholder : l'achat à la volée via POST /phone-number n'est pas
                // encore implémenté. On échoue explicitement plutôt que de fallback
                // silencieusement sur le pool — pour qu'une erreur soit visible
                // immédiatement si quelqu'un active VAPI_PROVISIONING_MODE=dynamic.
                throw new Error('VAPI_PROVISIONING_MODE=dynamic is not implemented yet — keep "pool" or implement POST /phone-number.');
            }

            const response = await axios.get(`${VAPI_BASE_URL}/phone-number`, { headers: this.headers });
            const all: any[] = response.data || [];
            const available = all.find((p: any) => !p.assistantId && p.number);

            if (!available) {
                logger.error(
                    {
                        restaurantId,
                        restaurantName,
                        poolSize: all.length,
                        mode,
                    },
                    'VAPI pool exhausted — add phone numbers to the VAPI account or set VAPI_PROVISIONING_MODE=dynamic'
                );
                throw new Error('No available phone numbers in the VAPI pool.');
            }

            const serverUrl = `${process.env.BACKEND_URL}/api/vapi/assistant-config`;
            await axios.patch(`${VAPI_BASE_URL}/phone-number/${available.id}`, { serverUrl }, { headers: this.headers });
            console.log(`📞 Assigned: ${available.number} (${available.id})`);
            return available;
        } catch (error: any) {
            // Cleanup orphan : si on a créé un assistant juste avant et que l'attribution
            // du numéro échoue, on supprime l'assistant côté VAPI pour éviter un état
            // bancal (assistant en DB, déjà facturé, mais sans numéro).
            if (assistantIdForCleanupOnFailure) {
                try {
                    await this.deleteAssistant(assistantIdForCleanupOnFailure);
                    logger.warn(
                        { assistantId: assistantIdForCleanupOnFailure, restaurantId },
                        'Cleaned up orphan VAPI assistant after phone provisioning failure'
                    );
                } catch (cleanupErr: any) {
                    logger.error(
                        { assistantId: assistantIdForCleanupOnFailure, restaurantId, err: cleanupErr?.message },
                        'Failed to cleanup orphan VAPI assistant'
                    );
                }
            }
            console.error('Error assigning VAPI phone number:', error.response?.data || error.message);
            throw error;
        }
    }

    async linkAssistantToPhone(phoneNumberId: string, assistantId: string): Promise<any> {
        try {
            const serverUrl = `${process.env.BACKEND_URL}/api/vapi/assistant-config`;
            const response = await axios.patch(
                `${VAPI_BASE_URL}/phone-number/${phoneNumberId}`,
                { assistantId, serverUrl },
                { headers: this.headers }
            );
            console.log(`🔗 Phone ${phoneNumberId} linked to assistant ${assistantId}`);
            return response.data;
        } catch (error: any) {
            console.error('Error linking assistant to phone:', error.response?.data || error.message);
            throw error;
        }
    }

    async deletePhoneNumber(phoneNumberId: string): Promise<void> {
        try {
            await axios.delete(`${VAPI_BASE_URL}/phone-number/${phoneNumberId}`, { headers: this.headers });
        } catch (error: any) {
            console.error('Error deleting phone number:', error.response?.data || error.message);
            throw error;
        }
    }

    async deleteAssistant(assistantId: string): Promise<void> {
        try {
            await axios.delete(`${VAPI_BASE_URL}/assistant/${assistantId}`, { headers: this.headers });
        } catch (error: any) {
            console.error('Error deleting assistant:', error.response?.data || error.message);
            throw error;
        }
    }

    public formatOpeningHours(openingHours: any): string {
        if (!openingHours || typeof openingHours !== 'object') return '';
        const map: Record<string, string> = {
            monday: 'lundi', tuesday: 'mardi', wednesday: 'mercredi',
            thursday: 'jeudi', friday: 'vendredi', saturday: 'samedi', sunday: 'dimanche'
        };
        return Object.entries(map).map(([key, label]) => {
            const h = openingHours[key];
            return h?.open ? `${label}: ${h.from}–${h.to}` : `${label}: fermé`;
        }).join(', ');
    }
}

export default new VapiService();
