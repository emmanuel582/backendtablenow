import { Client } from '@hubspot/api-client';

const hubspotApiKey = process.env.HUBSPOT_API_KEY;
if (!hubspotApiKey) {
    throw new Error('HUBSPOT_API_KEY is not set');
}
const hubspotClient = new Client({ accessToken: hubspotApiKey });

export class HubSpotService {
    /**
     * Create or update contact in HubSpot
     */
    async upsertContact(data: {
        email: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
        restaurantName?: string;
        partySize?: number;
        reservationDate?: string;
    }): Promise<any> {
        try {
            const properties = {
                email: data.email,
                firstname: data.firstName || '',
                lastname: data.lastName || '',
                phone: data.phone || '',
                company: data.restaurantName || '',
                hs_lead_status: 'NEW'
            };

            // Try to create, if exists, update
            try {
                const response = await hubspotClient.crm.contacts.basicApi.create({
                    properties,
                    associations: []
                });
                return response;
            } catch (error: any) {
                // Treat conflict as success: fetch existing and update
                const isConflict = error.code === 409 || error?.response?.status === 409;
                if (!isConflict) throw error;

                const searchResponse = await hubspotClient.crm.contacts.searchApi.doSearch({
                    filterGroups: [{
                        filters: [{
                            propertyName: 'email',
                            operator: 'EQ' as any,
                            value: data.email
                        }]
                    }],
                    properties: ['email'],
                    limit: 1
                } as any);

                if (searchResponse.results.length > 0) {
                    const contactId = searchResponse.results[0].id;
                    await hubspotClient.crm.contacts.basicApi.update(contactId, { properties });
                    return { id: contactId, properties };
                }

                throw error;
            }
        } catch (error: any) {
            console.error('Error upserting HubSpot contact:', error.message);
            throw error;
        }
    }

    /**
     * Create deal (booking) in HubSpot
     */
    async createDeal(data: {
        dealName: string;
        amount?: number;
        contactEmail: string;
        restaurantId: string;
        reservationDate: string;
        partySize: number;
    }): Promise<any> {
        try {
            // First, get or create contact
            const contact = await this.upsertContact({ email: data.contactEmail });

            const properties = {
                dealname: data.dealName,
                amount: data.amount?.toString() || '0',
                dealstage: 'appointmentscheduled',
                pipeline: 'default',
                closedate: new Date(data.reservationDate).getTime().toString(),
                hs_priority: data.partySize >= 8 ? 'high' : 'medium'
            };

            const response = await hubspotClient.crm.deals.basicApi.create({
                properties,
                associations: contact?.id ? [{
                    to: { id: contact.id },
                    types: [{
                        associationCategory: 'HUBSPOT_DEFINED' as any,
                        associationTypeId: 3 // Contact to Deal
                    }]
                }] as any : []
            });

            return response;
        } catch (error: any) {
            console.error('Error creating HubSpot deal:', error.message);
            throw error;
        }
    }

    /**
     * Update deal status
     */
    async updateDealStatus(dealId: string, status: 'confirmed' | 'cancelled' | 'completed'): Promise<any> {
        try {
            const stageMap = {
                confirmed: 'appointmentscheduled',
                cancelled: 'closedlost',
                completed: 'closedwon'
            };

            const response = await hubspotClient.crm.deals.basicApi.update(dealId, {
                properties: {
                    dealstage: stageMap[status]
                }
            });

            return response;
        } catch (error: any) {
            console.error('Error updating HubSpot deal:', error.message);
            throw error;
        }
    }

    /**
     * Log activity (call, email, etc.)
     */
    async logActivity(data: {
        contactEmail: string;
        activityType: 'call' | 'email' | 'note';
        subject: string;
        body: string;
        timestamp?: Date;
    }): Promise<any> {
        try {
            const contact = await this.upsertContact({ email: data.contactEmail });

            if (!contact.id) {
                throw new Error('Contact not found');
            }

            const engagementData: any = {
                engagement: {
                    active: true,
                    type: data.activityType.toUpperCase(),
                    timestamp: (data.timestamp || new Date()).getTime()
                },
                associations: {
                    contactIds: [contact.id]
                },
                metadata: {
                    subject: data.subject,
                    body: data.body
                }
            };

            // Note: This uses the legacy engagements API
            // For newer HubSpot accounts, you may need to use the v3 API
            const response = await hubspotClient.apiRequest({
                method: 'POST',
                path: '/engagements/v1/engagements',
                body: engagementData
            });

            return response;
        } catch (error: any) {
            console.error('Error logging HubSpot activity:', error.message);
            throw error;
        }
    }

    /**
     * Create note for restaurant
     */
    async createNote(contactEmail: string, note: string): Promise<any> {
        return this.logActivity({
            contactEmail,
            activityType: 'note',
            subject: 'TableNow Activity',
            body: note
        });
    }
}

export default new HubSpotService();
