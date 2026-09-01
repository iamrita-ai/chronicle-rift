/* ChronicleRift Mini App — v0.6.0
 * Multi-screen client: Home hub, animated battle stage, store, satchel, settings.
 */
(() => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ART = (name, ext = "jpg") => `./art/${name}.${ext}`;
  const HEAL_KEYWORDS = ["salve", "draught", "greater_draught", "regen_balm", "phoenix_tear", "elixir"];

  const state = {
    player: null,
    version: "",
    busy: false,
    screen: "home",
    tab: "heroes",
    settings: {
      sound: true,
      haptics: true,
      shake: true,
    },
    lastHeroHp: null,
    lastEnemyHp: null,
    restockShown: false,
  };

  /* ------------------------------------------------------------------ *
   * settings persistence
   * ------------------------------------------------------------------ */
  const SETTINGS_KEY = "cr_settings_v1";
  function loadSettings() {
    try {
      Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
    } catch (_) {
      /* ignore */
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * audio
   * ------------------------------------------------------------------ */
  let audioCtx = null;
  function tone({ freq = 440, type = "sine", dur = 0.16, gain = 0.15, slide = 0, delay = 0 }) {
    if (!state.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t0 = audioCtx.currentTime + delay;
      const osc = audioCtx.createOscillator();
      const amp = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (_) {
      /* audio is a nice-to-have */
    }
  }
  const SFX = {
    tap: () => tone({ freq: 520, type: "triangle", dur: 0.06, gain: 0.07 }),
    strike: () => {
      tone({ freq: 320, type: "square", dur: 0.1, gain: 0.12, slide: -180 });
      tone({ freq: 880, type: "triangle", dur: 0.08, gain: 0.06, delay: 0.03 });
    },
    heavy: () => {
      tone({ freq: 160, type: "sawtooth", dur: 0.22, gain: 0.16, slide: -90 });
      tone({ freq: 70, type: "sine", dur: 0.3, gain: 0.18 });
    },
    special: () => {
      tone({ freq: 420, type: "sine", dur: 0.3, gain: 0.12, slide: 600 });
      tone({ freq: 840, type: "triangle", dur: 0.35, gain: 0.08, delay: 0.08, slide: 400 });
    },
    hurt: () => tone({ freq: 220, type: "sawtooth", dur: 0.16, gain: 0.12, slide: -120 }),
    heal: () => {
      tone({ freq: 660, type: "sine", dur: 0.18, gain: 0.1 });
      tone({ freq: 990, type: "sine", dur: 0.22, gain: 0.08, delay: 0.08 });
    },
    coin: () => {
      tone({ freq: 1180, type: "square", dur: 0.06, gain: 0.07 });
      tone({ freq: 1560, type: "square", dur: 0.09, gain: 0.06, delay: 0.05 });
    },
    victory: () => {
      [523, 659, 784, 1046].forEach((f, i) =>
        tone({ freq: f, type: "triangle", dur: 0.22, gain: 0.11, delay: i * 0.1 }),
      );
    },
    defeat: () => {
      [392, 330, 262].forEach((f, i) =>
        tone({ freq: f, type: "sawtooth", dur: 0.28, gain: 0.1, delay: i * 0.14 }),
      );
    },
  };
  function haptic(kind = "light") {
    if (!state.settings.haptics) return;
    try {
      if (kind === "success" || kind === "error" || kind === "warning") {
        tg?.HapticFeedback?.notificationOccurred(kind);
      } else {
        tg?.HapticFeedback?.impactOccurred(kind);
      }
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * networking
   * ------------------------------------------------------------------ */
  function authHeaders() {
    const initData = tg?.initData || "";
    const headers = { "Content-Type": "application/json" };
    if (initData) headers["X-Telegram-Init-Data"] = initData;
    return headers;
  }
  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data?.detail) detail = data.detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(detail);
    }
    return res.json();
  }

  /* ------------------------------------------------------------------ *
   * toast
   * ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(message, kind = "info") {
    const node = $("toast");
    node.textContent = message;
    node.className = `toast is-${kind}`;
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add("is-visible"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.classList.remove("is-visible");
      setTimeout(() => (node.hidden = true), 260);
    }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * navigation
   * ------------------------------------------------------------------ */
  const SCREENS = {
    home: "screen-home",
    battle: "screen-battle",
    store: "screen-store",
    bag: "screen-bag",
    settings: "screen-settings",
    heroes: "screen-store",
  };
  function goto(name) {
    const target = SCREENS[name] ? name : "home";
    if (target === "heroes") {
      switchTab("heroes");
      state.screen = "store";
    } else {
      state.screen = target;
    }
    const id = SCREENS[target];
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("is-active", s.id === id));
    document.querySelectorAll("#tabbar button").forEach((b) => {
      const key = b.dataset.goto === "settings" ? "settings" : b.dataset.goto;
      b.classList.toggle("is-on", key === state.screen);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (state.screen === "battle") {
      tg?.BackButton?.show?.();
    } else {
      tg?.BackButton?.hide?.();
    }
    SFX.tap();
  }
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll("#store-tabs .tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === tab));
    ["heroes", "items", "relics"].forEach((key) => {
      $(`tab-${key}`).hidden = key !== tab;
    });
  }

  /* ------------------------------------------------------------------ *
   * battle stage animation
   * ------------------------------------------------------------------ */
  const ELEMENT_GLYPH = {
    fire: "🔥",
    ice: "❄",
    wind: "🌪",
    arcane: "✦",
    shadow: "🌑",
  };

  function burst(layerId, color, glyph, big = false) {
    const layer = $(layerId);
    if (!layer) return;
    const node = el("span", `burst${big ? " burst-big" : ""}`, glyph || "✦");
    node.style.setProperty("--fx", color || "#ffd479");
    node.style.left = `${20 + Math.random() * 60}%`;
    node.style.top = `${25 + Math.random() * 40}%`;
    layer.appendChild(node);
    setTimeout(() => node.remove(), 760);
  }
  function ring(layerId, color) {
    const layer = $(layerId);
    if (!layer) return;
    const node = el("span", "ring");
    node.style.setProperty("--fx", color || "#ffd479");
    layer.appendChild(node);
    setTimeout(() => node.remove(), 620);
  }
  function slash(layerId, color) {
    const layer = $(layerId);
    if (!layer) return;
    for (let i = 0; i < 3; i += 1) {
      const node = el("span", "slash");
      node.style.setProperty("--fx", color || "#fff");
      node.style.animationDelay = `${i * 60}ms`;
      node.style.top = `${28 + i * 16}%`;
      layer.appendChild(node);
      setTimeout(() => node.remove(), 520 + i * 60);
    }
  }
  function floatText(layerId, text, kind = "dmg") {
    const layer = $(layerId);
    if (!layer) return;
    const node = el("span", `float float-${kind}`, text);
    node.style.left = `${30 + Math.random() * 30}%`;
    layer.appendChild(node);
    setTimeout(() => node.remove(), 1100);
  }
  function pulse(node, cls, ms = 520) {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), ms);
  }
  function shake(strength = "soft") {
    if (!state.settings.shake) return;
    pulse($("arena"), strength === "hard" ? "quake-hard" : "quake", 460);
  }

  async function playCombat(action, effects) {
    const hero = $("hero-fighter");
    const foe = $("foe-fighter");
    const color = effects.element ? (ELEMENTS_COLOR[effects.element] || "#ffd479") : "#ffd479";
    const glyph = ELEMENT_GLYPH[effects.element] || "✦";

    if (effects.blocked_action) {
      pulse(hero, "is-refused", 500);
      floatText("hero-float-layer", "NO ENERGY", "warn");
      return;
    }

    if (action === "strike" || action === "heavy" || action === "special") {
      if (action === "special") {
        pulse(hero, "is-casting", 700);
        ring("hero-fx", color);
        SFX.special();
        await sleep(420);
      } else {
        SFX[action === "heavy" ? "heavy" : "strike"]();
      }
      pulse(hero, action === "heavy" ? "is-lunging-hard" : "is-lunging", 620);
      await sleep(action === "heavy" ? 220 : 170);
      if (effects.damage) {
        pulse(foe, "is-hit", 520);
        slash("foe-fx", color);
        burst("foe-fx", color, glyph, action !== "strike");
        floatText("enemy-float-layer", `-${effects.damage}${effects.crit ? " CRIT!" : ""}`, effects.crit ? "crit" : "dmg");
        shake(action === "heavy" || effects.crit ? "hard" : "soft");
        haptic(action === "heavy" ? "medium" : "light");
      }
      if (effects.second_hit) {
        await sleep(230);
        pulse(hero, "is-lunging", 500);
        pulse(foe, "is-hit", 420);
        burst("foe-fx", color, glyph);
        floatText("enemy-float-layer", `-${effects.second_hit}`, "dmg");
        SFX.strike();
      }
      if (effects.burn_applied) {
        burst("foe-fx", "#ff8a3c", "🔥", true);
        floatText("enemy-float-layer", "BURN", "status");
      }
      if (effects.stun) {
        burst("foe-fx", "#7fd8ff", "❄", true);
        floatText("enemy-float-layer", "FROZEN", "status");
      }
      if (effects.pierce) floatText("enemy-float-layer", "PIERCE", "status");
      if (effects.healed) {
        burst("hero-fx", "#8ef0a8", "✚");
        floatText("hero-float-layer", `+${effects.healed}`, "heal");
        SFX.heal();
      }
    } else if (action === "guard") {
      pulse(hero, "is-guarding", 900);
      ring("hero-fx", "#7fd8ff");
      tone({ freq: 300, type: "sine", dur: 0.25, gain: 0.1, slide: 120 });
    } else if (action === "scout") {
      pulse(foe, "is-scanned", 900);
      ring("foe-fx", "#b48bff");
      tone({ freq: 880, type: "sine", dur: 0.2, gain: 0.08, slide: 300 });
    } else if (action === "rest") {
      pulse(hero, "is-resting", 900);
      burst("hero-fx", "#8ef0a8", "✚", true);
      if (effects.healed) floatText("hero-float-layer", `+${effects.healed}`, "heal");
      SFX.heal();
    }

    if (effects.burn_damage) {
      await sleep(180);
      burst("foe-fx", "#ff8a3c", "🔥");
      floatText("enemy-float-layer", `-${effects.burn_damage}`, "dmg");
    }
    if (effects.regen_healed) {
      floatText("hero-float-layer", `+${effects.regen_healed}`, "heal");
    }

    if (effects.victory) {
      pulse(foe, "is-defeated", 1200);
      SFX.victory();
      haptic("success");
      banner("VICTORY", effects.leveled_up ? "You rise a level!" : "Chapter cleared");
      return;
    }

    if (effects.enemy_damage) {
      await sleep(360);
      pulse(foe, "is-lunging", 560);
      await sleep(170);
      pulse(hero, "is-hit", 520);
      slash("hero-fx", "#ff5f6d");
      floatText("hero-float-layer", `-${effects.enemy_damage}`, "dmg");
      SFX.hurt();
      shake("soft");
      haptic("medium");
    } else if (effects.stunned) {
      floatText("enemy-float-layer", "STUNNED", "status");
    } else if (effects.blocked) {
      floatText("hero-float-layer", `BLOCKED ${effects.blocked}`, "status");
    }
    if (effects.enemy_healed) {
      burst("foe-fx", "#8ef0a8", "✚");
      floatText("enemy-float-layer", `+${effects.enemy_healed}`, "heal");
    }
    if (effects.revived) {
      SFX.defeat();
      banner("DOWNED", "A phoenix ember pulls you back");
    }
  }

  const ELEMENTS_COLOR = {
    fire: "#ff8a3c",
    ice: "#7fd8ff",
    wind: "#8ef0a8",
    arcane: "#b48bff",
    shadow: "#ff6ac1",
  };

  let bannerTimer = null;
  function banner(title, sub) {
    const node = $("arena-banner");
    $("banner-title").textContent = title;
    $("banner-sub").textContent = sub || "";
    node.hidden = false;
    node.classList.remove("is-in");
    void node.offsetWidth;
    node.classList.add("is-in");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      node.classList.remove("is-in");
      setTimeout(() => (node.hidden = true), 400);
    }, 1900);
  }

  /* ------------------------------------------------------------------ *
   * rendering
   * ------------------------------------------------------------------ */
  function setBar(id, ratio) {
    const node = $(id);
    if (node) node.style.width = `${clamp(ratio * 100, 0, 100).toFixed(1)}%`;
  }

  function render(view) {
    state.player = view;
    const { hero, quest, enemy, battle, character, roster } = view;

    document.documentElement.style.setProperty("--element", character.element_color);

    // ---- home ----
    $("home-char-art").src = ART(character.art, "png");
    $("home-char-name").textContent = character.name;
    $("home-char-title").textContent = character.title;
    $("home-element").textContent = character.element_name.toUpperCase();
    $("home-element").style.setProperty("--element", character.element_color);
    $("showcase-glow").style.setProperty("--element", character.element_color);
    $("home-level").textContent = hero.level;
    $("home-hp").textContent = `${hero.hp}`;
    $("home-energy").textContent = `${hero.energy}`;
    $("home-power").textContent = `+${hero.power}`;
    $("wallet-coins").textContent = hero.coins;
    $("wallet-points").textContent = hero.points;
    $("wallet-gold").textContent = hero.gold;
    $("store-coins").textContent = hero.coins;
    $("quest-title").textContent = quest.title;
    $("quest-objective").textContent = quest.objective;
    setBar("xp-bar", hero.progress);
    $("xp-caption").textContent = `${hero.xp} XP · ${hero.xp_to_next} to level ${hero.level + 1}`;
    $("quest-foe-art").src = ART(enemy.sprite, "png");
    $("quest-foe-name").textContent = enemy.name;
    $("quest-foe-lv").textContent = `LV ${enemy.level}${enemy.boss ? " · BOSS" : ""}`;
    $("play-sub").textContent = `Chapter ${quest.chapter} · ${enemy.name} awaits`;
    $("bag-count").textContent = view.inventory.reduce((sum, c) => sum + c.quantity, 0);
    $("hero-count").textContent = roster.filter((c) => c.owned).length;
    $("satchel-value").textContent = view.inventory_value;

    // ---- battle ----
    $("chapter-chip").textContent = `CH ${quest.chapter}`;
    $("hero-sprite").src = ART(character.art, "png");
    $("hero-sprite").alt = character.name;
    $("foe-sprite").src = ART(enemy.sprite, "png");
    $("foe-sprite").alt = enemy.name;
    $("foe-name").textContent = enemy.name;
    $("foe-level").textContent = `LV ${enemy.level}`;
    $("boss-tag").hidden = !enemy.boss;
    $("foe-ability").textContent = enemy.ability ? `${enemy.ability}` : "";
    document.documentElement.style.setProperty("--foe-element", enemy.element_color);
    setBar("enemy-hp-bar", enemy.hp / Math.max(1, enemy.max_hp));
    $("enemy-hp-text").textContent = `${enemy.hp} / ${enemy.max_hp} HP`;
    setBar("hero-hp-bar", hero.hp / Math.max(1, hero.max_hp));
    $("hero-hp-text").textContent = `${hero.hp} / ${hero.max_hp}`;
    setBar("hero-energy-bar", hero.energy / Math.max(1, hero.max_energy));
    $("hero-energy-text").textContent = `${hero.energy} / ${hero.max_energy}`;

    const pips = $("focus-pips");
    pips.replaceChildren();
    for (let i = 0; i < hero.max_focus; i += 1) {
      pips.appendChild(el("i", i < hero.focus ? "pip is-on" : "pip"));
    }

    const chips = $("status-chips");
    chips.replaceChildren();
    const addChip = (text, cls) => chips.appendChild(el("span", `chip ${cls}`, text));
    if (battle.exposed) addChip("EXPOSED +2", "chip-good");
    if (battle.burn) addChip(`BURN ${battle.burn}`, "chip-fire");
    if (battle.regen) addChip(`REGEN ${battle.regen}`, "chip-good");
    if (battle.stun) addChip(`FROZEN ${battle.stun}`, "chip-ice");
    if (battle.can_finish) addChip("FINISH IT", "chip-finish");
    if (!chips.childElementCount) addChip(`TURN ${battle.turn}`, "chip-muted");

    const intent = enemy.intent || {};
    $("intent-name").textContent = intent.name || "Unknown";
    $("intent-advice").textContent = intent.advice || "";
    $("intent-num").textContent = intent.damage ? `${intent.damage}` : "—";
    $("intent-ic").textContent = intent.emoji || "⚔";

    $("coach-text").textContent = coachLine(view);
    renderAttacks(view);
    renderHealRail(view);
    renderHeroStore(view);
    renderShop(view);
    renderForge(view);
    renderSatchel(view);
    $("version-note").textContent = `ChronicleRift ${state.version ? `v${state.version}` : ""}`;

    state.lastHeroHp = hero.hp;
    state.lastEnemyHp = enemy.hp;
  }

  function coachLine(view) {
    const { hero, enemy, battle, character } = view;
    if (battle.can_finish) return "One hit ends it — attack now.";
    if (hero.hp <= hero.max_hp * 0.3) return "You're hurt. Use a potion or Guard to blunt the next hit.";
    if (hero.energy === 0) return "Out of Energy — Guard or Rest to recover.";
    if (hero.energy >= 3) return `Enough Energy for ${character.attacks[2].name} — your ${character.element_name} special.`;
    if (!battle.exposed) return "Scout to expose the enemy for +2 damage on your next hit.";
    return `${enemy.name} uses ${enemy.ability}. Watch its telegraphed move above.`;
  }

  function renderAttacks(view) {
    const wrap = $("attack-controls");
    wrap.replaceChildren();
    view.character.attacks.forEach((attack) => {
      const btn = el("button", `attack atk-${attack.id}`);
      btn.type = "button";
      btn.dataset.action = attack.id;
      btn.style.setProperty("--element", view.character.element_color);
      const affordable = view.hero.energy >= attack.cost;
      btn.disabled = state.busy || !affordable;
      btn.classList.toggle("is-poor", !affordable);
      const top = el("div", "attack-top");
      top.appendChild(el("b", null, attack.name));
      const cost = el("span", "cost");
      for (let i = 0; i < attack.cost; i += 1) cost.appendChild(el("i", "en"));
      top.appendChild(cost);
      btn.appendChild(top);
      btn.appendChild(el("small", "attack-dmg", `${attack.min}–${attack.max} DMG`));
      btn.appendChild(el("small", "attack-desc", attack.desc));
      btn.addEventListener("click", () => takeTurn(attack.id));
      wrap.appendChild(btn);
    });
  }

  function healingItems(view) {
    return view.inventory.filter(
      (card) => card.kind === "consumable" && (HEAL_KEYWORDS.includes(card.id) || /heal|hp|vital/i.test(card.ability)),
    );
  }

  function renderHealRail(view) {
    const strip = $("rail-strip");
    strip.replaceChildren();
    const heals = healingItems(view);
    if (!heals.length) {
      const empty = el("button", "rail-empty");
      empty.type = "button";
      empty.innerHTML = "<b>No potions left</b><small>Tap to buy instantly</small>";
      empty.addEventListener("click", () => openRestock());
      strip.appendChild(empty);
      return;
    }
    heals.forEach((card) => {
      const btn = el("button", "rail-item");
      btn.type = "button";
      btn.disabled = state.busy;
      const img = el("img");
      img.src = ART(card.art || "item-heal");
      img.alt = "";
      btn.appendChild(img);
      btn.appendChild(el("b", null, card.ability));
      btn.appendChild(el("span", "qty", `×${card.quantity}`));
      btn.addEventListener("click", () => useItem(card));
      strip.appendChild(btn);
    });
  }

  function renderHeroStore(view) {
    const grid = $("hero-store");
    grid.replaceChildren();
    view.roster.forEach((card) => {
      const node = el("article", `hero-card${card.active ? " is-active" : ""}`);
      node.style.setProperty("--element", card.element_color);
      const media = el("div", "hero-card-art");
      const img = el("img");
      img.src = ART(card.art, "png");
      img.alt = card.name;
      media.appendChild(img);
      if (card.active) media.appendChild(el("span", "badge badge-active", "ACTIVE"));
      else if (card.owned) media.appendChild(el("span", "badge", "OWNED"));
      node.appendChild(media);

      const body = el("div", "hero-card-body");
      body.appendChild(el("span", "element-tag", card.element_name.toUpperCase()));
      body.appendChild(el("h4", null, card.name));
      body.appendChild(el("small", "muted", card.title));
      body.appendChild(el("p", null, card.blurb));
      const stats = el("div", "hero-card-stats");
      stats.appendChild(el("span", null, `${card.hp} HP`));
      stats.appendChild(el("span", null, `${card.energy} EN`));
      stats.appendChild(el("span", null, `+${card.power} PWR`));
      body.appendChild(stats);
      const moves = el("ul", "hero-moves");
      card.attacks.forEach((a) => {
        const li = el("li");
        li.appendChild(el("b", null, a.name));
        li.appendChild(el("span", null, `${a.min}–${a.max} · ${a.cost} EN`));
        moves.appendChild(li);
      });
      body.appendChild(moves);

      const btn = el("button", "btn-primary wide");
      btn.type = "button";
      btn.disabled = state.busy || card.active;
      if (card.active) btn.textContent = "In play";
      else if (card.owned) btn.textContent = "Select hero";
      else btn.textContent = `Recruit · ${card.cost} 🪙`;
      btn.addEventListener("click", () => (card.owned ? selectCharacter(card) : buyCharacter(card)));
      body.appendChild(btn);
      node.appendChild(body);
      grid.appendChild(node);
    });
  }

  function itemNode(card, { actionLabel, onAction, disabled, caption }) {
    const node = el("article", `item-card rarity-${card.rarity}`);
    const img = el("img");
    img.src = ART(card.art || "item-heal");
    img.alt = "";
    img.onerror = () => {
      img.replaceWith(el("div", "item-emoji", card.emoji));
    };
    node.appendChild(img);
    const body = el("div", "item-body");
    body.appendChild(el("b", null, card.name));
    body.appendChild(el("span", "ability", card.ability));
    body.appendChild(el("small", "muted", caption || card.desc));
    node.appendChild(body);
    const btn = el("button", "btn-ghost");
    btn.type = "button";
    btn.textContent = actionLabel;
    btn.disabled = !!disabled || state.busy;
    btn.addEventListener("click", onAction);
    node.appendChild(btn);
    return node;
  }

  function renderShop(view) {
    const grid = $("shop-list");
    grid.replaceChildren();
    view.shop
      .filter((card) => card.kind === "consumable")
      .forEach((card) => {
        grid.appendChild(
          itemNode(card, {
            actionLabel: `${card.cost} 🪙`,
            disabled: view.hero.coins < card.cost,
            onAction: () => buyItem(card),
          }),
        );
      });
  }

  function renderForge(view) {
    const grid = $("forge-list");
    grid.replaceChildren();
    view.relics.forEach((card) => {
      const capped = card.level >= card.max_level;
      grid.appendChild(
        itemNode(card, {
          actionLabel: capped ? "MAX" : `${card.next_cost} 🪙`,
          disabled: capped || view.hero.coins < (card.next_cost || 0),
          caption: `Lv ${card.level}/${card.max_level} · ${card.bonus_now || "not forged"}${card.bonus_next ? ` → ${card.bonus_next}` : ""}`,
          onAction: () => upgradeRelic(card),
        }),
      );
    });
  }

  function renderSatchel(view) {
    const grid = $("satchel-list");
    grid.replaceChildren();
    if (!view.inventory.length) {
      grid.appendChild(el("p", "note", "Your satchel is empty. Clear a chapter to earn loot."));
      return;
    }
    view.inventory.forEach((card) => {
      const usable = card.kind === "consumable";
      const node = itemNode(card, {
        actionLabel: `Sell ${card.sell} 🪙`,
        onAction: () => sellItem(card),
        caption: `${card.desc} · carrying ${card.quantity}`,
      });
      if (usable) {
        const use = el("button", "btn-primary small");
        use.type = "button";
        use.textContent = "Use";
        use.disabled = state.busy;
        use.addEventListener("click", () => useItem(card));
        node.insertBefore(use, node.lastChild);
      }
      grid.appendChild(node);
    });
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  function setBusy(flag) {
    state.busy = flag;
    document.body.classList.toggle("is-busy", flag);
    document.querySelectorAll(".attack, .support, .rail-item, .btn-primary, .btn-ghost").forEach((b) => {
      if (flag) b.setAttribute("data-was-disabled", b.disabled ? "1" : "0");
      b.disabled = flag ? true : b.getAttribute("data-was-disabled") === "1";
    });
  }

  function logLine(text, kind = "") {
    const list = $("battle-log");
    const li = el("li", kind, text);
    list.prepend(li);
    while (list.children.length > 14) list.lastChild.remove();
  }

  async function takeTurn(action) {
    if (state.busy || !state.player) return;
    setBusy(true);
    try {
      const data = await api("/api/actions", { action });
      const effects = data.turn.effects || {};
      const hadHeals = healingItems(state.player).length;
      render(data.player);
      logLine(data.turn.summary, effects.victory ? "is-win" : "");
      await playCombat(action, effects);
      if (effects.loot?.length) showLoot(effects.loot, data.turn.summary);
      if (data.turn.narrative) logLine(data.turn.narrative, "is-narrative");
      maybeRestock(hadHeals);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
      if (state.player) render(state.player);
    }
  }

  async function itemCall(path, body, okKind = "success") {
    if (state.busy) return null;
    setBusy(true);
    try {
      const data = await api(path, body);
      const hadHeals = state.player ? healingItems(state.player).length : 0;
      render(data.player);
      if (data.turn.success) {
        toast(data.turn.summary, okKind);
        logLine(data.turn.summary);
        haptic("success");
      } else {
        toast(data.turn.reason || data.turn.summary, "error");
        haptic("error");
      }
      maybeRestock(hadHeals);
      return data;
    } catch (err) {
      toast(err.message, "error");
      return null;
    } finally {
      setBusy(false);
      if (state.player) render(state.player);
    }
  }

  async function useItem(card) {
    const before = state.player?.hero.hp ?? 0;
    const data = await itemCall("/api/use", { item_id: card.id });
    if (!data) return;
    const healed = (data.player.hero.hp || 0) - before;
    if (healed > 0) {
      burst("hero-fx", "#8ef0a8", "✚", true);
      floatText("hero-float-layer", `+${healed}`, "heal");
      pulse($("hero-fighter"), "is-resting", 700);
      SFX.heal();
    }
  }
  const buyItem = (card) => itemCall("/api/buy", { item_id: card.id }).then((d) => d && SFX.coin());
  const sellItem = (card) => itemCall("/api/sell", { item_id: card.id, quantity: 1 }).then((d) => d && SFX.coin());
  const upgradeRelic = (card) => itemCall("/api/upgrade", { item_id: card.id }).then((d) => d && SFX.coin());
  const buyCharacter = (card) =>
    itemCall("/api/character/buy", { item_id: card.id }).then((d) => {
      if (d?.turn.success) {
        SFX.victory();
        toast(`${card.name} joins your chronicle!`, "success");
      }
    });
  const selectCharacter = (card) =>
    itemCall("/api/character/select", { item_id: card.id }).then((d) => {
      if (d?.turn.success) {
        pulse($("home-char-art"), "is-swap", 700);
        SFX.special();
      }
    });

  /* instant restock prompt: fires the moment the last potion leaves the bag */
  function maybeRestock(hadHealsBefore) {
    if (!state.player) return;
    const now = healingItems(state.player).length;
    if (hadHealsBefore > 0 && now === 0 && state.screen === "battle") {
      openRestock();
    }
  }

  function openRestock() {
    if (!state.player) return;
    const list = $("restock-list");
    list.replaceChildren();
    const heals = state.player.shop.filter(
      (card) => card.kind === "consumable" && /heal|hp|vital|revive/i.test(`${card.ability} ${card.desc}`),
    );
    (heals.length ? heals : state.player.shop.filter((c) => c.kind === "consumable")).forEach((card) => {
      list.appendChild(
        itemNode(card, {
          actionLabel: `Buy ${card.cost} 🪙`,
          disabled: state.player.hero.coins < card.cost,
          onAction: async () => {
            await buyItem(card);
            closeModal($("restock-modal"));
          },
        }),
      );
    });
    $("restock-sub").textContent = `You have ${state.player.hero.coins} coins. Restock without leaving the fight:`;
    openModal($("restock-modal"));
    haptic("warning");
  }

  function showLoot(loot, sub) {
    const grid = $("loot-grid");
    grid.replaceChildren();
    loot.forEach((card) => {
      const node = el("div", `loot-item rarity-${card.rarity}`);
      const img = el("img");
      img.src = ART(card.art || "treasure-shard");
      img.alt = "";
      img.onerror = () => img.replaceWith(el("div", "item-emoji", card.emoji));
      node.appendChild(img);
      node.appendChild(el("b", null, card.name));
      node.appendChild(el("small", null, card.ability || card.desc));
      grid.appendChild(node);
    });
    $("loot-sub").textContent = sub || "";
    openModal($("loot-modal"));
    SFX.coin();
  }

  /* ------------------------------------------------------------------ *
   * modals
   * ------------------------------------------------------------------ */
  function openModal(node) {
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add("is-open"));
  }
  function closeModal(node) {
    node.classList.remove("is-open");
    setTimeout(() => (node.hidden = true), 240);
  }
  document.addEventListener("click", (event) => {
    const closer = event.target.closest("[data-close]");
    if (closer) {
      const modal = closer.closest(".modal");
      if (modal) closeModal(modal);
    }
    const nav = event.target.closest("[data-goto]");
    if (nav) goto(nav.dataset.goto);
    const tab = event.target.closest("#store-tabs .tab");
    if (tab) {
      switchTab(tab.dataset.tab);
      SFX.tap();
    }
  });

  /* ------------------------------------------------------------------ *
   * onboarding
   * ------------------------------------------------------------------ */
  const SLIDES = [
    {
      kicker: "WELCOME",
      title: "Fight through the Rift",
      img: "intro-arena",
      body: "Each chapter throws one monster at you. Beat it to earn XP, coins and a loot chest. Bosses appear every fifth chapter.",
    },
    {
      kicker: "THREE ATTACKS",
      title: "Strike, Heavy, Special",
      img: "intro-moves",
      body: "Every hero has three attacks costing 1, 2 and 3 Energy. The Special carries your element: burn, freeze, double-hit, pierce or lifesteal.",
    },
    {
      kicker: "READ THE ENEMY",
      title: "Their next move is shown",
      img: "camp",
      body: "The intent card tells you what the monster does next. Guard to blunt it, Scout to expose it for +2 damage, Rest to heal and refuel.",
    },
    {
      kicker: "HOME BASE",
      title: "Heroes, store and satchel",
      img: "intro-market",
      body: "Recruit elemental heroes, buy potions and forge relics from the Home screen. In battle you only carry healing — and you can restock instantly if you run dry.",
    },
  ];
  let slideIndex = 0;
  const TUTORIAL_KEY = "cr_tutorial_v6";
  function renderSlide() {
    const slide = SLIDES[slideIndex];
    $("onboard-kicker").textContent = slide.kicker;
    $("onboard-title").textContent = slide.title;
    $("onboard-img").src = ART(slide.img);
    $("onboard-content").replaceChildren(el("p", null, slide.body));
    const dots = $("onboard-dots");
    dots.replaceChildren();
    SLIDES.forEach((_, i) => dots.appendChild(el("i", i === slideIndex ? "dot is-on" : "dot")));
    $("onboard-next").textContent = slideIndex === SLIDES.length - 1 ? "Start playing" : "Next";
  }
  function openTutorial() {
    slideIndex = 0;
    renderSlide();
    openModal($("onboard"));
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */
  async function refresh() {
    try {
      const data = await api("/api/me");
      state.version = data.version || "";
      render(data.player);
      const pill = $("connection-status");
      pill.innerHTML = "<i class='dot'></i>Live";
      pill.classList.add("is-live");
    } catch (err) {
      const pill = $("connection-status");
      pill.innerHTML = "<i class='dot'></i>Offline";
      pill.classList.add("is-off");
      toast(err.message, "error");
    }
  }

  function bindSettings() {
    const map = { "set-sound": "sound", "set-haptics": "haptics", "set-shake": "shake" };
    Object.entries(map).forEach(([id, key]) => {
      const box = $(id);
      box.checked = state.settings[key];
      box.addEventListener("change", () => {
        state.settings[key] = box.checked;
        saveSettings();
        syncSoundIcon();
        if (key === "sound" && box.checked) SFX.tap();
      });
    });
    $("set-tutorial").addEventListener("click", openTutorial);
  }
  function syncSoundIcon() {
    $("sound-on-ic").hidden = !state.settings.sound;
    $("sound-off-ic").hidden = state.settings.sound;
    $("sound-btn").setAttribute("aria-pressed", String(state.settings.sound));
    $("set-sound").checked = state.settings.sound;
  }

  function init() {
    loadSettings();
    try {
      tg?.ready();
      tg?.expand?.();
      tg?.setHeaderColor?.("#05060f");
      tg?.setBackgroundColor?.("#05060f");
      tg?.enableClosingConfirmation?.();
      tg?.BackButton?.onClick?.(() => goto("home"));
    } catch (_) {
      /* running outside Telegram */
    }

    bindSettings();
    syncSoundIcon();

    $("play-btn").addEventListener("click", () => goto("battle"));
    $("battle-back").addEventListener("click", () => goto("home"));
    $("help-btn").addEventListener("click", openTutorial);
    $("sound-btn").addEventListener("click", () => {
      state.settings.sound = !state.settings.sound;
      saveSettings();
      syncSoundIcon();
      if (state.settings.sound) SFX.tap();
    });
    $("loot-close").addEventListener("click", () => closeModal($("loot-modal")));
    $("onboard-next").addEventListener("click", () => {
      if (slideIndex >= SLIDES.length - 1) {
        closeModal($("onboard"));
        try {
          localStorage.setItem(TUTORIAL_KEY, "1");
        } catch (_) {
          /* ignore */
        }
        return;
      }
      slideIndex += 1;
      renderSlide();
      SFX.tap();
    });
    document.querySelectorAll(".support").forEach((btn) => {
      btn.addEventListener("click", () => takeTurn(btn.dataset.action));
    });

    refresh().then(() => {
      let seen = "1";
      try {
        seen = localStorage.getItem(TUTORIAL_KEY);
      } catch (_) {
        seen = "1";
      }
      if (!seen) openTutorial();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
