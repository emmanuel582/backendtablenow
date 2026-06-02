// ============================================
// POST /check-availability
// Appelé par VAPI via webhook après collecte :
// prénom, nom, date, heure, couverts
// ============================================

import { createClient } from '@supabase/supabase-js';
import logger from '../lib/logger';
import { Request, Response } from 'express';

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);

/**
 * Détermine si un horaire est midi ou soir
 * Midi : avant 15h00 / Soir : à partir de 15h00
 */
export function getServiceType(timeStr: string): 'midi' | 'soir' {
    const [hours] = timeStr.split(':').map(Number);
    return hours < 15 ? 'midi' : 'soir';
}

/**
 * Trouve le prochain service disponible dans les 14 prochains jours
 */
async function findNextAvailable(
    restaurantId: string,
    serviceType: string,
    coversNeeded: number,
    fromDate: string
): Promise<{ date: string; service_type: string } | null> {
    const from = new Date(fromDate);

    for (let i = 1; i <= 14; i++) {
        const checkDate = new Date(from);
        checkDate.setDate(from.getDate() + i);
        const dateStr = checkDate.toISOString().split('T')[0];

        const { data } = await supabase
            .from('services')
            .select('date, service_type, remaining_covers')
            .eq('restaurant_id', restaurantId)
            .eq('date', dateStr)
            .eq('service_type', serviceType)
            .eq('is_closed', false)
            .gte('remaining_covers', coversNeeded)
            .single();

        if (data) {
            return { date: data.date, service_type: data.service_type };
        }
    }
    return null;
}

export async function checkAvailability(req: Request, res: Response): Promise<void> {
    const { restaurant_id, date, time, covers } = req.body;

    if (!restaurant_id || !date || !time || !covers) {
        res.status(400).json({
            available: false,
            reason: 'missing_params',
            message: 'restaurant_id, date, time et covers sont requis.'
        });
        return;
    }

    const coversInt = parseInt(covers, 10);
    if (isNaN(coversInt) || coversInt < 1 || coversInt > 50) {
        res.status(400).json({
            available: false,
            reason: 'invalid_covers',
            message: 'Nombre de couverts invalide.'
        });
        return;
    }

    const serviceType = getServiceType(time);

    try {
        const { data: service, error } = await supabase
            .from('services')
            .select('id, max_covers, booked_covers, remaining_covers, is_closed')
            .eq('restaurant_id', restaurant_id)
            .eq('date', date)
            .eq('service_type', serviceType)
            .single();

        if (error || !service) {
            res.json({
                available: false,
                reason: 'service_not_found',
                message: `Aucun service ${serviceType} configuré pour le ${date}.`,
                agent_script: `Je suis désolé, je ne vois pas de disponibilité pour le ${date} au ${serviceType}. Souhaitez-vous que je vous propose une autre date ?`
            });
            return;
        }

        if (service.is_closed) {
            const next = await findNextAvailable(restaurant_id, serviceType, coversInt, date);
            res.json({
                available: false,
                reason: 'service_closed',
                message: `Le service ${serviceType} du ${date} est fermé.`,
                next_available: next,
                agent_script: next
                    ? `Ce soir là nous sommes fermés. La prochaine disponibilité serait le ${next.date} au ${next.service_type}. Cela vous conviendrait-il ?`
                    : `Nous sommes fermés ce soir là et je ne vois pas de disponibilité dans les prochains jours. Souhaitez-vous que je note vos coordonnées pour vous recontacter ?`
            });
            return;
        }

        if (service.remaining_covers < coversInt) {
            const next = await findNextAvailable(restaurant_id, serviceType, coversInt, date);
            res.json({
                available: false,
                reason: 'no_capacity',
                service_id: service.id,
                remaining_covers: service.remaining_covers,
                next_available: next,
                agent_script: next
                    ? `Pour ${coversInt} personnes ce soir là, il ne me reste malheureusement plus de place. En revanche, j'ai de la disponibilité le ${next.date}. Est-ce que ça vous irait ?`
                    : `Je suis désolé, nous affichons complet pour cette période. Souhaitez-vous être mis sur liste d'attente ?`
            });
            return;
        }

        res.json({
            available: true,
            service_id: service.id,
            service_type: serviceType,
            remaining_covers: service.remaining_covers,
            agent_script: `Parfait, j'ai bien de la disponibilité pour ${coversInt} personnes le ${date} au ${serviceType}. Puis-je vous demander votre numéro de téléphone et votre email pour finaliser la réservation ?`
        });

    } catch (err: any) {
        logger.error({ err }, '[check-availability] error');
        res.status(500).json({
            available: false,
            reason: 'internal_error',
            agent_script: `Je rencontre une difficulté technique pour vérifier les disponibilités. Je vous invite à rappeler dans quelques instants ou à laisser votre numéro pour qu'on vous recontacte.`
        });
    }
}
