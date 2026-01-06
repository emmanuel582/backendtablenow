import axios from 'axios';

const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_BASE_URL = 'https://api.vapi.ai';

export class VapiService {
    private headers = {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
    };

    /**
     * Assign an available phone number from the Vapi pool
     */
    async createPhoneNumber(restaurantId: string, restaurantName: string): Promise<any> {
        try {
            const response = await axios.get(
                `${VAPI_BASE_URL}/phone-number`,
                { headers: this.headers }
            );

            const availableNumber = response.data.find((p: any) => !p.assistantId);

            if (availableNumber) {
                return availableNumber;
            }

            throw new Error('No available phone numbers in the Vapi pool.');
        } catch (error: any) {
            console.error('Error assigning VAPI phone number:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Create AI assistant for restaurant with enhanced knowledge base
     */
    async createAssistant(restaurantData: any): Promise<any> {
        try {
            const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;
            const systemPrompt = this.generateEnhancedSystemPrompt(restaurantData);

            console.log(`🚀 Creating VAPI Assistant for ${restaurantData.name}...`);
            console.log(`🌍 Webhook URL: ${serverUrl}`);

            const response = await axios.post(
                `${VAPI_BASE_URL}/assistant`,
                {
                    name: `${restaurantData.name} AI Receptionist`,
                    model: {
                        provider: 'openai',
                        model: 'gpt-4-turbo',
                        temperature: 0.1, // Faster, more deterministic tool calling
                        systemPrompt
                    },
                    voice: {
                        provider: 'openai',
                        voiceId: 'alloy'
                    },
                    firstMessage: `Hello! Thank you for calling ${restaurantData.name}. I'm your AI assistant. How may I help you today?`,
                    serverUrl,
                    tools: this.generateTools(), // New tools-based structure
                    endCallMessage: `Thank you for calling ${restaurantData.name}. Have a wonderful day!`,
                    recordingEnabled: true,
                    silenceTimeoutSeconds: 30,
                    maxDurationSeconds: 600
                },
                { headers: this.headers }
            );
            return response.data;
        } catch (error: any) {
            console.error('Error creating VAPI assistant:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Update assistant with new restaurant data and sync tools
     */
    async updateAssistant(assistantId: string, restaurantData: any): Promise<any> {
        try {
            const systemPrompt = this.generateEnhancedSystemPrompt(restaurantData);
            const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;
            const tools = this.generateTools();

            console.log(`🔄 Updating VAPI Assistant ${assistantId}...`);
            console.log(`🔗 Target Server URL: ${serverUrl}`);
            console.log(`🛠️  Tools to sync: ${tools.length} functions`);

            const payload = {
                model: {
                    provider: 'openai',
                    model: 'gpt-4-turbo',
                    systemPrompt,
                    temperature: 0.1
                },
                serverUrl,
                tools // Force sync newest tool definitions
            };

            console.log('📤 Sending payload to Vapi:', JSON.stringify(payload, null, 2));

            const response = await axios.patch(
                `${VAPI_BASE_URL}/assistant/${assistantId}`,
                payload,
                { headers: this.headers }
            );

            console.log(`✅ VAPI Assistant ${assistantId} updated successfully`);
            console.log('📥 Vapi Response:', JSON.stringify(response.data, null, 2));
            return response.data;
        } catch (error: any) {
            const errorData = error.response?.data;
            const errorStatus = error.response?.status;
            console.error('❌ Error updating VAPI assistant');
            console.error('Status Code:', errorStatus);
            console.error('Error Details:', JSON.stringify(errorData || error.message, null, 2));
            console.error('Full Error:', error);
            throw error;
        }
    }

    /**
     * Link assistant to phone number
     */
    async linkAssistantToPhone(phoneNumberId: string, assistantId: string): Promise<any> {
        try {
            const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;
            const response = await axios.patch(
                `${VAPI_BASE_URL}/phone-number/${phoneNumberId}`,
                {
                    assistantId,
                    serverUrl
                },
                { headers: this.headers }
            );
            return response.data;
        } catch (error: any) {
            console.error('Error linking assistant to phone:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Generate enhanced system prompt
     */
    private generateEnhancedSystemPrompt(restaurantData: any): string {
        return `You are a professional AI Receptionist for ${restaurantData.name}. 

**CRITICAL RULES:**
- You are strictly an INTERFACE for the restaurant's booking system. Reach out to the backend for EVERYTHING.
- **NEVER Hallucinate:** If a customer doesn't specify a time, date, or party size, you MUST ask for it. NEVER assume "tonight" or "8:25 PM" unless they said it.
- **NEVER Invent Numbers:** Confirmation numbers MUST only come from the 'create_booking' tool.
- **Tool-First:** Call 'check_availability' the VERY SECOND you have a Date, Time, and Party Size. Do not wait for a Name or Email to check if a table is free.

**CONVERSATIONAL FLOW:**
1. **Greet:** Identify yourself and the restaurant.
2. **Collect Minimum Info:** You need Date, Time, and Party Size to check availability.
3. **Trigger Tool immediately:** As soon as you have those 3 pieces, call 'check_availability'. 
   - While the tool runs, the system will play a waiting message. Stay silent.
4. **Handle Result:** 
   - If Available: "Good news, we have space! To finalize the booking, I just need your name and email."
   - If Unavailable: Suggest an alternative based on the response.
5. **Finalize:** Summarize the details and call 'create_booking'. 

**GUIDELINES:**
- **Caller ID:** You already have the phone number. Say: "I'll put this under the number you're calling from."
- **Natural Speech:** Don't repeat what the user just said back to them in a robotic way. Just move to the next step.
- **No Fillers:** NEVER say "Let me check that for you" or "One moment" in your text. The system handles these transitions.

**RESTAURANT INFO:**
- Name: ${restaurantData.name}
- Cuisine: ${restaurantData.cuisine_type || 'Various'}
- Address: ${restaurantData.address || 'Check website'}
- Hours: ${restaurantData.opening_hours || 'Check website'}
- Max Party Size: ${restaurantData.max_party_size || 10} guests

Note: If a tool returns an error, apologize and say you're having technical trouble.`;
    }

    /**
     * Generate modern VAPI Tool definitions
     */
    private generateTools(): any[] {
        const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;

        return [
            {
                type: 'function',
                async: false,
                messages: [{ type: 'request-start', content: 'Checking availability for you...' }],
                function: {
                    name: 'check_availability',
                    description: 'Check if tables are available for a specific date, time, and party size',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
                            time: { type: 'string', description: 'Time in HH:MM format (24-hour)' },
                            partySize: { type: 'number', description: 'Number of guests' }
                        },
                        required: ['date', 'time', 'partySize']
                    }
                },
                server: {
                    url: serverUrl
                }
            },
            {
                type: 'function',
                async: false,
                messages: [{ type: 'request-start', content: 'Confirming your reservation...' }],
                function: {
                    name: 'create_booking',
                    description: 'Create a new reservation',
                    parameters: {
                        type: 'object',
                        properties: {
                            guestName: { type: 'string', description: 'Full name' },
                            guestEmail: { type: 'string', description: 'Email address' },
                            guestPhone: { type: 'string', description: 'Phone number' },
                            date: { type: 'string', description: 'Date YYYY-MM-DD' },
                            time: { type: 'string', description: 'Time HH:MM' },
                            partySize: { type: 'number', description: 'Guests' },
                            specialRequests: { type: 'string', description: 'Any requests' }
                        },
                        required: ['guestName', 'guestPhone', 'date', 'time', 'partySize']
                    }
                },
                server: {
                    url: serverUrl
                }
            },
            {
                type: 'function',
                async: false,
                messages: [{ type: 'request-start', content: 'Updating your details...' }],
                function: {
                    name: 'update_booking',
                    description: 'Update an existing reservation',
                    parameters: {
                        type: 'object',
                        properties: {
                            confirmationNumber: { type: 'string', description: 'Booking confirmation number' },
                            date: { type: 'string', description: 'New date in YYYY-MM-DD format' },
                            time: { type: 'string', description: 'New time in HH:MM format' },
                            partySize: { type: 'number', description: 'New party size' }
                        },
                        required: ['confirmationNumber']
                    }
                },
                server: {
                    url: serverUrl
                }
            },
            {
                type: 'function',
                async: false,
                messages: [{ type: 'request-start', content: 'Cancelling your booking...' }],
                function: {
                    name: 'cancel_booking',
                    description: 'Cancel a reservation',
                    parameters: {
                        type: 'object',
                        properties: {
                            confirmationNumber: { type: 'string', description: 'Booking confirmation number' }
                        },
                        required: ['confirmationNumber']
                    }
                },
                server: {
                    url: serverUrl
                }
            },
            {
                type: 'function',
                async: false,
                messages: [{ type: 'request-start', content: 'One moment, checking our info...' }],
                function: {
                    name: 'answer_question',
                    description: 'Answer questions using restaurant docs.',
                    parameters: {
                        type: 'object',
                        properties: {
                            question: { type: 'string', description: 'Customer question' }
                        },
                        required: ['question']
                    }
                },
                server: {
                    url: serverUrl
                }
            }
        ];
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
}

export default new VapiService();
