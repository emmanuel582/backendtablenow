import axios from 'axios';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY = process.env.TWILIO_API_KEY;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;

class TwilioService {
    private baseUrl = 'https://api.twilio.com/2010-04-01';
    private auth: string;

    constructor() {
        if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
            console.warn('Twilio credentials not configured');
        }
        // Use Basic Auth with Account SID and Auth Token
        this.auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    }

    /**
     * Search for available phone numbers in a specific area code
     */
    async searchAvailableNumbers(areaCode?: string, country: string = 'US'): Promise<any[]> {
        try {
            const url = `${this.baseUrl}/Accounts/${TWILIO_ACCOUNT_SID}/AvailablePhoneNumbers/${country}/Local.json`;

            const params: any = {
                Limit: 5
            };

            if (areaCode) {
                params.AreaCode = areaCode;
            }

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Basic ${this.auth}`
                },
                params
            });

            return response.data.available_phone_numbers || [];
        } catch (error: any) {
            console.error('Error searching Twilio numbers:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Purchase a phone number from Twilio
     */
    async purchasePhoneNumber(phoneNumber: string): Promise<any> {
        try {
            const url = `${this.baseUrl}/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`;

            const response = await axios.post(
                url,
                new URLSearchParams({
                    PhoneNumber: phoneNumber
                }),
                {
                    headers: {
                        'Authorization': `Basic ${this.auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            return response.data;
        } catch (error: any) {
            console.error('Error purchasing Twilio number:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Buy and return the first available phone number
     */
    async buyPhoneNumber(areaCode?: string): Promise<string> {
        try {
            // Search for available numbers
            const availableNumbers = await this.searchAvailableNumbers(areaCode);

            if (availableNumbers.length === 0) {
                throw new Error('No available phone numbers found');
            }

            // Purchase the first available number
            const phoneNumber = availableNumbers[0].phone_number;
            await this.purchasePhoneNumber(phoneNumber);

            return phoneNumber;
        } catch (error: any) {
            console.error('Error buying phone number:', error);
            throw error;
        }
    }

    /**
     * Import Twilio number to VAPI
     */
    async importToVapi(phoneNumber: string, vapiApiKey: string): Promise<any> {
        try {
            const response = await axios.post(
                'https://api.vapi.ai/phone-number/import',
                {
                    provider: 'twilio',
                    number: phoneNumber,
                    twilioAccountSid: TWILIO_ACCOUNT_SID,
                    twilioApiKey: TWILIO_API_KEY || TWILIO_AUTH_TOKEN,
                    twilioApiSecret: TWILIO_API_SECRET || ''
                },
                {
                    headers: {
                        'Authorization': `Bearer ${vapiApiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.data;
        } catch (error: any) {
            console.error('Error importing to VAPI:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Complete flow: Buy from Twilio and import to VAPI
     */
    async buyAndImportPhoneNumber(vapiApiKey: string, areaCode?: string): Promise<any> {
        try {
            const phoneNumber = await this.buyPhoneNumber(areaCode);
            const vapiPhone = await this.importToVapi(phoneNumber, vapiApiKey);

            return {
                phoneNumber,
                vapiPhoneId: vapiPhone.id,
                vapiPhone
            };
        } catch (error: any) {
            console.error('Error in buy and import flow:', error);
            throw error;
        }
    }

    /**
     * Check if Twilio is configured
     */
    isConfigured(): boolean {
        return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
    }
}

export default new TwilioService();
