# TableNow — Backend

API de réservation pilotée par une **hôtesse téléphonique IA** qui répond aux appels 24/7 pour les restaurants. Le client appelle, l'agent vocal répond en langage naturel, réserve la table, et la réservation apparaît instantanément dans le tableau de bord du restaurant.

Ce dépôt contient le **backend** (Node.js + TypeScript + Express). L'interface restaurant (React) vit dans le dépôt [`tablenowfrontend`](https://github.com/tablenow101/tablenowfrontend).

> 🆕 **Nouveautés de la semaine du 4 au 10 juin 2026** : voir [`CHANGELOG.md`](./CHANGELOG.md). Faits marquants : pont disponibilités `opening_hours → availability_rules` (sans lui, l'agent vocal ne pouvait confirmer aucune réservation), Stripe rendu remplaçable + validation des secrets, source de domaine unique, images Docker, templates d'emails Supabase rebrandés, et durcissement de l'auth (`/bootstrap` strict, vérif `email_confirmed_at`, source unique de routage `next_route`).

---

## Sommaire

1. [Vue d'ensemble du produit](#1-vue-densemble-du-produit)
2. [Architecture](#2-architecture)
3. [Stack technique](#3-stack-technique)
4. [Démarrage rapide](#4-démarrage-rapide)
5. [Structure du projet](#5-structure-du-projet)
6. [Authentification & source unique de routage](#6-authentification--source-unique-de-routage)
7. [Référence API](#7-référence-api)
8. [Services & logique métier](#8-services--logique-métier)
9. [Modèle de données](#9-modèle-de-données)
10. [Intégrations remplaçables](#10-intégrations-remplaçables)
11. [Emails](#11-emails)
12. [Configuration & variables d'environnement](#12-configuration--variables-denvironnement)
13. [Déploiement](#13-déploiement)
14. [Tests](#14-tests)

---

## 1. Vue d'ensemble du produit

TableNow est un SaaS de réservation pour restaurants articulé autour de trois canaux de prise de réservation, qui convergent tous vers une **source de vérité unique** côté backend :

| Canal | Description |
| --- | --- |
| **Voix (VAPI)** | L'assistant IA répond au téléphone, vérifie les disponibilités et crée la réservation pendant l'appel. |
| **Web (dashboard)** | Le restaurateur crée/modifie/annule des réservations manuellement depuis l'app. |
| **BCC e-mail (PMS)** | Les e-mails de confirmation des PMS tiers (Zenchef, SevenRooms…) sont relayés en BCC, parsés, et convertis en réservations. |

Le backend orchestre par ailleurs : l'**onboarding** du restaurant, le **provisioning** VAPI (numéro + assistant), la **synchronisation calendrier** (Google + flux ICS universel), la **facturation Stripe**, les **e-mails transactionnels**, et les **insights** du tableau de bord.

## 2. Architecture

```
                    ┌─────────────────────────────────────────────┐
   Appel téléphone  │                  VAPI (voix)                 │
   ───────────────▶ │  assistant-config · check-availability ·    │
                    │  create-booking · webhook (HMAC)            │
                    └───────────────────┬─────────────────────────┘
                                        │
  Navigateur (React)   HTTPS /api/*     ▼
  ──────────────────▶ ┌─────────────────────────────────────────────┐      ┌──────────────┐
                      │            BACKEND  (Express / TS)            │◀────▶│   Supabase   │
  PMS (BCC e-mail)    │                                               │      │  Postgres +  │
  ──────────────────▶ │  auth · bookings · availability · settings ·  │      │  Auth + RPC  │
                      │  calendar · stripe · dashboard · email · vapi │      └──────────────┘
                      └───┬───────────┬───────────┬───────────┬───────┘
                          │           │           │           │
                          ▼           ▼           ▼           ▼
                     Google Cal    Stripe      SMTP/Resend   VAPI API
                     (OAuth+ICS)  (optionnel)  (e-mails)    (provisioning)
```

**Principes directeurs** (voir aussi le résumé en fin de README) :

1. **Auth unique** — Supabase Auth est l'unique émetteur de tokens. Le backend ne *valide* que les JWT (aucun JWT réémis ; les anciens endpoints `/register`, `/login`, `/verify-email` ont été supprimés).
2. **Routage unique** — `resolveNextRoute()` (`src/lib/routing.ts`) est la seule décision de navigation ; le frontend la suit verbatim via `next_route`.
3. **Domaine unique** — `FRONTEND_URL` + `BACKEND_URL` ; aucun domaine codé en dur dans le runtime.
4. **Config fail-fast** — validation Zod au chargement ; un secret requis manquant empêche le démarrage.
5. **Intégrations remplaçables** — Stripe, HubSpot, Pinecone… sont optionnels ; le serveur démarre sans eux, et les routes concernées renvoient `503` plutôt qu'une erreur silencieuse.

## 3. Stack technique

| Domaine | Technologie |
| --- | --- |
| Runtime / langage | Node.js 20 · TypeScript 5.3 |
| Framework HTTP | Express 4 |
| Base de données / Auth | Supabase (`@supabase/supabase-js`) — Postgres + Auth + RPC |
| Validation | Zod (schémas stricts sur body / query / params) |
| Logs | Pino + `pino-http` (JSON structuré, `X-Correlation-ID`) |
| Voix | VAPI (`api.vapi.ai`) — webhooks signés HMAC-SHA256 |
| Paiement | Stripe (optionnel, initialisé à la demande) |
| Calendrier | `googleapis` (OAuth + lecture/écriture) · `ical-generator` (flux ICS) |
| E-mail | Nodemailer (SMTP / Resend) · `mailparser` (parsing BCC) |
| IA / RAG | OpenAI · Google Generative AI (Gemini) · Pinecone · LangChain |
| CRM | HubSpot (`@hubspot/api-client`, optionnel) |
| Sécurité | Helmet · CORS (origines dérivées de `FRONTEND_URL`) · `express-rate-limit` (200 req/15 min) |
| Tests | Jest + `ts-jest` |
| Déploiement | Docker (multi-stage) · `pm2` · Heroku (hooks) |

## 4. Démarrage rapide

Prérequis : Node 20+ et npm.

```bash
npm install
cp .env.example .env     # puis renseigner les valeurs (voir §12)
npm run dev              # serveur de dev avec rechargement (nodemon), port 5000
```

### Scripts npm

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de dev avec rechargement automatique. |
| `npm run build` | Compile TypeScript → `dist/` et copie les assets statiques. |
| `npm start` | Démarre le serveur compilé (`node dist/server.js`). |
| `npm test` | Lance la suite de tests Jest. |
| `npm run test:watch` | Tests en mode watch. |
| `npm run test:coverage` | Rapport de couverture. |
| `npm run setup-db` | Initialise/migre la base. |

## 5. Structure du projet

```
src/
├── server.ts                 # Point d'entrée : middlewares, montage des routers, /health, cron
├── config/
│   └── supabase.ts           # Clients Supabase (service-role + anon) ; getUserFromToken
├── lib/
│   ├── config.ts             # Config centralisée validée par Zod (parsing unique de l'env)
│   ├── routing.ts            # resolveNextRoute : SOURCE UNIQUE de routage frontend
│   ├── authBootstrap.ts      # deriveProfile : métadonnées utilisateur depuis Supabase Auth
│   ├── errors.ts             # AppError / ValidationError / DatabaseError
│   ├── logger.ts             # Configuration Pino + contexte enfant
│   ├── timezone.ts           # Conversion heure murale (Europe/Paris) → UTC
│   └── supabase.utils.ts     # generateUniqueSlug (slugs de restaurant déterministes)
├── middleware/
│   ├── auth.ts               # authenticateToken (JWT Supabase → restaurant) ; validateBCCSecret
│   ├── handlers.ts           # correlationId · validate (Zod) · errorHandler unifié
│   └── rateLimiter.ts        # express-rate-limit
├── routes/                   # Routers HTTP (voir §7)
│   ├── auth.ts  dashboard.ts  bookings.ts  availability.ts  vapi.ts  stripe.ts
│   ├── settings.ts  restaurants.ts  calendar.ts  email.ts  customers.ts
│   └── contact.ts  referral.ts  prefill.route.ts
├── services/                 # Logique métier (voir §8)
│   ├── availability.service.ts   # syncAvailabilityRules : pont opening_hours → availability_rules
│   ├── booking.service.ts        # createBooking / getBookings / cancelBooking / normalizeBooking
│   ├── vapi.service.ts           # Provisioning assistant, system prompt, outils
│   ├── email.service.ts          # Envoi e-mails + parsing BCC
│   ├── calendar.service.ts       # Sync Google Calendar
│   ├── ics.service.ts            # buildIcsFeed (flux .ics)
│   ├── provisioning.service.ts   # Numéro VAPI + assistant + alias BCC
│   ├── webhookQueue.service.ts   # Pattern outbox (effets de bord fiables)
│   └── voice/                    # Orchestration de la réservation vocale (machine à états)
├── schemas/                  # Schémas Zod (createBooking, vapiWebhook, authGoogle/Bootstrap…)
├── types/                    # Types TypeScript du domaine
├── cron/
│   └── trialEmails.ts        # E-mails d'expiration d'essai (J-2 / J-1 / J0), toutes les heures
└── __tests__/                # Tests (auth, routing, voice, webhooks, endpoints…)
```

## 6. Authentification & source unique de routage

### Chaîne d'authentification

L'authentification repose **uniquement sur Supabase Auth**. Le backend valide les tokens, il n'en émet jamais.

1. `authenticateToken` (`src/middleware/auth.ts`) extrait le token de l'en-tête `Authorization: Bearer <token>`.
2. Il appelle `getUserFromToken(token)` (`src/config/supabase.ts`), qui valide le JWT via le client anon Supabase.
3. **Défense en profondeur** : il vérifie `email_confirmed_at` (le backend reste sûr même si la config Supabase dérive).
4. Il résout le restaurant via `supabase_user_id` (lié lors du `/bootstrap`).
5. Il peuple `req.user = { userId, email, restaurantId }` + `req.restaurant`.

### `/auth/bootstrap` — point de liaison unique

`POST /auth/bootstrap` est **le seul** endroit où un restaurant est créé/lié à un compte Supabase (idempotent) :

- Validation Zod **stricte** : `{ access_token }` uniquement (`BootstrapSchema.strict()`).
- Le token est validé par le **même** `getUserFromToken()` que le middleware (un seul chemin de validation).
- Restaurant introuvable → création + slug + provisioning VAPI asynchrone ; existant → backfill `slug` / `supabase_user_id`.
- Les détails d'erreur Supabase ne sont jamais renvoyés dans les réponses 500 (loggés côté serveur uniquement).

### `next_route` — la seule décision de navigation

`resolveNextRoute()` (`src/lib/routing.ts`) renvoie la route que le frontend doit suivre :

```ts
export function resolveNextRoute(state: RoutingState): string | null {
  const slug = state.restaurant?.slug;
  if (!state.restaurant || !slug) return null;              // erreur contenue (jamais '/login')
  if (!state.restaurant.is_complete) return `/r/${slug}/onboarding`;
  return `/r/${slug}/dashboard`;
}
```

| `next_route` | Condition |
| --- | --- |
| `null` | Authentifié mais aucun restaurant/slug exploitable → le frontend affiche `NotLinked` (jamais de rebond vers `/login`). |
| `/r/:slug/onboarding` | Profil restaurant incomplet (`is_complete` faux). |
| `/r/:slug/dashboard` | Restaurant opérationnel. |

`is_complete` est dérivé de colonnes réelles dans `GET /auth/app-state` : `name`, `owner_name`, `address`, `phone` renseignés. Le calendrier / provisioning / assistant sont des **états** exposés, jamais des barrières de routage.

## 7. Référence API

Toutes les routes sont préfixées par `/api` (sauf `GET /health`). « Auth » indique le mode de protection.

### Auth — `/api/auth` (`routes/auth.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| POST | `/bootstrap` | Lie la session Supabase à un restaurant (idempotent) | Token Supabase (body) |
| GET | `/me` | Contexte utilisateur + routage (alias hérité) | Bearer |
| GET | `/app-state` | **Source unique de routage** ; renvoie `next_route` + état complet | Bearer |

**Forme de `GET /auth/app-state`** : `{ version, user, restaurant|null, subscription{status}, calendar{status,skipped}, provisioning{status,phone_number}, onboarding{status}, assistant{status}, next_route }`.

### Réservations — `/api/bookings` (`routes/bookings.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| GET | `/` | Liste paginée/filtrable (`status`, `date`, `limit`, `offset`) | Bearer |
| GET | `/:id` | Une réservation + client | Bearer |
| POST | `/` | Création manuelle | Bearer |
| PUT | `/:id` | Mise à jour | Bearer |
| DELETE | `/:id` | Annulation logique (`status = cancelled`) | Bearer |

### Disponibilités — `/api/availability` (`routes/availability.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| GET | `/` | Créneaux dispos pour une date + couverts | Public |
| POST | `/validate` | Validation atomique avant réservation | Public |
| GET | `/next` | Prochaine date disponible (30 j) | Public |
| POST | `/bookings` | Vérification en lot de plusieurs dates | Public |

> Le moteur de créneaux appelle la RPC Supabase `get_available_slots(restaurant_id, date, covers)`, qui lit la table **`availability_rules`** — alimentée par le pont décrit au §8.

### VAPI (voix) — `/api/vapi` (`routes/vapi.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| POST | `/webhook` | Événements d'appel (started/ended/tool-calls) | Signature HMAC-SHA256 |
| POST | `/assistant-config` | Injection des variables dynamiques (`{{restaurantName}}`…) | — |
| POST | `/check-availability` | Outil VAPI : vérifie les créneaux | — |
| POST | `/create-booking` | Outil VAPI : valide la réservation (avec `idempotency_key`) | — |

### Réglages — `/api/settings` (`routes/settings.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| GET | `/` | Configuration complète du restaurant | Bearer |
| PUT | `/` | Mise à jour profil / horaires / capacité (allowlist de champs) | Bearer |
| POST | `/retry-vapi` | Relance le provisioning numéro + assistant | Bearer |

> **Effet de bord clé** : si `opening_hours` change, `PUT /settings` resynchronise `availability_rules` et met à jour l'assistant VAPI. C'est l'unique point d'écriture des horaires (onboarding **et** réglages).

### Stripe — `/api/stripe` (`routes/stripe.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| POST | `/create-checkout-session` | Démarre l'abonnement (`plan: en_cas\|miam\|fin_gourmet`) | Bearer |
| POST | `/webhook` | Événements Stripe (raw body + signature) | Signature Stripe |

### Calendrier — `/api/calendar` (`routes/calendar.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| GET | `/feed/:restaurantId/:token` | Flux ICS public (compatible `webcal://`) | Token URL |
| GET | `/auth-url` | URL de consentement Google OAuth | Bearer |
| GET / POST | `/callback` | Redirection navigateur / échange du code | Public / Bearer |
| GET | `/connections` · `/feed-url` | Calendriers connectés / URL du flux | Bearer |
| POST | `/feed/rotate` · `/disconnect` · `/skip` | Rotation du token / révocation / ignorer | Bearer |
| DELETE | `/connections/:id` | Supprime un fournisseur | Bearer |

> Anti open-redirect : liste blanche des chemins de retour ; état CSRF en cookie `httpOnly`.

### Tableau de bord — `/api/dashboard` (`routes/dashboard.ts`)

| Méthode | Chemin | Rôle | Auth |
| --- | --- | --- | --- |
| GET | `/stats` | Statistiques réservations + appels | Bearer |
| GET | `/insights` | Occupation, appels non placés, créneaux de pointe | Bearer |
| GET | `/calls` | Journal d'appels paginé | Bearer |
| POST | `/insights/refresh` | Recalcul des métriques (job `pg_cron`) | En-tête `INTERNAL_SECRET` |

### Autres routers

| Router | Endpoints | Auth |
| --- | --- | --- |
| `/api/email` (`email.ts`) | `POST /bcc` (webhook PMS, en-tête `X-BCC-Secret`) · `GET /bcc` (historique) | BCC secret / Bearer |
| `/api/referral` (`referral.ts`) | `GET /stats` · `GET /list` | Bearer |
| `/api/restaurants` (`restaurants.ts`) | `PATCH /me/language` | Bearer |
| `/api/prefill` (`prefill.route.ts`) | `GET /autocomplete` · `GET /details` (Google Places) | Public |
| `/api/contact` (`contact.ts`) | `POST /` (formulaire de contact) | Public |
| `/api/customers` (`customers.ts`) | `GET /customers` · `PATCH /:id` · `POST /internal/mark-noshows` | Mixte |

## 8. Services & logique métier

### Pont des disponibilités — `availability.service.ts`

`syncAvailabilityRules(restaurantId)` traduit les **horaires d'ouverture affichés** (`opening_hours`, format UI) en **règles de créneaux** (`availability_rules`, lues par le moteur de réservation) :

- Entrée : `opening_hours` (tableau JSON par jour, lundi = index 0, avec `services[{ name, start, end, covers }]`).
- Sortie : lignes `availability_rules` (`day_of_week`, `slot_start/end`, granularité 15 min, `max_covers_per_slot`).
- Remplace atomiquement les anciennes règles à chaque changement d'horaires.
- **Pourquoi c'est critique** : `availability_rules` est la source de vérité des disponibilités réelles. Sans cette synchro, la RPC `get_available_slots` renvoie 0 créneau et l'agent vocal ne peut **jamais** confirmer de réservation.

### Réservation — `booking.service.ts`

`createBooking` / `getBookings` / `getBookingById` / `cancelBooking` + `normalizeBooking` (convertit `booked_for` ISO → `booking_date` + `booking_time`, fusionne les données client, gère `party_size`/`covers`). La création vérifie la disponibilité, déduplique le client par téléphone, puis déclenche les effets de bord (e-mail, calendrier) via l'outbox.

### Voix — `vapi.service.ts` + `services/voice/`

- `VapiService` construit le payload de l'assistant (transcripteur, modèle, voix, **system prompt** dynamique avec nom/adresse/horaires/date du jour, détection de langue FR↔EN), le crée/met à jour, et gère le pool de numéros.
- `services/voice/` orchestre la réservation vocale en machine à états (détection langue → validation date → confirmation créneau → coordonnées → récap → création), avec **idempotence** (`idempotency_key`) contre les doubles réservations sur retry VAPI.

### Calendrier & ICS — `calendar.service.ts`, `ics.service.ts`

Synchronisation Google Calendar (création/suppression d'événements à la réservation/annulation) et génération d'un **flux ICS universel** (`buildIcsFeed`, RFC 5545) consommable par Google/Apple/Outlook via un token public non devinable.

### Provisioning — `provisioning.service.ts`

À la création du restaurant : réservation d'un numéro dans le pool VAPI, création de l'assistant, génération de l'alias BCC `bcc+r-{restaurant_id}@{EMAIL_DOMAIN}`, persistance des IDs, mise à jour du statut.

### Outbox — `webhookQueue.service.ts`

Pattern outbox pour fiabiliser les effets de bord (e-mail, calendrier, HubSpot). _Note : le traitement de fond est encore largement synchrone à ce stade._

## 9. Modèle de données

Principales tables (Supabase / Postgres) :

| Table | Rôle |
| --- | --- |
| `restaurants` | Profil, config, horaires, IDs VAPI/Stripe, statut, slug, `supabase_user_id` |
| `bookings` | Réservations (date, heure, couverts, client, statut) |
| `customers` | Profils clients (téléphone, e-mail, nom) pour la déduplication |
| `availability_rules` | Définition des créneaux (jour, début/fin, capacité) — alimentée par le pont §8 |
| `call_logs` | Journaux d'appels VAPI (durée, statut, réservation créée) |
| `insights_cache` | Métriques quotidiennes (occupation, appels non placés, pointes) |
| `calendar_connections` | Tokens OAuth Google Calendar (par restaurant) |
| `bcc_emails` | Historique des e-mails relayés par les PMS |
| `webhook_outbox` | Effets de bord asynchrones en attente |
| `referrals` / `v_referral_stats` | Suivi du parrainage |

**Migrations** (`/migrations/`) : `add_supabase_user_id.sql`, `add_calendar_oauth_columns.sql`, `add_website_notification_prefs.sql`, `restructure_calendar_multi_provider.sql`.

## 10. Intégrations remplaçables

Conçues comme **optionnelles** : `config.ts` valide leurs secrets s'ils sont fournis, mais le serveur démarre sans eux.

- **Stripe** — client initialisé **paresseusement** ; un `STRIPE_SECRET_KEY` manquant ne fait plus planter le serveur au boot. Les routes checkout/webhook renvoient `503` si non configuré. Le backend reste la **source de vérité** de l'état d'abonnement (`plan` / `is_active`), écrit uniquement depuis les événements Stripe (`checkout.session.completed`, `customer.subscription.updated|deleted`). Les URLs de retour sont dérivées de `config.frontendUrl`.
- **HubSpot** — synchro deals/contacts (optionnel).
- **Pinecone + Gemini/OpenAI (RAG)** — base de connaissances pour l'assistant (optionnel).
- **Google Places (New API)** — préremplissage des infos restaurant à l'onboarding.

## 11. Emails

Deux familles, deux responsabilités :

1. **E-mails métier (backend)** — confirmation/annulation de réservation, e-mails d'essai (cron J-2/J-1/J0), contact. Envoyés via Nodemailer/SMTP (Resend), multilingues FR/EN.
2. **E-mails d'identité (Supabase)** — confirmation d'inscription, réinitialisation de mot de passe, magic link, changement d'e-mail. **Supabase reste responsable** de l'identité et des tokens ; on ne fait que les **rebrander** (noir/vert TableNow, logo `Table<Now>`).

Les templates prêts à coller sont dans [`supabase/email-templates/`](./supabase/email-templates/) (`confirm-signup.html`, `reset-password.html`, `magic-link.html`, `change-email.html`) avec un **README/guide** : où les coller dans le Dashboard Supabase, quelles Redirect URLs autoriser, et comment configurer le SMTP personnalisé pour envoyer depuis `info@tablenow.io`.

## 12. Configuration & variables d'environnement

`src/lib/config.ts` centralise et **valide** (Zod) l'intégralité de l'environnement au chargement (fail-fast : une variable requise manquante = serveur qui refuse de démarrer ; secrets ≥ 32 caractères). Voir [`.env.example`](./.env.example) pour la liste complète.

| Groupe | Variables clés | Requis |
| --- | --- | --- |
| Serveur | `PORT`, `NODE_ENV` | oui |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY` | oui |
| URLs (domaine unique) | `FRONTEND_URL`, `BACKEND_URL` | oui |
| VAPI | `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_PROVISIONING_MODE` | oui (secret optionnel) |
| Google | `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_PLACES_API_KEY` | oui |
| E-mail | `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`, `EMAIL_DOMAIN`, `BCC_SECRET` | oui |
| Auth | `JWT_SECRET`, `INTERNAL_SECRET` | oui |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_*`, `STRIPE_WEBHOOK_SECRET` | **optionnel** |
| RAG / CRM | `PINECONE_*`, `GEMINI_API_KEY`, `HUBSPOT_API_KEY` | optionnel |

> ⚠️ Ne jamais committer `.env` (seul `.env.example` est versionné). Tout secret exposé doit être considéré comme compromis et **tourné immédiatement**.

## 13. Déploiement

- **Docker** — `Dockerfile` multi-stage (compile TS → `dist`, runtime prod-only, `HEALTHCHECK` sur `/health`). `.dockerignore` évite de copier `node_modules`/`.env`.
- **`deploy.sh`** — `git pull` → `npm install --omit=dev` → `npm run build` → vérification des secrets requis → redémarrage `pm2`.
- **Heroku** — hooks `heroku-prebuild` / `heroku-postbuild`.
- **CI** — `.github/workflows/prod-smoke-test.yml` : smoke test post-déploiement (joignabilité, login → token, bootstrap → création restaurant, `app-state` → `next_route`, idempotence du 2ᵉ bootstrap).

## 14. Tests

Jest + `ts-jest` (`jest.config.js`, `src/__tests__/setup.ts` met `LOG_LEVEL=silent`). Suites :

| Suite | Couverture |
| --- | --- |
| `auth/auth.test.ts` · `auth/bootstrap.test.ts` | `getUserFromToken`, `deriveProfile`, `BootstrapSchema`, `resolveNextRoute` |
| `lib/routing.test.ts` | Toutes les branches de `resolveNextRoute` |
| `middleware/validation.test.ts` | Middleware de validation Zod |
| `voice/*.test.ts` | Orchestration de réservation, fiabilité, validation du payload VAPI |
| `webhooks/vapi.webhook.test.ts` | HMAC + parsing du webhook VAPI |
| `endpoints/bookings.test.ts` | `POST /bookings`, `GET /list`, `DELETE /:id` |

```bash
npm test            # tout
npm run test:coverage
```

---

_Documentation mise à jour le 11 juin 2026. Pour le détail des évolutions récentes, voir [`CHANGELOG.md`](./CHANGELOG.md)._
