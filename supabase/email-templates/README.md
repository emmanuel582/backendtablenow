# Templates d'emails d'authentification — TableNow (noir/vert)

**Principe (source de vérité).** Supabase Auth reste responsable de l'**identité**,
des **tokens** de confirmation et du **reset password**. On ne réimplémente PAS
l'authentification dans le backend : on personnalise uniquement **l'apparence** des
emails d'auth (charte noire/verte TableNow). Les emails **métier** (confirmation de
réservation, rappels, essai) restent envoyés par le backend TableNow
(`src/services/email.service.ts`, `src/cron/trialEmails.ts`).

## Fichiers

| Fichier | Template Supabase correspondant |
|---|---|
| `confirm-signup.html` | Confirm signup |
| `reset-password.html` | Reset password (Recovery) |
| `magic-link.html`     | Magic Link |
| `change-email.html`   | Change Email Address |

## Appliquer (Dashboard Supabase)

1. **Authentication → Email Templates** : pour chaque template, coller le contenu HTML
   du fichier correspondant, puis *Save*.
2. **Authentication → URL Configuration → Redirect URLs** : autoriser
   `https://app.tablenow.io/**` (et `http://localhost:5173/**` en dev) pour que
   `{{ .ConfirmationURL }}` redirige vers `/reset-password`, `/auth/callback`, etc.
3. **Project Settings → Authentication → SMTP Settings** : activer *Custom SMTP* pour
   que l'expéditeur soit **TableNow** (et non l'expéditeur Supabase par défaut). Utiliser
   les mêmes identifiants que le backend (`.env` : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASS`) :
   - Sender email : `info@tablenow.io` (= `EMAIL_FROM`)
   - Sender name : `TableNow`
   - Host / Port / User / Pass : identiques à `SMTP_*`

> Sans Custom SMTP, Supabase envoie depuis son domaine partagé (rate-limité, peu
> délivrable). Avec Custom SMTP + ces templates, les emails d'auth sont brandés
> TableNow et partent du bon domaine.

## Variables disponibles
`{{ .ConfirmationURL }}` · `{{ .Token }}` (OTP 6 chiffres) · `{{ .SiteURL }}` ·
`{{ .Email }}` · `{{ .NewEmail }}` (change email) · `{{ .RedirectTo }}`.

## (Optionnel) Application automatisée
Ces templates peuvent aussi être poussés via la **Management API** Supabase
(`PATCH /v1/projects/{ref}/config/auth`, champs `mailer_templates_*_content`) si l'on
veut versionner la config plutôt que de passer par le Dashboard.
