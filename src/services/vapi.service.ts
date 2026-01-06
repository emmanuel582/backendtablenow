import axios from 'axios';
import fs from 'fs';

const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_BASE_URL = 'https://api.vapi.ai';

export class VapiService {
    private headers = {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
    };

    /**
     * Assign an available phone number from the Vapi pool
     * Looks for existing numbers in Vapi that don't have an assistant assigned
     */
    async createPhoneNumber(restaurantId: string, restaurantName: string): Promise<any> {
        try {
            // List all phone numbers from Vapi
            const response = await axios.get(
                `${VAPI_BASE_URL}/phone-number`,
                { headers: this.headers }
            );

            // 2. Find a number that has no assistant assigned
            // Note: Adjust the condition based on exact Vapi API response if needed, 
            // but usually 'assistantId' is present if assigned.
            const availableNumber = response.data.find((p: any) => !p.assistantId);

            if (availableNumber) {
                return availableNumber;
            }

            throw new Error('No available phone numbers in the Vapi pool. Please import more numbers via the Vapi Dashboard.');

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
            const systemPrompt = this.generateEnhancedSystemPrompt(restaurantData);
            const functions = this.generateFunctions();

            const response = await axios.post(
                `${VAPI_BASE_URL}/assistant`,
                {
                    name: `${restaurantData.name} AI Receptionist`,
                    model: {
                        provider: 'openai',
                        model: 'gpt-4-turbo',
                        temperature: 0.7,
                        systemPrompt,
                        functions
                    },
                    voice: {
                        provider: 'openai',
                        voiceId: 'alloy' // Professional, neutral voice
                    },
                    firstMessage: `Hello! Thank you for calling ${restaurantData.name}. I'm your AI assistant. How may I help you today?`,
                    serverUrl: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`,
                    endCallMessage: `Thank you for calling ${restaurantData.name}. Have a wonderful day!`,
                    endCallPhrases: ['goodbye', 'bye', 'thank you bye', 'that\'s all'],
                    recordingEnabled: true,
                    silenceTimeoutSeconds: 30,
                    maxDurationSeconds: 600, // 10 minutes max
                    backgroundSound: 'office'
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
     * Update assistant with new restaurant data and sync server URL
     */
    async updateAssistant(assistantId: string, restaurantData: any): Promise<any> {
        try {
            const systemPrompt = this.generateEnhancedSystemPrompt(restaurantData);
            const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;

            console.log(`🔄 Updating VAPI Assistant ${assistantId}...`);
            console.log(`🔗 Target Server URL: ${serverUrl}`);

            // Construct payload with required model fields to satisfy validation
            const payload = {
                model: {
                    provider: 'openai',
                    model: 'gpt-4-turbo',
                    systemPrompt
                },
                serverUrl // Update the webhook URL
            };

            const response = await axios.patch(
                `${VAPI_BASE_URL}/assistant/${assistantId}`,
                payload,
                { headers: this.headers }
            );

            console.log(`✅ VAPI Assistant ${assistantId} updated successfully`);
            return response.data;
        } catch (error: any) {
            const errorData = error.response?.data;
            console.error('❌ Error updating VAPI assistant:', JSON.stringify(errorData || error.message, null, 2));
            throw error;
        }
    }

    /**
     * Link assistant to phone number and update server URL
     */
    async linkAssistantToPhone(phoneNumberId: string, assistantId: string): Promise<any> {
        try {
            const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;

            console.log(`🔗 Linking Assistant ${assistantId} to Phone ${phoneNumberId}...`);
            console.log(`🌍 Webhook URL: ${serverUrl}`);

            const response = await axios.patch(
                `${VAPI_BASE_URL}/phone-number/${phoneNumberId}`,
                {
                    assistantId,
                    serverUrl // Explicitly set/update the Server URL on the phone number
                },
                { headers: this.headers }
            );
            return response.data;
        } catch (error: any) {
            const errorData = error.response?.data;
            console.error('❌ Error linking assistant to phone:', JSON.stringify(errorData || error.message, null, 2));
            throw error;
        }
    }

    /**
     * Generate enhanced system prompt with FAQ and document knowledge
     */
    private generateEnhancedSystemPrompt(restaurantData: any): string {
        let prompt = `You are a professional AI Receptionist for ${restaurantData.name}. 

**CRITICAL CHARACTERISTICS:**
- You are strictly an INTERFACE. You have NO KNOWLEDGE of the restaurant's actual schedule or table availability. 
- You MUST call functions (\`check_availability\`, \`create_booking\`) to get real data. 
- NEVER hallucinate availability. If a function doesn't return a result, tell the caller you're having technical trouble.
- NEVER invent confirmation numbers. Confirmation numbers ONLY come from the \`create_booking\` function.

**CONVERSATIONAL GUIDELINES:**
- Speak naturally. Don't sound like a robot reading a list.
- **Caller ID:** You already have the caller's phone number. Do NOT ask for it. Instead, say: "I'll put the reservation under the number you're calling from."
- **Efficiency:** If the user gives you everything (Name, Time, Date, Guests) in one go, call the tool immediately. Don't ask for things one by one if they already said them.

**STEP-BY-STEP BOOKING LOGIC:**
1. **Gather Info:** You need Name, Email, Date, Time, and Party Size.
2. **Check Availability FIRST:** As soon as you have Date, Time, and Party Size, call \`check_availability\`. 
   - Wait for the function response. 
   - If available, proceed. If not, suggest the nearest alternative based on the restaurant's opening hours.
3. **Confirm & Create:** Before calling \`create_booking\`, summarize the details to the caller: "Perfect, that's a table for 4 on Friday at 7 PM for John Smith. Shall I go ahead and book that?"
4. **Finalize:** After the caller confirms, call \`create_booking\`. Give them the CONFIRMATION NUMBER returned by the function.

**RESTAURANT KNOWLEDGE:**
- Name: ${restaurantData.name}
- Cuisine: ${restaurantData.cuisine_type || 'Various'}
- Address: ${restaurantData.address || 'Check website'}
- Opening Hours: ${restaurantData.opening_hours || 'Check website'}
- Max Party Size: ${restaurantData.max_party_size || 10} guests

**RULES:**
- If they ask a question about the menu or policies, use the \`answer_question\` tool.
- If you reach a dead end, politely offer to have a human manager call them back.
- Keep responses under 2 sentences unless listing options.`;

        // Add FAQ knowledge if available
        if (restaurantData.faq_text) {
            prompt += `\n\n**FREQUENTLY ASKED QUESTIONS:**\n${restaurantData.faq_text}`;
        }

        // Add document references if available
        if (restaurantData.menu_url || restaurantData.faq_document_url || restaurantData.policies_url) {
            prompt += `\n\n**ADDITIONAL RESOURCES:**`;
            if (restaurantData.menu_url) {
                prompt += `\n- Menu: Available (reference for menu questions)`;
            }
            if (restaurantData.faq_document_url) {
                prompt += `\n- FAQ Document: Available (reference for detailed questions)`;
            }
            if (restaurantData.policies_url) {
                prompt += `\n- Policies: Available (reference for policy questions)`;
            }
        }

        prompt += `\n\nRemember: You represent ${restaurantData.name}. Be helpful but trust the TOOLS, not your intuition.`;

        return prompt;
    }

    /**
     * Generate function definitions for VAPI
     */
    private generateFunctions(): any[] {
        return [
            {
                name: 'check_availability',
                description: 'Check if tables are available for a specific date, time, and party size',
                parameters: {
                    type: 'object',
                    properties: {
                        date: {
                            type: 'string',
                            description: 'Date in YYYY-MM-DD format'
                        },
                        time: {
                            type: 'string',
                            description: 'Time in HH:MM format (24-hour)'
                        },
                        partySize: {
                            type: 'number',
                            description: 'Number of guests'
                        }
                    },
                    required: ['date', 'time', 'partySize']
                }
            },
            {
                name: 'create_booking',
                description: 'Create a new reservation',
                parameters: {
                    type: 'object',
                    properties: {
                        guestName: {
                            type: 'string',
                            description: 'Full name of the guest'
                        },
                        guestEmail: {
                            type: 'string',
                            description: 'Email address of the guest'
                        },
                        guestPhone: {
                            type: 'string',
                            description: 'Phone number of the guest'
                        },
                        date: {
                            type: 'string',
                            description: 'Date in YYYY-MM-DD format'
                        },
                        time: {
                            type: 'string',
                            description: 'Time in HH:MM format (24-hour)'
                        },
                        partySize: {
                            type: 'number',
                            description: 'Number of guests'
                        },
                        specialRequests: {
                            type: 'string',
                            description: 'Any special requests or dietary requirements'
                        }
                    },
                    required: ['guestName', 'guestPhone', 'date', 'time', 'partySize']
                }
            },
            {
                name: 'update_booking',
                description: 'Update an existing reservation',
                parameters: {
                    type: 'object',
                    properties: {
                        confirmationNumber: {
                            type: 'string',
                            description: 'Booking confirmation number'
                        },
                        date: {
                            type: 'string',
                            description: 'New date in YYYY-MM-DD format'
                        },
                        time: {
                            type: 'string',
                            description: 'New time in HH:MM format (24-hour)'
                        },
                        partySize: {
                            type: 'number',
                            description: 'New number of guests'
                        }
                    },
                    required: ['confirmationNumber']
                }
            },
            {
                name: 'cancel_booking',
                description: 'Cancel a reservation',
                parameters: {
                    type: 'object',
                    properties: {
                        confirmationNumber: {
                            type: 'string',
                            description: 'Booking confirmation number'
                        }
                    },
                    required: ['confirmationNumber']
                }
            },
            {
                name: 'answer_question',
                description: 'Answer questions about the restaurant using uploaded documents (menu, FAQ, policies). Use this when customers ask about menu items, restaurant policies, special features, or any detailed information.',
                parameters: {
                    type: 'object',
                    properties: {
                        question: {
                            type: 'string',
                            description: 'The customer\'s question'
                        }
                    },
                    required: ['question']
                }
            }
        ];
    }

    /**
     * Delete phone number
     */
    async deletePhoneNumber(phoneNumberId: string): Promise<void> {
        try {
            await axios.delete(
                `${VAPI_BASE_URL}/phone-number/${phoneNumberId}`,
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error deleting phone number:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Delete assistant
     */
    async deleteAssistant(assistantId: string): Promise<void> {
        try {
            await axios.delete(
                `${VAPI_BASE_URL}/assistant/${assistantId}`,
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error deleting assistant:', error.response?.data || error.message);
            throw error;
        }
    }
}

export default new VapiService();
