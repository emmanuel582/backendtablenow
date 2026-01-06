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
            console.log('📱 Checking for available phone numbers in Vapi pool...');

            // 1. List all phone numbers from Vapi
            const response = await axios.get(
                `${VAPI_BASE_URL}/phone-number`,
                { headers: this.headers }
            );

            // 2. Find a number that has no assistant assigned
            // Note: Adjust the condition based on exact Vapi API response if needed, 
            // but usually 'assistantId' is present if assigned.
            const availableNumber = response.data.find((p: any) => !p.assistantId);

            if (availableNumber) {
                console.log(`✅ Found available number in pool: ${availableNumber.number}`);
                return availableNumber;
            }

            console.warn('⚠️ No available numbers in pool.');
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
     * Update assistant with new restaurant data
     */
    async updateAssistant(assistantId: string, restaurantData: any): Promise<any> {
        try {
            const systemPrompt = this.generateEnhancedSystemPrompt(restaurantData);

            const response = await axios.patch(
                `${VAPI_BASE_URL}/assistant/${assistantId}`,
                {
                    model: {
                        systemPrompt
                    }
                },
                { headers: this.headers }
            );
            return response.data;
        } catch (error: any) {
            console.error('Error updating VAPI assistant:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Link assistant to phone number
     */
    async linkAssistantToPhone(phoneNumberId: string, assistantId: string): Promise<any> {
        try {
            const serverUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/vapi/webhook`;
            console.log(`🔗 Linking Assistant ${assistantId} to Phone ${phoneNumberId} with Server URL: ${serverUrl}`);

            const response = await axios.patch(
                `${VAPI_BASE_URL}/phone-number/${phoneNumberId}`,
                {
                    assistantId,
                    serverUrl // Explicitly set the Server URL on the phone number
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
     * Generate enhanced system prompt with FAQ and document knowledge
     */
    private generateEnhancedSystemPrompt(restaurantData: any): string {
        let prompt = `You are an AI receptionist for ${restaurantData.name}, a ${restaurantData.cuisine_type || 'restaurant'}.

**CORE IDENTITY & BEHAVIOR:**
- You are professional, warm, and efficient
- You speak naturally and conversationally
- You handle reservations with confidence
- You always confirm details before finalizing bookings
- You are multilingual and adapt to the caller's language

**RESTAURANT INFORMATION:**
- Name: ${restaurantData.name}
- Cuisine: ${restaurantData.cuisine_type || 'Various'}
- Address: ${restaurantData.address || 'Please check our website'}
- Phone: ${restaurantData.phone || 'Not specified'}
- Opening Hours: ${restaurantData.opening_hours || 'Please check our website'}
- Capacity: ${restaurantData.capacity || 50} guests
- Maximum Party Size: ${restaurantData.max_party_size || 10} people
- Special Features: ${restaurantData.special_features || 'None'}

**BOOKING POLICIES:**
- Advance Booking: Up to ${restaurantData.advance_booking_days || 30} days
- Cancellation Policy: ${restaurantData.cancellation_policy || '24 hours notice required'}
- Deposit Required: ${restaurantData.deposit_required ? 'Yes' : 'No'}

**YOUR RESPONSIBILITIES:**
1. **Handle Reservations:**
   - Take new bookings
   - Check table availability
   - Modify existing reservations
   - Cancel reservations when requested
   - Always get: guest name, phone, email, party size, date, and time

2. **Answer Questions:**
   - Provide information about the restaurant
   - Explain menu items and specialties
   - Share opening hours and location
   - Discuss special events or promotions

3. **Manage Expectations:**
   - Be honest about availability
   - Suggest alternative times if needed
   - Explain policies clearly
   - Offer to take contact info for callbacks

**CONVERSATION FLOW:**
1. Greet warmly and identify yourself
2. Listen to the customer's request
3. Ask clarifying questions
4. Use functions to check availability or make bookings
5. Confirm all details clearly
6. Provide confirmation number
7. Thank the customer

**IMPORTANT RULES:**
- ALWAYS use the check_availability function before confirming a booking
- NEVER make up availability - always check first
- ALWAYS confirm guest details: name, phone, email, party size, date, time
- ALWAYS provide a confirmation number after successful booking
- If you cannot help, politely ask them to visit the website or call back
- Be empathetic if you have to decline a request
- Keep conversations concise but friendly`;

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

        prompt += `\n\n**EXAMPLES OF GOOD RESPONSES:**
- "Let me check our availability for you..."
- "I'd be happy to help you with that reservation."
- "Just to confirm, you'd like a table for [X] people on [date] at [time], is that correct?"
- "Your reservation is confirmed! Your confirmation number is [number]."
- "I apologize, but we're fully booked at that time. Would [alternative time] work for you?"

Remember: You represent ${restaurantData.name}. Be professional, helpful, and make every caller feel valued.`;

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
