
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_BASE_URL = 'https://api.vapi.ai';

// This script now CHECKS your existing Vapi numbers instead of importing from Twilio.
// It verifies which numbers are ready to be used by the auto-assigner.
async function checkVapiPool() {
    if (!VAPI_API_KEY) {
        console.error('❌ Missing VAPI_API_KEY in .env');
        return;
    }

    try {
        console.log('🔍 Fetching your phone numbers from Vapi...');
        const response = await axios.get(
            `${VAPI_BASE_URL}/phone-number`,
            {
                headers: {
                    'Authorization': `Bearer ${VAPI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const allNumbers = response.data;
        const available = allNumbers.filter((p: any) => !p.assistantId);
        const inUse = allNumbers.filter((p: any) => p.assistantId);

        console.log(`\n============== VAPI NUMBER POOL STATUS ==============`);
        console.log(`\n📊 SUMMARY:`);
        console.log(`   Total Numbers: ${allNumbers.length}`);
        console.log(`   ✅ AVAILABLE (Ready): ${available.length}`);
        console.log(`   ❌ IN USE (Assigned): ${inUse.length}`);

        if (available.length > 0) {
            console.log(`\n✅ READY FOR NEW RESTAURANTS:`);
            console.log(`(These numbers have no assistant and will be auto-assigned)`);
            available.forEach((p: any) => {
                const label = p.name ? `(${p.name})` : '';
                console.log(`   📞 ${p.number} ${label}`);
                // console.log(`      ID: ${p.id}`);
            });
        }

        if (inUse.length > 0) {
            console.log(`\n❌ CURRENTLY ASSIGNED (Skipped by auto-assigner):`);
            inUse.forEach((p: any) => {
                const label = p.name ? `(${p.name})` : '';
                console.log(`   🔒 ${p.number} ${label}`);
                console.log(`      Assistant ID: ${p.assistantId}`);
            });
        }

        console.log(`\n=====================================================`);
        console.log(`💡 CONFIGURATION INSTRUCTIONS:`);
        console.log(`1. You do NOT need to manually configure "Server URL" or "Assistant" in the Vapi Dashboard.`);
        console.log(`2. Just ensure you have enough "AVAILABLE" numbers in the list above.`);
        console.log(`3. When a restaurant registers, our system will automatically:`);
        console.log(`   - Pick an available number`);
        console.log(`   - Create a specific Assistant`);
        console.log(`   - Link them together`);
        console.log(`   - Set the correct Server URL`);
        console.log(`=====================================================`);

    } catch (error: any) {
        console.error('❌ Error fetching numbers from Vapi:', error.response?.data || error.message);
    }
}

checkVapiPool();
