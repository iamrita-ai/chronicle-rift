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

The Mini App is the main way to play; the bot is the launcher.

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

### Heroes, three attacks and the animated stage (v0.6)

The Mini App is now a **multi-screen game**. The bot is only the launcher.

**Home screen** — your hero portrait, wallet, quest card with the next monster, and tiles for
**Store**, **Satchel**, **Heroes** and **Settings**. A bottom tab bar switches screens.
**Battle screen** — nothing but combat: the animated stage, your three attacks, Guard/Scout/Rest,
a **healing-only quick rail**, and an **instant restock prompt the moment your last potion is
used**, so you never have to leave a fight to shop.

**Playable heroes** — each has its own element, stats and three attacks (1 / 2 / 3 Energy):

| Hero | Element | Cost | HP / EN / PWR | Special |
| --- | --- | --- | --- | --- |
| **Emberblade** | Fire | free | 24 / 5 / +1 | *Cinder Wave* — sets Burning for 3 turns |
| **Frostward** | Snow (Ice) | 260🪙 | 30 / 4 / +0 | *Deep Freeze* — stuns, skipping the counterattack |
| **Stormcaller** | Wind | 420🪙 | 22 / 6 / +1 | *Gale Flurry* — second hit at 50%, refunds 2 Energy |
| **Arcanist** | Magic (Arcane) | 640🪙 | 22 / 6 / +2 | *Mind Siphon* — unblockable, heals 50% of damage |
| **Voidreaper** | Shadow | 950🪙 | 26 / 5 / +3 | *Soul Harvest* — heals 40% and grants 2 Focus |

Damage = `roll + Level + gear + Power (+2 exposed, +2 per Focus)`; a maximum roll is a
**critical ×1.5**. Attacks cost Energy — with none left the turn is refused, not wasted.

**Monsters have their own ability and toughness per level.** Ash Warden (Fire · Cinder Aura),
Obsidian Herald (Arcane · Rift Drain), Rift Stalker (Shadow · Mend), Frost Revenant (Ice ·
Rime Grip) rotate by chapter and gain HP and attack each tier; the **Ebon Colossus** (Shadow ·
Rift Quake, +25% HP) is the boss every 5th chapter.

**Animation.** Both fighters are full-body 2D sprites — hero facing right, monster facing left —
composited with `mix-blend-mode: screen`. They idle-bob, lunge on attack, wind up and glow on a
special, recoil and flash white when hit, and dissolve on defeat, with element-tinted slashes,
impact bursts, shockwave rings, floating damage/heal numbers and a camera shake on heavy hits.
Motion respects `prefers-reduced-motion`, and shake/sound/haptics are toggleable in Settings.

New endpoints: `POST /api/character/buy` and `POST /api/character/select`.

### The real-time arena (v0.7)

The chapter fight is no longer a menu: it is a **playable 2.5D side-view duel** in one
continuous arena, built on a custom canvas engine (`webapp/arena.js`). **Nothing in the fight is
a static image** — both fighters are articulated game objects (torso, head, two arms with
forearms, two legs with knees, cape and weapon) posed every frame by a procedural animation
system, simulated with velocity, gravity, depth, body collision, hitboxes and hurtboxes.

**Controls (permanent, mobile-first)**

```
                              ABILITY 1
        joystick        ABILITY 2   ABILITY 3
      (move x + depth)          ATTACK
```

- Left: a virtual joystick — forward, backward, left and right along the arena's depth lane.
  Characters always turn to face their opponent when they attack.
- Right: a large, always-visible basic-attack button with three ability buttons above it. Every
  button is real: each ability has its own independent cooldown, a circular cooldown overlay,
  the remaining seconds printed on top, and it re-enables itself the moment the cooldown ends.
  Abilities also cost stamina, so mashing is punished.
- Desktop testing: WASD/arrows to move, Space or J to attack, U/I/O for the abilities.

**Per-character kits.** Each element has a name, health, damage, movement speed, attack range,
attack speed, critical chance, defence, a basic attack and three unique abilities with their own
cooldowns and visual effects:

| Element | Basic | Ability 1 | Ability 2 | Ability 3 |
| --- | --- | --- | --- | --- |
| Fire | Ember Slash | Molten Cleave — heavy, huge knockback | Cinder Wave — projectile, Burn DoT | Ember Dash — i-frame dash that damages |
| Snow | Rime Jab | Glacier Smash — heavy, slows | Deep Freeze — projectile, freezes solid | Frost Barrier — halves damage 5s |
| Wind | Twin Slice | Cyclone Kick — 3-hit whirl | Gale Flurry — 3 gusts | Blink — teleport behind, +50% speed |
| Magic | Rune Bolt | Sigil Burst — heavy AoE | Mind Siphon — unblockable, heals 50% | Rune Ward — ward + stamina |
| Shadow | Reap | Grave Arc — wide heavy | Soul Harvest — drain + slow | Shadowstep — vanish, next hit empowered |

