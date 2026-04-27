/**
 * Sélection du jeu de templates en fonction de la langue.
 */
import { EmailTemplates, SupportedLanguage } from './types';
import fr from './fr';
import en from './en';

const REGISTRY: Record<SupportedLanguage, EmailTemplates> = { fr, en };

/**
 * Retourne le jeu de templates pour la langue demandée. Tolérant : si la
 * langue est inconnue ou nulle, on retombe sur le français (langue par défaut
 * de la plate-forme TableNow).
 */
export function getTemplates(language?: string | null): EmailTemplates {
    if (language === 'en') return REGISTRY.en;
    return REGISTRY.fr;
}

export type { SupportedLanguage } from './types';
