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

    // Prompt INLINÉ par restaurant (aucun {{placeholder}} : fiabilité totale, car
    // l'injection de variables par appel n'est pas garantie pour un assistant statique).
    // La logique de date/heure est DÉPORTÉE côté serveur (les outils résolvent le langage naturel).
    public buildSystemPrompt(r: any): string {
        const name = r?.name || 'le restaurant';
        const address = r?.address || '';
        const phone = r?.phone || '';
        const hours = this.formatOpeningHours(r?.opening_hours);
        const rid = r?.id || '';
        return `Tu es l'hôte/hôtesse IA de ${name}, propulsé par TableNow. Ton UNIQUE rôle : prendre des réservations de table par téléphone.

RESTAURANT
- Nom : ${name}
- Adresse : ${address}
- Téléphone (humain) : ${phone}
- Horaires : ${hours}
- restaurant_id : ${rid}  (transmets TOUJOURS cette valeur exacte aux outils)

LANGUE
- Verrouille la langue dès les premiers mots de l'appelant (français par défaut). Ne redemande jamais la langue.

DATE DU JOUR (Europe/Paris) : {{"now" | date: "%A %d %B %Y", "Europe/Paris"}} — heure : {{"now" | date: "%H:%M", "Europe/Paris"}}

CE QU'IL FAUT COLLECTER (bref, naturel, max 2 phrases par tour)
1) nombre de couverts
2) la date souhaitée
3) l'heure souhaitée
4) prénom et nom
5) numéro de rappel

DATES & HEURES
- En te basant sur la DATE DU JOUR ci-dessus, calcule la date demandée par l'appelant ("demain", "vendredi prochain", "le 25", "ce soir"…) et transmets-la aux outils au format AAAA-MM-JJ. L'heure au format 24h HH:MM.
- Confirme TOUJOURS la date complète à l'appelant avant de vérifier la disponibilité (ex : "vendredi 5 juin à 20h").
- Date ambiguë ("5/4") → demande de préciser le jour et le mois.
- Ne prononce jamais l'année à voix haute.

OUTILS
1) check_availability(restaurant_id, date AAAA-MM-JJ, time HH:MM, covers) — toujours avant d'annoncer qu'un créneau est libre.
2) create_booking(restaurant_id, date, time, covers, first_name, last_name, phone, language) — UNIQUEMENT après confirmation explicite du récapitulatif. language = "fr" ou "en".

DÉROULÉ
- Dès que tu as couverts + date + heure : appelle check_availability.
- Si disponible, récapitule : "[N] couverts, [jour date] à [heure], au nom de [prénom nom], rappel au [téléphone] — c'est bien ça ?"
- Sur un "oui" explicite, appelle create_booking puis relis la confirmation renvoyée par l'outil.
- Si indisponible, propose les créneaux alternatifs renvoyés par l'outil.

STYLE
- Téléphone : chaleureux, naturel, 2 phrases max. Reformule ce que tu as compris.
- Modification/annulation ou hors-sujet (menu, prix…) → "Pour cela, appelez directement le restaurant au ${phone}."`;
    }

    private buildAssistantPayload(restaurantData: any, toolIds: string[] = []): object {
        const serverUrl = this.getServerUrl();
        const name = restaurantData?.name || 'le restaurant';
        return {
            name: `${name} — TableNow`,
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
                maxTokens: 150,
                messages: [
                    { role: 'system', content: this.buildSystemPrompt(restaurantData) }
                ],
                // Outils référencés par ID (entités Tool) : c'est ce que le dashboard
                // Vapi reconnaît comme « sélectionnés ». Les définitions inline (model.tools)
                // ne sont PAS prises en compte par le dashboard.
                toolIds
            },
            voice: {
                provider: 'openai',
                voiceId: 'shimmer',
                model: 'gpt-4o-mini-tts'
            },
            firstMessage: `Bonjour et bienvenue chez ${name}, comment puis-je vous aider ?`,
            endCallMessage: 'Bonne journée, au revoir !',
            // server.secret -> VAPI envoie le header X-Vapi-Secret sur les webhooks,
            // vérifié par /api/vapi/webhook (authentification simple par jeton partagé).
            server: {
                url: serverUrl,
                secret: process.env.VAPI_WEBHOOK_SECRET,
            },
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
        return `You are the AI receptionist at {{restaurantName}}, powered by TableNow. Your only job is taking table reservations.

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
                    description: 'Vérifie la disponibilité d\'une table. À appeler avant d\'annoncer qu\'un créneau est libre. Le serveur résout lui-même la date/heure.',
                    parameters: {
                        type: 'object',
                        properties: {
                            restaurant_id: { type: 'string', description: 'restaurant_id fourni dans le prompt (transmettre tel quel)' },
                            date:          { type: 'string', description: 'Date AAAA-MM-JJ, calculée à partir de la DATE DU JOUR fournie dans le prompt' },
                            time:          { type: 'string', description: 'Heure HH:MM (24h)' },
                            covers:        { type: 'integer', description: 'Nombre de couverts' }
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
                    description: 'Crée la réservation confirmée. À appeler UNIQUEMENT après confirmation explicite du récapitulatif. Le serveur résout lui-même la date/heure.',
                    parameters: {
                        type: 'object',
                        properties: {
                            restaurant_id: { type: 'string', description: 'restaurant_id fourni dans le prompt (transmettre tel quel)' },
                            date:          { type: 'string', description: 'Date AAAA-MM-JJ, calculée à partir de la DATE DU JOUR fournie dans le prompt' },
                            time:          { type: 'string', description: 'Heure HH:MM (24h)' },
                            covers:        { type: 'integer', description: 'Nombre de couverts' },
                            first_name:    { type: 'string', description: 'Prénom' },
                            last_name:     { type: 'string', description: 'Nom' },
                            phone:         { type: 'string', description: 'Numéro de rappel de l\'appelant' },
                            language:      { type: 'string', enum: ['fr', 'en'], description: 'Langue verrouillée de l\'appel : "fr" ou "en"' }
                        },
                        required: ['restaurant_id', 'date', 'time', 'covers', 'first_name', 'last_name', 'phone', 'language']
                    }
                },
                server: { url: `${backendUrl}/api/vapi/create-booking`, timeoutSeconds: 10 }
            }
        ];
    }

    /**
     * Garantit l'existence des entités Tool Vapi (check_availability, create_booking)
     * pointant vers le BON backend, et renvoie leurs IDs. Les outils sont identiques
     * pour tous les restaurants (restaurant_id transmis en paramètre) → partagés.
     * Crée s'ils manquent, met à jour (URL/schéma) s'ils existent.
     */
    async ensureToolIds(): Promise<string[]> {
        const defs = this.generateTools(); // [{ type:'function', function, server }, ...]
        let existing: any[] = [];
        try {
            const r = await axios.get(`${VAPI_BASE_URL}/tool`, { headers: this.headers });
            existing = Array.isArray(r.data) ? r.data : [];
        } catch (e: any) {
            console.warn('Could not list VAPI tools:', e.response?.data || e.message);
        }

        const ids: string[] = [];
        for (const def of defs) {
            const name = (def as any).function?.name;
            const match = existing.find((t: any) => t?.function?.name === name);
            try {
                if (match) {
                    await axios.patch(
                        `${VAPI_BASE_URL}/tool/${match.id}`,
                        { function: (def as any).function, server: (def as any).server },
                        { headers: this.headers }
                    );
                    ids.push(match.id);
                } else {
                    const created = await axios.post(`${VAPI_BASE_URL}/tool`, def, { headers: this.headers });
                    ids.push(created.data.id);
                }
            } catch (e: any) {
                console.error(`Tool ensure failed for ${name}:`, e.response?.data || e.message);
                throw e;
            }
        }
        return ids;
    }

    async createAssistant(restaurantData: any): Promise<any> {
        try {
            console.log(`🚀 Creating VAPI Assistant for ${restaurantData.name}...`);
            const toolIds = await this.ensureToolIds();
            const response = await axios.post(
                `${VAPI_BASE_URL}/assistant`,
                this.buildAssistantPayload(restaurantData, toolIds),
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
            const toolIds = await this.ensureToolIds();
            const response = await axios.patch(
                `${VAPI_BASE_URL}/assistant/${assistantId}`,
                this.buildAssistantPayload(restaurantData, toolIds),
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
        if (!openingHours) return '';
        const labels = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

        // Format réel de l'UI (HoraireSettings) : tableau de 7 jours, index 0=lundi…6=dimanche,
        // chaque jour = { enabled, services: [{ name, start, end, covers }] }.
        if (Array.isArray(openingHours)) {
            return openingHours.map((day: any, i: number) => {
                const label = labels[i] || `jour ${i + 1}`;
                if (day?.enabled && Array.isArray(day.services) && day.services.length) {
                    const svc = day.services
                        .filter((s: any) => s?.start && s?.end)
                        .map((s: any) => `${s.start}-${s.end}`)
                        .join(' et ');
                    return svc ? `${label}: ${svc}` : `${label}: fermé`;
                }
                return `${label}: fermé`;
            }).join(', ');
        }

        // Repli : ancien format objet { monday: { open, from, to }, ... }
        if (typeof openingHours === 'object') {
            const map: Record<string, string> = {
                monday: 'lundi', tuesday: 'mardi', wednesday: 'mercredi',
                thursday: 'jeudi', friday: 'vendredi', saturday: 'samedi', sunday: 'dimanche'
            };
            return Object.entries(map).map(([key, label]) => {
                const h = (openingHours as any)[key];
                return h?.open ? `${label}: ${h.from}–${h.to}` : `${label}: fermé`;
            }).join(', ');
        }
        return '';
    }
}

export default new VapiService();
