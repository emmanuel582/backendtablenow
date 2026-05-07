import supabase from '../config/supabase';
import vapiService from '../services/vapi.service';
import logger from './logger';

// Single source of truth for VAPI provisioning.
// Used by auth.ts (register/verify-email) and settings.ts (retry-vapi).
export async function provisionVapi(restaurant: {
    id: string;
    name: string;
    email: string;
    phone?: string;
}): Promise<{
    assistantId: string;
    phoneNumber: string;
    phoneId: string;
    bccEmail: string;
}> {
    const log = logger.child({ restaurantId: restaurant.id, fn: 'provisionVapi' });
    log.info('🚀 Starting VAPI provisioning');

    const assistant = await vapiService.createAssistant(restaurant);
    log.info({ assistantId: assistant.id }, '✅ Assistant created');

    await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);

    const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name, assistant.id);
    log.info({ phone: phoneNumber.number, phoneId: phoneNumber.id }, '✅ Phone assigned');

    await supabase.from('restaurants').update({
        vapi_phone_id: phoneNumber.id,
        vapi_phone_number: phoneNumber.number || phoneNumber.id,
    }).eq('id', restaurant.id);

    await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
    log.info('✅ Assistant linked to phone');

    const emailDomain = process.env.EMAIL_DOMAIN;
    if (!emailDomain) throw new Error('EMAIL_DOMAIN env variable is not set');
    const bccEmail = `bcc+r-${restaurant.id}@${emailDomain}`;

    await supabase.from('restaurants').update({ bcc_email: bccEmail, status: 'active' }).eq('id', restaurant.id);
    log.info({ bccEmail }, '✅ VAPI provisioning complete');

    return {
        assistantId: assistant.id,
        phoneNumber: phoneNumber.number || phoneNumber.id,
        phoneId: phoneNumber.id,
        bccEmail,
    };
}
