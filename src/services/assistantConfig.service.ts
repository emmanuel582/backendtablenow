import logger from '../lib/logger';
import vapiService from './vapi.service';

class AssistantConfigService {
  formatDateVariables(now: Date = new Date()): Record<string, string> {
    const tz = 'Europe/Paris';
    const fmtFull = new Intl.DateTimeFormat('fr-FR', {
      timeZone: tz,
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
    const currentDate = fmtFull.format(now);

    const todayParts = new Intl.DateTimeFormat('fr-FR', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .formatToParts(now)
      .reduce((a: any, p) => {
        a[p.type] = p.value;
        return a;
      }, {} as any);

    const currentDateISO = `${todayParts['year']}-${todayParts['month']}-${todayParts['day']}`;

    const isoFmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const dayFmtEN = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long'
    });

    const isoOf = (d: Date) => {
      const p = isoFmt.formatToParts(d).reduce((a: any, x) => {
        a[x.type] = x.value;
        return a;
      }, {} as any);
      return `${p['year']}-${p['month']}-${p['day']}`;
    };

    const seen: Record<string, number> = {};
    const parts = [
      'tomorrow=' + isoOf(new Date(now.getTime() + 86400000)),
      'day_after_tomorrow=' + isoOf(new Date(now.getTime() + 172800000))
    ];

    for (let i = 1; i <= 14; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const dayEN = dayFmtEN.format(d).toLowerCase();
      const iso = isoOf(d);
      seen[dayEN] = (seen[dayEN] || 0) + 1;
      const key = seen[dayEN] === 1 ? dayEN : 'next_' + dayEN;
      parts.push(key + '=' + iso);
    }

    const nextDays = parts.join(', ');

    return {
      currentDate,
      currentDateISO,
      nextDays
    };
  }

  buildVariableValues(restaurant: any): Record<string, any> {
    if (!restaurant) {
      logger.warn({ action: 'build_variables' }, 'No restaurant data provided');
      return {};
    }

    const openingHoursFormatted = vapiService.formatOpeningHours(restaurant.opening_hours);
    const dateVariables = this.formatDateVariables();

    return {
      restaurantName: restaurant.name || '',
      address: restaurant.address || '',
      humanPhone: restaurant.phone || '',
      openingHours: openingHoursFormatted,
      restaurantId: restaurant.id,
      ...dateVariables
    };
  }

  buildAssistantConfig(variableValues: Record<string, any>): Record<string, any> {
    return {
      assistant: {
        variableValues
      }
    };
  }
}

export default new AssistantConfigService();
