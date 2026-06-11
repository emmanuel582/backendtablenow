# Changelog — TableNow Backend

Format : entrées par date, avec le hash de commit. Les dates sont en heure UTC.

---

## Semaine du 4 au 10 juin 2026

Thèmes : **pont des disponibilités** (déblocage de la réservation vocale), **Stripe rendu remplaçable** + centralisation/validation de la config, **source de domaine unique**, **images Docker**, **emails Supabase rebrandés**, **durcissement de l'authentification** et consolidation de la **source unique de routage**.

### 10 juin 2026

- **`39bcc5d` — feat(availability) : restauration du pont `opening_hours → availability_rules`.**
  Le moteur de réservation résout les créneaux via la RPC `get_available_slots`, qui lit `availability_rules`. Sur `main`, cette table n'était jamais alimentée : toute vérification renvoyait 0 créneau et l'agent vocal ne pouvait **jamais** confirmer de réservation. La synchro est désormais rejouée à chaque changement d'horaires, via l'unique point d'écriture `PUT /settings` (utilisé par l'onboarding **et** les réglages). `availability_rules` devient la source de vérité, dérivée des `opening_hours` affichés.

- **`fb35d82` — fix(stripe, config) : Stripe devient une intégration remplaçable + validation des secrets.**
  `config.ts` centralise et valide les clés Stripe, le secret de webhook VAPI et le secret BCC — tous **optionnels** : le serveur démarre sans eux (intégrations remplaçables, pas le cœur). `stripe.ts` n'appelle plus `new Stripe()` au chargement du module (un `STRIPE_SECRET_KEY` manquant faisait planter tout le serveur au boot) : le client est construit paresseusement, et checkout/webhook renvoient `503` si Stripe n'est pas configuré. Les URLs de checkout sont dérivées de `config.frontendUrl` ; `cancel_url` pointe sur la vraie page `/r/:slug/billing`. Le webhook gère `checkout.session.completed` pour lier l'abonnement immédiatement ; le backend reste la source de vérité de l'état d'abonnement.

- **`239701c` — refactor(domain) : URLs backend dérivées de la config (source de domaine unique).**
  Plus aucun `tablenow.io` codé en dur dans le runtime ; changer de domaine = une ligne d'env (`FRONTEND_URL` / `BACKEND_URL`). Les origines CORS sont dérivées de `FRONTEND_URL` (app + apex + www) ; `vapi.service.ts` utilise `config.backendUrl` ; le CTA des e-mails d'essai pointe sur la vraie page `/r/:slug/billing`.

- **`8a7fe6d` — build(docker) : image de déploiement backend (portée depuis creezio).**
  Image multi-stage éprouvée (build TS → `dist`, runtime prod-only, `HEALTHCHECK` sur `/health`) + `.dockerignore` pour que `node_modules`/`.env` ne soient jamais copiés dans le contexte de build.

- **`8ccf61b` — feat(emails) : templates d'e-mails d'auth Supabase brandés (noir/vert) + guide.**
  Décision : Supabase reste responsable de l'identité + des tokens (confirmation d'inscription, reset mot de passe, magic link, changement d'e-mail) — pas d'auth parallèle dans le backend. On ne fait que **restyler** les e-mails à la marque TableNow. Ajout des templates HTML prêts à coller + un README couvrant : où les coller dans le Dashboard Supabase, les Redirect URLs à autoriser, et le SMTP personnalisé pour envoyer depuis `info@tablenow.io`.

- **`d0795a1` — feat(emails) : alignement des templates Supabase sur la maquette de vérification.**
  `confirm-signup` reprend la maquette « Email vérif » (anneau enveloppe, bloc « UNE FOIS ACTIVÉ », fallback OTP). Logos unifiés en `Table<Now>` sur tous les templates.

- **`db29d17` — fix(emails) : enveloppe blanche dans le template de vérification** (conformité maquette).

- **`b2e7472` — fix(auth) : `bootstrap` utilise `getUserFromToken` au lieu d'un `fetch` brut.**
  Le bootstrap validait le token via un `fetch` direct vers `SUPABASE_URL/auth/v1/user`, court-circuitant le `getUserFromToken()` centralisé du middleware (deux chemins de validation divergents + dépendance directe à `process.env`). Désormais, un seul chemin ; le token est accepté depuis le body **ou** l'en-tête `Authorization`.

- **`cb769f5` — fix(auth) : validation Zod stricte sur `/bootstrap`, masquage des détails d'erreur.**
  `BootstrapSchema.strict()` valide `{ access_token }` uniquement ; le fallback par en-tête `Authorization` est retiré (le bootstrap est explicite). Les détails d'erreur Supabase ne fuitent plus dans les réponses 500 (loggés côté serveur uniquement).

### 8 juin 2026

- **`67ede58` — Make next_route a deterministic single source of routing truth.**
  `resolveNextRoute` renvoie la cascade d'identité complète (restaurant incomplet → `/r/:slug/onboarding`, complet → `/r/:slug/dashboard`) ; en contexte authentifié, un restaurant/slug manquant renvoie `null` (signal d'erreur contenu, **jamais** `/login`). `GET /auth/app-state` dérive les statuts réels (onboarding / provisioning / assistant) depuis les vraies colonnes (`is_complete`, `vapi_phone_number`, `vapi_assistant_id`, `status`) au lieu de valeurs codées en dur. Nouveau `routing.test.ts` qui fige la cascade. _(Fusionné dans `main` via la PR #14.)_

### 4 juin 2026

- **`7eda6c0` — security(auth) : vérification de confirmation d'e-mail + suppression du code d'auto-liaison mort.**
  Ajout du contrôle `email_confirmed_at` (défense en profondeur : la sécurité backend ne dépend plus de la config du Dashboard Supabase). Suppression du fallback d'auto-liaison par e-mail : `/auth/bootstrap` devient l'unique point de liaison. Le middleware a désormais une responsabilité unique et claire : validation d'authentification uniquement.

---

> Les évolutions antérieures (extraction du cœur vocal, atomicité transactionnelle des réservations via `create_booking_with_outbox`, passage aux logs Pino structurés, résilience des webhooks + rate limiting, i18n FR/EN…) sont visibles dans l'historique Git (`git log`).
