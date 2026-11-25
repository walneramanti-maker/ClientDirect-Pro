# ClientDirect Pro

Plateforme multi-entreprises : inscription des professionnels, site créé automatiquement, rendez-vous sans double réservation,
devis, assistant IA 24 h/24 (Premium), abonnements Stripe, e-mails et WhatsApp automatiques, administration générale,
prospection (registre Sirene), assistance automatique, événements vers Make.

Node.js 22.5+ sans aucune dépendance. Base SQLite (fichier unique, à placer sur un disque persistant).

    npm test                      # 20 tests automatiques
    cp .env.example .env          # puis remplir
    ADMIN_LOGIN=... ADMIN_PASSWORD=... npm run create-admin   # compte admin + clé 2FA
    npm start

## Make
Chaque événement part dans la file d'envoi (5 tentatives) puis vers `MAKE_WEBHOOK_URL`, signé dans l'en-tête
`x-cdp-signature` (HMAC SHA-256 du corps avec `MAKE_WEBHOOK_SECRET`). Corps : `{ event, at, data }`.
Par défaut seuls les événements rares sont envoyés (offre Make gratuite = 1 000 crédits/mois, 2 scénarios actifs).
Les confirmations et rappels clients ne passent pas par Make : ils partent directement (Brevo, WhatsApp) pour ne pas
consommer de crédits.

## Hébergement
Render gratuit : pas de disque persistant (la base serait effacée à chaque redéploiement) et mise en veille après 15 min.
Pour la production : Render Starter (7 $/mois) + disque 1 Go (0,25 $/mois), ou un VPS OVH (à partir de 3,81 € HT/mois).
