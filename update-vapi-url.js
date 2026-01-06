const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const path = require('path');
const envPath = path.resolve(__dirname, '.env');
require('dotenv').config({ path: envPath });

console.log('Loading .env from:', envPath);
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env file');
    process.exit(1);
}

// FORCE USE OF NGROK URL IF ENV IS NOT UPDATED YET
const NEW_SERVER_URL = 'https://25100e895fd8.ngrok-free.app/api/vapi/webhook';
const VAPI_BASE_URL = 'https://api.vapi.ai';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function updateAllAssistants() {
    try {
        console.log('🔄 Fetching active assistants from database...');

        // Get all restaurants with Vapi assistants
        const { data: restaurants, error } = await supabase
            .from('restaurants')
            .select('name, vapi_assistant_id, vapi_phone_id')
            .not('vapi_assistant_id', 'is', null);

        if (error) throw error;

        console.log(`Found ${restaurants.length} restaurants to update.`);

        for (const restaurant of restaurants) {
            console.log(`\n🔹 Updating ${restaurant.name}...`);

            // 1. Update Assistant Server URL
            if (restaurant.vapi_assistant_id) {
                try {
                    await axios.patch(
                        `${VAPI_BASE_URL}/assistant/${restaurant.vapi_assistant_id}`,
                        {
                            serverUrl: NEW_SERVER_URL
                        },
                        {
                            headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` }
                        }
                    );
                    console.log(`   ✅ Assistant updated with new Server URL`);
                } catch (err) {
                    console.error(`   ❌ Failed to update assistant: ${err.message}`);
                }
            }

            // 2. Update Phone Number Server URL (just in case)
            if (restaurant.vapi_phone_id) {
                try {
                    await axios.patch(
                        `${VAPI_BASE_URL}/phone-number/${restaurant.vapi_phone_id}`,
                        {
                            serverUrl: NEW_SERVER_URL
                        },
                        {
                            headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` }
                        }
                    );
                    console.log(`   ✅ Phone Number updated with new Server URL`);
                } catch (err) {
                    console.error(`   ❌ Failed to update phone number: ${err.message}`);
                }
            }
        }

        console.log('\n✨ All updates complete! VAPI should now connect successfully.');

    } catch (error) {
        console.error('❌ Critical Error:', error.message);
    }
}

updateAllAssistants();
