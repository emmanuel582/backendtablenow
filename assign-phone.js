// Quick script to assign the VAPI phone number to Theemris restaurant
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

async function assignPhoneNumber() {
    try {
        // Update Theemris restaurant with the phone number
        const { data, error } = await supabase
            .from('restaurants')
            .update({
                vapi_phone_number: '+14125289798', // The actual phone number
                vapi_phone_id: '49d45496-fab1-4f70-8e2a-12d5f942f0cf', // VAPI phone ID
                vapi_assistant_id: '810e3b73-ee23-4f7e-a90f-aa0c2718213e', // Latest assistant ID
                status: 'active'
            })
            .eq('name', 'Theemris')
            .select();

        if (error) {
            console.error('❌ Error:', error);
        } else {
            console.log('✅ Phone number assigned successfully!');
            console.log('📱 Phone Number: +1 (412) 528-9798');
            console.log('🤖 Assistant ID: 810e3b73-ee23-4f7e-a90f-aa0c2718213e');
            console.log('🏪 Restaurant:', data[0].name);
        }
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

assignPhoneNumber();
