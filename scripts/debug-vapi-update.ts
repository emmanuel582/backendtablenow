
import axios from 'axios';

const VAPI_BASE_URL = 'https://api.vapi.ai';
const ASSISTANT_ID = '35edd0e8-79db-4078-93d9-1585b84b887d';
const VAPI_API_KEY = 'fad5f72a-178a-4af4-85c1-4f367c35170b'; // Taken from your logs
const SERVER_URL = 'https://backendtablenow.onrender.com/api/vapi/webhook';

const cleanTools = [
    {
        type: 'function',
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
        }
    },
    {
        type: 'function',
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
        }
    },
    {
        type: 'function',
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
        }
    },
    {
        type: 'function',
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
        }
    },
    {
        type: 'function',
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
        }
    }
];

async function testVapiUpdate() {
    try {
        console.log('🔄 Testing VAPI Assistant Update with CLEAN payload...');

        const payload = {
            model: {
                provider: 'openai',
                model: 'gpt-4-turbo',
                systemPrompt: `You are a professional AI Receptionist for BELLEFOOD. 

**CRITICAL RULES:**
- You are strictly an INTERFACE for the restaurant's booking system. Reach out to the backend for EVERYTHING.
- **NEVER Hallucinate:** If a customer doesn't specify a time, date, or party size, you MUST ask for it.
- **NEVER Invent Numbers:** Confirmation numbers MUST only come from the 'create_booking' tool.
- **Tool-First:** Call 'check_availability' the VERY SECOND you have a Date, Time, and Party Size.

**CONVERSATIONAL FLOW:**
1. **Greet:** Identify yourself and the restaurant.
2. **Collect Minimum Info:** You need Date, Time, and Party Size to check availability.
3. **Trigger Tool immediately:** As soon as you have those 3 pieces, call 'check_availability'. 
   - While the tool runs, the system will play a waiting message. Stay silent.
4. **Handle Result:** 
   - If Available: "Good news, we have space! To finalize the booking, I just need your name and email."
   - If Unavailable: Suggest an alternative based on the response.
5. **Finalize:** Summarize the details and call 'create_booking'. 

**RESTAURANT INFO:**
- Name: BELLEFOOD
- Cuisine: italian,french
- Address: Oluseyi
- Hours: Check website
- Max Party Size: 10 guests

Note: If a tool returns an error, apologize and say you're having technical trouble.`,
                temperature: 0.1,
                tools: cleanTools
            },
            serverUrl: SERVER_URL
        };

        console.log('📤 Sending payload...');
        const response = await axios.patch(
            `${VAPI_BASE_URL}/assistant/${ASSISTANT_ID}`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${VAPI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ SUCCESS! VAPI accepted the payload.');
        console.log('📥 Response:', JSON.stringify(response.data, null, 2));

    } catch (error: any) {
        console.error('❌ FAIL! VAPI rejected the payload.');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error:', error.message);
        }
    }
}

testVapiUpdate();
