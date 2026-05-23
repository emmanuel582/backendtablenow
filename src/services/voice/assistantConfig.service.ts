// ============================================
// Assistant Config Service — Voice Core
// Builds the voice assistant business context (variables, dates, hours)
// Provider-agnostic: output can be mapped to any voice provider
// ============================================

import logger from '../../lib/logger';
import vapiService from '../vapi.service';
import type {
  ResolvedVoiceRestaurant,
  VoiceAssistantContext,
} from '../../types/voice.types';

interface DateVariables {
  currentDate: string;
  currentDateISO: string;
  nextDays: string;
}

class AssistantConfigService {
  buildDateVariables(now: Date = new Date()): DateVariables {
    const tz = 'Europe/Paris';

    const fmtFull = new Intl.DateTimeFormat('fr-FR', {
      timeZone: tz,
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    const isoFmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const dayFmtEN = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    });

    const isoOf = (d: Date): string => {
      const parts = isoFmt.formatToParts(d).reduce<Record<string, string>>(
        (acc, part) => {
          acc[part.type] = part.value;
          return acc;
        },
        {}
      );
      return `${parts['year']}-${parts['month']}-${parts['day']}`;
    };

    const currentDate = fmtFull.format(now);
    const currentDateISO = isoOf(now);

    const seenDays: Record<string, number> = {};
    const dayList: string[] = [
      `tomorrow=${isoOf(new Date(now.getTime() + 86400000))}`,
      `day_after_tomorrow=${isoOf(new Date(now.getTime() + 172800000))}`,
    ];

    for (let i = 1; i <= 14; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const dayEN = dayFmtEN.format(d).toLowerCase();
      const iso = isoOf(d);
      seenDays[dayEN] = (seenDays[dayEN] ?? 0) + 1;
      const key = seenDays[dayEN] === 1 ? dayEN : `next_${dayEN}`;
      dayList.push(`${key}=${iso}`);
    }

    return {
      currentDate,
      currentDateISO,
      nextDays: dayList.join(', '),
    };
  }

  buildAssistantContext(
    restaurant: ResolvedVoiceRestaurant,
    now: Date = new Date()
  ): VoiceAssistantContext {
    const dateVars = this.buildDateVariables(now);
    const openingHoursFormatted = vapiService.formatOpeningHours(
      restaurant.opening_hours
    );

    const variables: Record<string, string> = {
      restaurantName: restaurant.name,
      address: restaurant.address,
      humanPhone: restaurant.phone,
      openingHours: openingHoursFormatted,
      restaurantId: restaurant.id,
      currentDate: dateVars.currentDate,
      currentDateISO: dateVars.currentDateISO,
      nextDays: dateVars.nextDays,
    };

    logger.info(
      {
        action: 'build_assistant_context',
        restaurant_id: restaurant.id,
        currentDateISO: dateVars.currentDateISO,
      },
      'Built voice assistant context'
    );

    return {
      restaurant,
      variables,
      language: restaurant.language,
    };
  }
}

export default new AssistantConfigService();
