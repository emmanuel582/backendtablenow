import axios from 'axios';
import logger from '../lib/logger';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY = process.env.TWILIO_API_KEY;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;

class TwilioService {
    private baseUrl = 'https://api.twilio.com/2010-04-01';
    private auth: string;

    constructor() {
        if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
            logger.warn({ action: 'twilio_init' }, 'Twilio credentials not configured');
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
            logger.error({ action: 'twilio_search', error: error.message }, 'Error searching Twilio numbers');
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
            logger.error({ action: 'twilio_purchase', error: error.message }, 'Error purchasing Twilio number');
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
            logger.error({ action: 'twilio_buy', error: error.message }, 'Error buying phone number');
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
            logger.error({ action: 'twilio_vapi_import', error: error.message }, 'Error importing to VAPI');
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
            logger.error({ action: 'twilio_buy_import', error: error.message }, 'Error in buy and import flow');
            throw error;
        }
    }

    /**
     * Send an SMS using Twilio Programmable SMS
     */
    async sendSms(to: string, from: string, body: string): Promise<any> {
        try {
            if (!this.isConfigured()) {
                throw new Error('Twilio credentials not configured');
            }

            const url = `${this.baseUrl}/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

            const response = await axios.post(
                url,
                new URLSearchParams({
                    To: to,
                    From: from,
                    Body: body
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
            logger.error({ action: 'twilio_sms', error: error.message }, 'Error sending SMS via Twilio');
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
