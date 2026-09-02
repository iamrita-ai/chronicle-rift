# Contributing to ChronicleRift ⚔️

Thanks for wanting to help — the Rift grows with its players.

## Ways to contribute

- 🐛 **Bug reports** — press the 💬 **Feedback** button in the bot (it reaches the owner directly) or [open an issue](https://github.com/iamrita-ai/chronicle-rift/issues) with what you did, what happened, and what you expected.
- ✨ **Feature ideas** — new heroes, abilities, monsters, arenas. Same feedback button, same issues.
- 🔧 **Code** — fixes, balance, performance, tooling. PRs are welcome.

## Working on the code

```bash
git clone https://github.com/iamrita-ai/chronicle-rift.git
cd chronicle-rift
python -m pip install -e '.[dev]'
cp .env.example .env          # fill BOT_TOKEN, MONGODB_URI, GROQ_API_KEY
python -m chronicle_rift      # local polling mode
```

### Before you open a PR

```bash
ruff check .      # must pass
pytest            # must pass (65 tests)
```

- Keep server authority: combat math, rewards and inventory never move to the client.
- The Mini App is dependency-free and ships without a build step — keep it that way.
- New heroes/monsters need: a kit in `webapp/arena.js`, stats in `models.py`, and a rig that reads well in motion (try it in `webapp/demo-harness.html`).

### Useful tools

| Tool | What it does |
| --- | --- |
| `python tools/capture_screens.py` | UI smoke test + screenshots into `docs/assets/` |
| `python tools/capture_demo.py` | Records the gameplay GIF/MP4 with headless Chromium |
| `webapp/demo-harness.html` | Drives the arena engine standalone, no backend needed |
| `python tools/preview_miniapp.py` | Serves the webapp for a quick browser look |

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md) — private disclosure, no public issues for exploitable details.
