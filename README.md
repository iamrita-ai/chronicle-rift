# ChronicleRift ⚔️

> **An AI-narrated tactical fantasy adventure built for Telegram Rich Messages and Telegram Mini Apps.**

[![CI](https://github.com/iamrita-ai/chronicle-rift/actions/workflows/ci.yml/badge.svg)](https://github.com/iamrita-ai/chronicle-rift/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot%20%2B%20Mini%20App-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![License: MIT](https://img.shields.io/badge/License-MIT-8A2BE2.svg)](LICENSE)

ChronicleRift is deliberately split between two complementary Telegram experiences:

- **Rich Message quest dashboards** for narrative, stats, tables, expandable inventory, and quick turn buttons.
- **A secure Mini App tactical board** for an immersive battle view with Telegram theme support.

The rules are deterministic and server-side. Groq adds concise atmosphere; it never decides combat rewards or player state.

## How to play

ChronicleRift is a **turn-based RPG inside Telegram**. You are a Riftwalker; **one monster
guards each chapter**. Empty its HP bar to clear the chapter and earn Gold, Coins and Points —
then a stronger monster steps up.

**The whole loop:** you tap **ONE** move → the enemy performs the move it already telegraphed
→ repeat.

| Move | Cost | What it does |
| --- | --- | --- |
| ⚔️ **Strike** | 1 Energy | `4–8 + Level + gear + Focus` damage. A perfect roll (8) is a **CRITICAL ×1.5** that sets the enemy **Burning**. |
| 🛡 **Guard** | free, +1 Energy | Ward of `2–5 + gear` is subtracted from the incoming telegraphed hit. A perfect ward **reflects 2**. |
| 🔮 **Scout** | free, +1 Energy | `+1–3 XP` and **exposes** the enemy: next Strike `+2`. |
| 🔥 **Rest** | free, +2 Energy | Recovers `4–7 HP` beside the ember shrine. |

### Combat systems (v0.4)

- **Enemy intent — the enemy always shows its next move.** Every enemy follows a fixed,
  learnable rotation and the next move is displayed before you commit: **Slash** (normal),
  **Heavy Blow** (+4, Guard it), **Rift Drain** (steals 1 Energy), **Mend** (it heals itself —
  Strike now) and the boss-only **Rift Quake** (+6). Guard is therefore a real decision, not a
  coin flip.
- **Focus — the combo meter.** Guard, Scout and Rest each add **+1 Focus** (max 3). Your next
  Strike spends **all** of it for **+2 damage per point**. Set up, then swing.
- **Burn.** Critical hits burn the enemy for `3` damage at the start of each of your next
  2 turns.
- **Finisher hint.** When a minimum Strike roll would end the fight, the Mini App lights the
  Strike button and the bot says so.
- **Coach line.** Both surfaces print one always-correct suggested move, so a new player is
  never staring blankly at four buttons.
- **Death is safe:** at 0 HP you wake at camp fully healed and keep everything.
- **Bosses:** every 5th chapter the **Ebon Colossus** appears with bonus stats and **double rewards**.
- **Marketplace:** spend Coins on potions and permanent relics (`/shop` or the Mini App).
- The full guide is in `/help`, on the 📖 How to Play button, and in the Mini App's four-slide
  onboarding.

### Items, loot and the Forge (v0.5)

The Mini App is now the main way to play; the bot is the launcher.

| Category | Items |
| --- | --- |
| **Healing** | Ember Salve (+8 HP) · Healing Draught (+15) · Greater Draught (+30) · Emberweave Balm (regen 5 HP × 3 turns) · **Phoenix Tear** (full HP + full Energy) |
| **Tactical** | Rift Elixir (+3 Energy) · Clarity Tonic (Focus to max) · Rift Grenade (12 unblockable damage) · Veil Powder (the enemy misses its next move) |
| **Relics (permanent, level 1→5)** | Rift Steel (+2 Strike/lv) · Aegis Sigil (+2 Ward/lv) · Luck Charm (+1 Scout insight/lv) · Ember Heart (+5 max HP/lv) · Rift Core (+1 max Energy/lv) |
| **Treasure (sell only)** | Ash Shard 12🪙 · Rift Pearl 26🪙 · Colossus Fang 44🪙 · Gilded Idol 75🪙 |

- **Loot:** every cleared chapter opens a reward chest with 2–3 random items (bosses roll 4–5
  on a much richer table). A modal reveals each drop with its artwork.
- **Satchel:** every item shows its picture, rarity, ability and sale value. Potions can be
  used from a **quick-use strip** right under the action buttons, mid-fight, for free.
- **Forge:** spend coins to raise any owned relic one level at a time to 5, with the exact
  next-level bonus shown before you pay.
- **Sell:** turn treasure into coins from the satchel.
- **Sound & feel:** every action, hit, block, crit, heal, coin, forge and victory has a
  procedurally synthesised sound effect (no audio files, works offline) plus slash streaks,
  impact flashes and ward rings. Mute from the speaker button in the header.
- API: `POST /api/use`, `POST /api/sell`, `POST /api/upgrade` alongside `/api/actions` and
  `/api/buy`. All of them are server-authoritative and Telegram-authenticated.

### Preview the Mini App without Telegram

```bash
python tools/preview_miniapp.py     # http://localhost:8080
```

Runs the real engine and the real UI in memory (no MongoDB, no Telegram auth) so combat and
visuals can be iterated on locally. Development only.

## What it ships

| Capability | Implementation |
| --- | --- |
| Telegram bot | Current `python-telegram-bot` handlers for `/start`, `/play`, `/status`, `/shop`, `/rules`, `/about`, `/app`, and `/help` |
| Colored buttons | Native Bot API button styles (primary/success/danger) via PTB `InlineKeyboardButton(style=...)` |
| Player economy | XP, **Coins**, **Points**, and **Gold** tracked server-side and exposed in the dashboard and Mini App |
| Item system | 18-item catalogue with artwork, rarities and abilities: consumables, upgradeable relics and sellable treasure |
| Loot | Random reward chest on every chapter clear, with an illustrated reveal |
| Marketplace | Coin-purchasable consumables and relics via `/shop` and `/api/buy` |
| Level progress | XP progress bar toward the next level on the dashboard and Mini App |
| Rules & version | `/rules` (Chronicle regulations) and `/about` (game version and info) commands |
| Native Rich Messages | Explicit raw Bot API `sendRichMessage` adapter using `rich_message: {"markdown": ...}` |
| Graceful fallback | If Rich Messages are disabled, unavailable, or rejected, an equivalent ordinary Telegram message is sent with the same controls |
| Mini App | Responsive tactical UI served from the **same FastAPI service** at `/app/` |
| Mini App security | Backend-only Telegram `initData` HMAC validation + `auth_date` freshness check; no trust in `initDataUnsafe` or browser-supplied IDs |
| AI narration | Groq async client, configurable model, bounded prompt/output, and deterministic fallback narration |
| Durable state | MongoDB player profile, hero stats, quest, enemy/battle state, inventory, progression, narration, and optimistic revision |
| Deployment | Secure webhook registration, health endpoint, Dockerfile, and Render Blueprint |

## Experience design

**Rich Message surface**

1. A hero uses `/start` or `/play`.
2. The bot shows Chapter, HP, Energy, XP, Gold, **Coins**, **Points**, a **level-progress bar**, enemy essence, quest objective, inventory, and colored action buttons.
3. Choosing **Strike**, **Guard**, **Scout**, or **Rest** resolves the turn on the server, saves it in MongoDB, and posts an AI-flavored update.
4. `/shop` opens the Marketplace to spend Coins on healing, energy, and permanent upgrades; `/rules` lists the Chronicle's regulations; `/about` shows the game version.
5. Native Rich Message support is attempted first; clients or Bot API deployments without it still receive a normal, readable dashboard.

**Mini App surface**

1. From a private chat, the player opens **Tactical Mini App** — first launch shows a four-slide "How to Play" guide (always reopenable from the ? button).
2. The browser sends only `Telegram.WebApp.initData` to `/api/me` and `/api/actions`.
3. FastAPI verifies Telegram's signature and timestamp before using the authenticated Telegram identity.
4. The **Rift Arena** view renders the enemy-intent telegraph card, the Focus combo meter, burn/exposed/finisher states, a coach tip, AI-generated artwork for the hero, the realm, and every enemy, animated health/energy/XP bars, floating damage numbers, critical-hit flashes, victory banners with reward breakdowns, a live battle log, and the illustrated Marketplace.
5. The API returns a structured `turn.effects` payload (damage, crits, healing, wards, rewards) so clients can render combat unambiguously. The UI never sends or controls HP, gold, inventory, revision, or another user's ID.

## Architecture

```text
Telegram update ──► FastAPI secure webhook ──► python-telegram-bot handlers
                                                     │
                                          GameService / pure game engine
                                             │                 │
                                             ▼                 ▼
                                         MongoDB          Groq narrator

Telegram Mini App ──► FastAPI /api/* ──► Telegram initData validation
       ▲                       │
       └──── static /app/ ◄────┘
```

### Core modules

```text
src/chronicle_rift/
├── bot.py             # PTB commands, callback actions, Mini App button
├── config.py          # typed environment configuration and safe derived values
├── database.py        # PyMongo native async repository + optimistic updates
├── game_engine.py     # pure tactical turn resolution
├── game_service.py    # orchestration, retries, narration, persistence
├── narrator.py        # Groq bounded narration + fallback
├── rich_messages.py   # sendRichMessage adapter and ordinary-message fallback
├── security.py        # Mini App HMAC and webhook secret validation
├── main.py            # FastAPI app, webhook, authenticated API, static app
└── webapp/            # dependency-free Telegram Mini App UI
```

## Prerequisites

- Python **3.11+**
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A MongoDB connection URI (Atlas or self-hosted)
- A [Groq API key](https://console.groq.com/)
- A public **HTTPS** URL for webhook and Mini App deployment (Render supplies one)

> **Do I need Telegram `API_ID` and `API_HASH`?** No. ChronicleRift uses the standard Telegram **Bot API**, so a BotFather token is all the normal bot flow needs. The optional variables are accepted only for future MTProto-related extensions and must be supplied together if used.

## Local setup

```bash
# 1. Clone after the repository has been created.
git clone https://github.com/iamrita-ai/chronicle-rift.git
cd chronicle-rift

# 2. Create a private local environment file.
cp .env.example .env
# Edit .env: BOT_TOKEN, MONGODB_URI, and GROQ_API_KEY are required.

# 3. Install the package and developer tooling.
python -m pip install -e '.[dev]'

# 4. Start in local polling mode (the default in .env.example).
python -m chronicle_rift
```

Local polling is ideal for bot-command development. A Telegram Mini App button needs an HTTPS URL, so deploy to Render or expose the same service through an HTTPS tunnel before testing it in Telegram.

### Run checks

```bash
ruff check .
pytest
```

## Environment variables

Copy [`.env.example`](.env.example); it contains placeholders only. Do not commit `.env`.

| Variable | Required | Purpose |
| --- | :---: | --- |
| `BOT_TOKEN` | Yes | BotFather token used by the Bot API and Mini App HMAC validation |
| `MONGODB_URI` | Yes | `mongodb://` or `mongodb+srv://` persistence connection URI |
| `GROQ_API_KEY` | Yes | Groq API credential for narration |
| `GROQ_MODEL` | No | Narration model; default `openai/gpt-oss-20b` |
| `MONGODB_DATABASE` | No | Database name; default `chronicle_rift` |
| `BOT_MODE` | No | `polling` locally or `webhook` for Render |
| `RENDER_EXTERNAL_URL` | Render | Automatically detected Render HTTPS origin |
| `PUBLIC_BASE_URL` | No | HTTPS origin override for a custom domain / webhook URL |
| `WEBHOOK_SECRET` | No | URL-safe webhook secret; automatically derived if omitted, generated by the Render Blueprint |
| `WEBHOOK_PATH` | No | Inbound path; default `/telegram/webhook` |
| `PORT` | No | HTTP port; Render supplies it |
| `MINI_APP_PATH` | No | Same-service static app path; default `/app` |
| `MINI_APP_URL` | No | Optional HTTPS Mini App URL override (normally derived from public base URL) |
| `RICH_MESSAGES_ENABLED` | No | `true` by default; set `false` to force normal message fallback |
| `MINI_APP_AUTH_MAX_AGE_SECONDS` | No | Signed Mini App session age; default `3600` seconds |
| `API_ID` / `API_HASH` | No | Optional pair; not necessary for this Bot API application |
| `ALLOWED_USER_IDS` | No | Comma-separated Telegram user-ID allow-list; unset allows all users |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL` |

## Deploy to Render

The included [`render.yaml`](render.yaml) creates a web service with a `/healthz` health check and `BOT_MODE=webhook`.

1. Push this repository to GitHub and create a **Web Service** from the Render Blueprint, or connect the repository manually.
2. In Render, set the secret values:
   - `BOT_TOKEN`
   - `MONGODB_URI`
   - `GROQ_API_KEY`
3. Keep the Blueprint-generated `WEBHOOK_SECRET`, or set your own 1–256 character URL-safe value.
4. Deploy. ChronicleRift detects Render's HTTPS URL through `RENDER_EXTERNAL_URL`. If using a custom domain, set `PUBLIC_BASE_URL=https://your-domain.example`.
5. Open `https://<your-service>/healthz`; expect `{"status":"ok",...}`.
6. Open your bot in a **private** Telegram chat, send `/start`, then tap **Tactical Mini App**.

On startup, the app calls `setWebhook` with the secure path and secret token. It does **not** delete the webhook on shutdown, avoiding a deployment gap during a rollout.

### Docker

```bash
docker build -t chronicle-rift .
docker run --rm --env-file .env -p 10000:10000 chronicle-rift
```

For a public container deployment, set `BOT_MODE=webhook` and either `PUBLIC_BASE_URL` or the platform's compatible `RENDER_EXTERNAL_URL` equivalent.

## API contract

All game API routes are same-origin and authenticated. The Mini App sends the signed header automatically.

| Route | Method | Authentication | Description |
| --- | --- | --- | --- |
| `/healthz` | `GET` | none | Deployment health response |
| `/app/` | `GET` | Telegram UI handles launch | Tactical Mini App assets |
| `/api/me` | `GET` | `X-Telegram-Init-Data: <signed initData>` | Authoritative player view (includes `shop` and `version`) |
| `/api/actions` | `POST` | same header | Accepts only `{ "action": "strike\|guard\|scout\|rest" }` |
| `/api/buy` | `POST` | same header | Accepts only `{ "item_id": "heal\|elixir\|blade\|ward\|charm" }` |
| `/telegram/webhook` | `POST` | Telegram webhook secret header | Internal bot update endpoint |

The browser can also use `Authorization: tma <signed initData>`. No endpoint accepts a frontend `user_id`, profile object, arbitrary game state, or `initDataUnsafe`.

## Security notes

- **Mini App HMAC:** `security.py` implements Telegram's documented `WebAppData` HMAC verification and rejects malformed, duplicate, tampered, future-dated, and expired payloads.
- **Freshness:** signed `auth_date` is checked with a configurable maximum age (one hour by default).
- **Webhook verification:** every webhook request must match Telegram's `X-Telegram-Bot-Api-Secret-Token` using constant-time comparison.
- **Server authority:** stats, rewards, enemy damage, coins, points, inventory, shop purchases, and progression live only in MongoDB. The Mini App submits a validated identity plus one action or item purchase.
- **Race handling:** MongoDB `revision` values provide optimistic concurrency; a simultaneous turn is retried against the latest authoritative state.
- **AI boundary:** Groq receives only a short, server-generated game summary. Its text is cleaned for the Rich Message renderer, and mechanics remain deterministic.
- **Secret hygiene:** fields are hidden from settings reprs, `.env*` is ignored except the placeholder example, and no credential is present in this repository.

If you discover a security issue, see [SECURITY.md](SECURITY.md) and do not publish exploitable details in a public issue.

## Rich Message compatibility

`python-telegram-bot` handles ordinary Bot API updates, while `rich_messages.py` intentionally uses a tiny raw HTTP adapter for `sendRichMessage`. This means the project can adopt native Rich Messages without waiting for a high-level SDK type.

Rich Message availability can vary by Bot API endpoint, rollout, or client. That is why every Rich Message send has a safe normal-message fallback with the same quest information and buttons. Set `RICH_MESSAGES_ENABLED=false` if you prefer to force the fallback.

## License

Released under the [MIT License](LICENSE).
