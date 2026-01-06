const axios = require('axios');
const path = require('path');
const envPath = path.resolve(__dirname, '.env');
require('dotenv').config({ path: envPath });

const VAPI_BASE_URL = 'https://api.vapi.ai';

async function inspectAssistant() {
    try {
        console.log('🔍 Listing all VAPI Assistants...');

        const response = await axios.get(
            `${VAPI_BASE_URL}/assistant`,
            {
                headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` }
            }
        );

        const assistants = response.data;
        console.log(`Found ${assistants.length} assistants.`);

        for (const assistant of assistants) {
            console.log('\n------------------------------------------------');
            console.log('Name:', assistant.name);
            console.log('ID:', assistant.id);
            console.log('Server URL:', assistant.serverUrl);

            if (assistant.serverUrl && assistant.serverUrl.includes('localhost')) {
                console.error('❌ ERROR: Server URL is localhost!');
            } else if (assistant.serverUrl && assistant.serverUrl.includes('ngrok')) {
                console.log('✅ SUCCESS: Server URL is ngrok.');
            }
        }

    } catch (error) {
        console.error('❌ Error inspecting assistants:', error.response?.data || error.message);
    }

    try {
        console.log('\n🔍 Listing all VAPI Phone Numbers...');
        const response = await axios.get(
            `${VAPI_BASE_URL}/phone-number`,
            {
                headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` }
            }
        );

        const phones = response.data;
        console.log(`Found ${phones.length} active phone numbers.`);

        for (const phone of phones) {
            console.log('\n------------------------------------------------');
            console.log('Number:', phone.number);
            console.log('ID:', phone.id);
            console.log('Assistant ID:', phone.assistantId);
            console.log('Server URL:', phone.serverUrl || '(None - uses assistant default)');

            if (phone.serverUrl && phone.serverUrl.includes('localhost')) {
                console.error('❌ ERROR: Phone Server URL is localhost!');
            } else if (phone.serverUrl && phone.serverUrl.includes('ngrok')) {
                console.log('✅ SUCCESS: Phone Server URL is ngrok.');
            }
        }
    } catch (error) {
        console.error('❌ Error inspecting phones:', error.response?.data || error.message);
    }
}

inspectAssistant();