**Damage is never granted by an animation.** An attack spawns a hitbox only during its active
frames; damage is applied strictly when that hitbox overlaps the opponent's hurtbox in x, depth
and height, once per swing. The number that appears is
`character damage × ability multiplier × variance`, times **1.75 on a critical**, reduced by
`defence / (defence + 70)` and again by any active shield.

**Hit feedback.** Every connection runs attack animation → hit effect → damage number → hit
reaction → health drop: slash arcs and sparks on basics; shockwave rings, shards, knockback,
lift and a strong camera kick on heavies; glowing projectiles with motion trails and an
explosion of motes on magic. Impacts add hitstop (brief freeze frames), screen shake scaled to
the blow, a white flash on the struck body and a trailing "ghost" health bar.

**Animation states.** Idle breathing, walk cycle (with a distinct backpedal), basic attack,
one animation per ability, hit reaction, knockback tumble, defeat collapse and a victory pose,
all cross-faded through a per-joint interpolation rate for smooth transitions.

**Camera.** Follows the midpoint between the fighters and zooms between 0.62× and 1.32× so both
are always framed — in tight when they close, out when they separate — with clamped shake.

Outcomes stay server-authoritative: winning posts to `POST /api/arena/finish`, which routes
through the same victory path as before (gold, coins, points, XP, loot chest, next chapter),
and losing wakes you at camp fully healed. Reported health is clamped to your real maximum.

### v0.9 — jointed fighters, real weapon swings, bigger enemies

* **Every fighter is a jointed puppet drawn frame by frame** — pelvis, spine,
  neck, head, two-bone arms, two-bone legs, cloth cape and a weapon welded to
  the hand. No artwork is pasted into the arena any more, so hands, legs, neck
  and head all move independently instead of a picture shaking.
* **Weapons swing with the arm.** The blade is rigid to the wrist joint, and the
  glow trail is traced along the hand's real swing arc.
* **Abilities are full motions with travel.** Wind-up shifts weight back, the
  active frame drives the body forward with a genuine velocity impulse (heavy
  slams lunge, cyclone spins the whole body, casts recoil), so hitboxes follow
  the movement instead of a static shake.
* **Size hierarchy:** the hero is normal sized (116 units), regular enemies are
  ×1.22 and bosses ×1.55 — evil is always physically bigger than you.
* **Bot home screen stripped** to a single line and one PLAY button; no status
  cards, no rich message walls.
* Cheaper drawing: one filled capsule per limb, no `shadowBlur`, no sprite
  keying at load.

### v0.8 — real fighters, landscape, faster, better sound

- **The fighters are the artwork.** Each character and monster PNG is keyed to transparency once
  at load (luminance to alpha, then auto-trimmed), split into a torso and a legs piece, and driven
  as a two-part puppet: idle **breathing** (chest rise + drift), walk bounce with footstep dust
  and sound, hip-driven lunges, recoil, tumble, collapse and a victory bounce. No stick figures.
- **Landscape, full screen.** The arena fills the display; in portrait the whole fight surface is
  rotated so the phone can simply be turned sideways, with a rotate hint the first time.
- **Horizontal-only movement**, as a side-view fighter should be: the joystick drives left/right
  and both fighters share one ground line.
- **Performance pass.** Pixel-budget-aware DPR, no `shadowBlur` in the hot path (all glows are
  pre-rendered tinted sprites drawn with `lighter`), cached gradients, particle caps, single-pass
  effect loops and a backdrop drawn as one parallax `drawImage`.
- **Scenario backdrops** picked from the monster's element: Ember Keep (fire), Frost Cathedral
  (ice), Arcane Ruins (magic/wind) and the Void Colosseum for shadow and every boss.
- **New audio bank** — a proper synth with envelopes, filters, a compressor and a short ambience
  delay: distinct whoosh, metal clang tuned per element, deep thud, ice shatter, fire boom,
  magic shimmer, ward chime, dash, footsteps, hurt grunt, K.O. and victory fanfare.
- **The bot's Rich Messages were reorganised**: one tidy status card (hero line, XP bar, a single
  value table, chapter block with the next foe and its ability) and a Marketplace grouped into
  Consumables and Relics tables, instead of the old wall of text.

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
