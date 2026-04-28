import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Charge le .env à la racine du projet (idempotent : ne réécrit pas les vars déjà
// définies par l'environnement réel — comportement attendu en prod sous pm2/Hostinger).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Schéma de validation ──────────────────────────────────────────────────────
// Toute variable listée ici est REQUISE. Si l'une manque ou est invalide, le
// serveur refuse de démarrer (throw au chargement du module). C'est volontaire :
// mieux vaut un crash explicite au boot qu'un fallback silencieux qui envoie
// les emails depuis un mauvais compte.
const schema = z.object({
    SMTP_HOST:    z.string().min(1, 'requis (ex: smtp.resend.com)'),
    SMTP_PORT:    z.coerce.number().int().positive('doit être un entier positif (ex: 465 ou 587)'),
    SMTP_USER:    z.string().min(1, 'requis (identifiant SMTP du fournisseur)'),
    SMTP_PASS:    z.string().min(1, 'requis (clé/mot de passe SMTP du fournisseur)'),
    EMAIL_FROM:   z.string().email('doit être un email valide (ex: info@tablenow.io)'),
    EMAIL_DOMAIN: z.string().min(1, 'requis (ex: tablenow.io — utilisé pour les alias BCC)'),
    FRONTEND_URL: z.string().url('doit être une URL valide (ex: https://app.tablenow.io)'),
    // Mode de provisioning du numéro de téléphone VAPI lors de l'onboarding :
    //   'pool'    → cherche un numéro déjà acheté et libre dans le compte VAPI (défaut)
    //   'dynamic' → achat à la volée via POST /phone-number (NON IMPLÉMENTÉ — placeholder)
    VAPI_PROVISIONING_MODE: z.enum(['pool', 'dynamic']).default('pool'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((i) => `  • ${i.path.join('.')} : ${i.message}`)
        .join('\n');
    throw new Error(
        `Configuration invalide — le serveur ne peut pas démarrer.\n` +
        `Variables d'environnement manquantes ou invalides :\n${issues}\n\n` +
        `Vérifiez votre fichier .env (voir .env.example pour le format attendu).`
    );
}

const env = parsed.data;

// ── Objet config typé exporté ─────────────────────────────────────────────────
// Préférer config.X à process.env.X dans le reste du code : valeurs typées,
// validées une seule fois au boot, IDE-friendly.
export const config = {
    smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
    },
    email: {
        from:   env.EMAIL_FROM,
        domain: env.EMAIL_DOMAIN,
    },
    frontendUrl: env.FRONTEND_URL,
    vapi: {
        provisioningMode: env.VAPI_PROVISIONING_MODE,
    },
} as const;

export type AppConfig = typeof config;
