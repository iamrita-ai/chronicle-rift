# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability involving credentials, Telegram authentication, player data, or webhook handling. Contact the repository owner privately with:

- a concise description and impact,
- reproducible steps or a proof of concept,
- affected version / deployment details, and
- any recommended mitigation.

Please allow reasonable time for triage and remediation before disclosure.

## Deployment checklist

- Use a unique `BOT_TOKEN`, `GROQ_API_KEY`, and MongoDB user with least-privilege access.
- Keep `.env` out of Git; start from `.env.example` only.
- Set a high-entropy explicit `WEBHOOK_SECRET` or retain Render's generated value.
- Use HTTPS for all public webhook and Mini App URLs.
- Restrict MongoDB network access and rotate credentials if exposure is suspected.
- Keep `MINI_APP_AUTH_MAX_AGE_SECONDS` reasonably short.
- Use `ALLOWED_USER_IDS` when the game is meant to be private.

ChronicleRift validates Mini App `initData` on the server. Never replace that validation with browser-provided `initDataUnsafe` or a frontend user ID.
