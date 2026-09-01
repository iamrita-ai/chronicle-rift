/* ChronicleRift Mini App — v0.7.0
 * Home hub + a real-time 2.5D arena fight (see arena.js for the engine).
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
  const ART = (name, ext = "jpg") => `./art/${name}.${ext}`;
  const HP_SCALE = 4; // real-time duels need more hit points than a turn fight

  const state = {
    player: null,
    version: "",
    busy: false,
    screen: "home",
    tab: "heroes",
    settings: { sound: true, haptics: true, shake: true },
  };

  /* ------------------------------------------------------------------ *
   * settings
   * ------------------------------------------------------------------ */
  const SETTINGS_KEY = "cr_settings_v1";
  function loadSettings() {
    try {
      Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
    } catch (_) { /* ignore */ }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (_) { /* ignore */ }
  }
  function haptic(kind = "light") {
    if (!state.settings.haptics) return;
    try {
      if (["success", "error", "warning"].includes(kind)) tg?.HapticFeedback?.notificationOccurred(kind);
      else tg?.HapticFeedback?.impactOccurred(kind);
    } catch (_) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * ui sound (menus only; the arena has its own kit)
   * ------------------------------------------------------------------ */
  let actx = null;
  function tone(freq, type, dur, gain, slide = 0, delay = 0) {
    if (!state.settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const t0 = actx.currentTime + delay;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.03);
    } catch (_) { /* ignore */ }
  }
  const UI = {
    tap: () => tone(520, "triangle", 0.06, 0.07),
    coin: () => { tone(1180, "square", 0.06, 0.07); tone(1560, "square", 0.09, 0.06, 0, 0.05); },
    heal: () => { tone(660, "sine", 0.18, 0.09); tone(990, "sine", 0.2, 0.07, 0, 0.08); },
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, "triangle", 0.22, 0.1, 0, i * 0.1)),
  };

  /* ------------------------------------------------------------------ *
   * networking
   * ------------------------------------------------------------------ */
  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    const initData = tg?.initData || "";
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
      try { const data = await res.json(); if (data?.detail) detail = data.detail; } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  }

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
  const SCREENS = { home: "screen-home", battle: "screen-battle", store: "screen-store", bag: "screen-bag", settings: "screen-settings" };
  function goto(name) {
    const target = name === "heroes" ? "store" : SCREENS[name] ? name : "home";
    if (name === "heroes") switchTab("heroes");
    if (state.screen === "battle" && target !== "battle") Fight.leave();
    state.screen = target;
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("is-active", s.id === SCREENS[target]));
    document.body.classList.toggle("in-fight", target === "battle");
    document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("is-on", b.dataset.goto === state.screen));
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (target === "battle") {
      tg?.BackButton?.show?.();
      Fight.open();
    } else {
      tg?.BackButton?.hide?.();
    }
    UI.tap();
  }
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll("#store-tabs .tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === tab));
    ["heroes", "items", "relics"].forEach((key) => { $(`tab-${key}`).hidden = key !== tab; });
  }

  /* ================================================================== *
   * FIGHT — wires the arena engine to the server state and the controls
   * ================================================================== */
  const Fight = {
    arena: null,
    started: false,
    settling: false,

    fit() {
      const section = $("screen-battle");
      const portrait = window.innerHeight > window.innerWidth;
      section.classList.toggle("force-landscape", portrait);
      $("rotate-hint").hidden = !portrait;
      if (this.arena) this.arena.resize(section.offsetWidth, section.offsetHeight);
    },

    ensure() {
      if (this.arena) return this.arena;
      this.arena = new window.ChronicleArena.Arena({
        canvas: $("arena-canvas"),
        onEnd: (outcome, hpLeft) => this.finish(outcome, hpLeft),
        onHud: (a) => this.hud(a),
      });
      this.bindControls();
      window.addEventListener("resize", () => { if (state.screen === "battle") this.fit(); });
      window.addEventListener("orientationchange", () => setTimeout(() => this.fit(), 220));
      return this.arena;
    },

    playerStats(view) {
      const hero = view.hero;
      const kit = window.ChronicleArena.kitFor(view.character.element);
      const speedByElement = { wind: 268, shadow: 240, fire: 232, arcane: 224, ice: 206 };
      return {
        name: view.character.name,
        element: view.character.element,
        color: view.character.element_color,
        art: ART(view.character.art, "png"),
        artFacing: 1,
        scale: 1,
        build: "hero",
        stats: {
          hp: Math.max(30, Math.round(hero.hp * HP_SCALE)),
          damage: 7 + hero.power * 2.2 + hero.level * 1.4 + hero.attack_bonus * 1.6,
          speed: speedByElement[view.character.element] || 230,
          atkSpeed: view.character.element === "wind" ? 1.35 : view.character.element === "ice" ? 0.85 : 1,
          range: kit.basic.range,
          crit: clamp(0.1 + (hero.luck + hero.luck_bonus) * 0.012, 0.05, 0.45),
          defense: 16 + hero.ward_bonus * 4 + hero.level,
        },
      };
    },

    enemyStats(view) {
      const enemy = view.enemy;
      return {
        name: enemy.name,
        element: enemy.element,
        color: enemy.element_color,
        art: ART(enemy.sprite, "png"),
        artFacing: -1,
        // evil is always bigger than the hero, and bosses tower
        scale: enemy.boss ? 1.55 : 1.22,
        build: enemy.boss ? "brute" : "beast",
        stats: {
          hp: Math.round(enemy.max_hp * HP_SCALE),
          damage: 5 + enemy.attack * 1.15,
          speed: (enemy.boss ? 172 : 198) + enemy.level * 3,
          atkSpeed: enemy.boss ? 0.8 : 0.95,
          range: enemy.boss ? 122 : 98,
          crit: 0.08 + enemy.level * 0.005,
          defense: 12 + enemy.level * 2 + (enemy.boss ? 10 : 0),
        },
      };
    },

    open() {
      const view = state.player;
      if (!view) return;
      this.ensure();
      this.fit();
      this.started = false;
      const p = this.playerStats(view);
      const e = this.enemyStats(view);
      $("mu-hero-art").src = ART(view.character.art, "png");
      $("mu-hero-name").textContent = p.name;
      $("mu-hero-stats").textContent = `${p.stats.hp} HP · ${Math.round(p.stats.damage)} DMG · ${view.character.element_name}`;
      $("mu-foe-art").src = ART(view.enemy.sprite, "png");
      $("mu-foe-name").textContent = e.name;
      $("mu-foe-stats").textContent = `${e.stats.hp} HP · ${Math.round(e.stats.damage)} DMG · ${view.enemy.ability || "—"}`;
      $("hud-chapter").textContent = `CH ${view.quest.chapter}`;
      $("fight-start-sub").textContent = `${view.quest.title} · ${view.enemy.boss ? "BOSS FIGHT" : "Chapter duel"}`;
      $("fight-start-label").textContent = "FIGHT";
      document.documentElement.style.setProperty("--element", view.character.element_color);
      document.documentElement.style.setProperty("--foe-element", view.enemy.element_color);
      const scenes = { fire: "bg-ember", ice: "bg-frost", shadow: "bg-void", arcane: "bg-arcane", wind: "bg-arcane" };
      this.arena.setScene(view.enemy.boss ? "bg-void" : scenes[view.enemy.element] || "bg-ember");
      this.renderAbilityButtons(view);
      renderHealRail(view);
      $("fight-overlay").classList.add("is-open");
      this.arena.setFighters(p, e);
      this.arena.stop();
      this.arena.draw();
    },

    begin() {
      const view = state.player;
      if (!view || this.started) return;
      this.ensure();
      this.fit();
      window.ChronicleArena.unlockAudio();
      this.arena.setFighters(this.playerStats(view), this.enemyStats(view));
      this.arena.ended = false;
      this.started = true;
      this.settling = false;
      $("fight-overlay").classList.remove("is-open");
      window.ChronicleArena.setMuted(!state.settings.sound);
      this.arena.start();
      haptic("medium");
    },

    leave() {
      if (this.arena) this.arena.stop();
      this.started = false;
      $("fight-overlay").classList.add("is-open");
    },

    renderAbilityButtons(view) {
      const kit = window.ChronicleArena.kitFor(view.character.element);
      kit.abilities.forEach((ability, i) => {
        const img = $(`ab-${i}-img`);
        img.src = ART(ability.icon, "png");
        img.onerror = () => { img.style.visibility = "hidden"; };
        $(`ab-${i}-label`).textContent = ability.name;
        $(`ab-${i}`).style.setProperty("--element", view.character.element_color);
        $(`ab-${i}`).title = `${ability.name} — ${ability.desc}`;
      });
      $("btn-attack").style.setProperty("--element", view.character.element_color);
    },

    hud(a) {
      const p = a.player;
      const e = a.enemy;
      const set = (id, ratio) => { const n = $(id); if (n) n.style.width = `${clamp(ratio * 100, 0, 100)}%`; };
      set("hud-p-fill", p.hp / p.maxHp);
      set("hud-e-fill", e.hp / e.maxHp);
      set("hud-p-stam", p.stamina / p.maxStamina);
      set("hud-e-stam", e.stamina / e.maxStamina);
      $("hud-p-name").textContent = p.name;
      $("hud-e-name").textContent = e.name;
      $("hud-p-hp").textContent = `${Math.ceil(p.hp)}`;
      $("hud-e-hp").textContent = `${Math.ceil(e.hp)}`;
      // ghost bars trail the real damage for a punchy readout
      ["p", "e"].forEach((k) => {
        const fighter = k === "p" ? p : e;
        const ghost = $(`hud-${k}-ghost`);
        const target = (fighter.hp / fighter.maxHp) * 100;
        const cur = parseFloat(ghost.style.width) || 100;
        ghost.style.width = `${cur + (target - cur) * 0.08}%`;
      });
      // cooldowns
      for (let i = 0; i < 3; i += 1) {
        const btn = $(`ab-${i}`);
        const arc = $(`ab-${i}-arc`);
        const num = $(`ab-${i}-num`);
        const spec = p.kit.abilities[i];
        const cd = p.cooldowns[i];
        const onCd = cd > 0;
        const poor = p.stamina < spec.stamina;
        btn.classList.toggle("is-cd", onCd);
        btn.classList.toggle("is-poor", !onCd && poor);
        btn.disabled = onCd || poor || p.dead;
        if (onCd) {
          const pct = (1 - cd / spec.cd) * 100;
          arc.style.background = `conic-gradient(transparent ${pct}%, rgba(3,5,16,0.78) 0)`;
          num.textContent = cd >= 1 ? Math.ceil(cd) : cd.toFixed(1);
        } else {
          arc.style.background = "transparent";
          num.textContent = "";
        }
      }
      const atk = $("btn-attack");
      atk.classList.toggle("is-poor", p.stamina < p.kit.basic.stamina);
    },

    async finish(outcome, hpLeft) {
      if (this.settling) return;
      this.settling = true;
      this.started = false;
      try {
        const data = await api("/api/arena/finish", {
          outcome,
          hp_left: Math.max(1, Math.round(hpLeft / HP_SCALE)),
        });
        render(data.player);
        const effects = data.turn.effects || {};
        if (outcome === "win") {
          UI.win();
          haptic("success");
          toast(data.turn.summary, "success");
          if (effects.loot?.length) showLoot(effects.loot, data.turn.summary);
        } else {
          haptic("error");
          toast(data.turn.summary, "error");
        }
      } catch (err) {
        toast(err.message, "error");
      } finally {
        this.arena.stop();
        this.open();
        $("fight-start-label").textContent = outcome === "win" ? "NEXT CHAPTER" : "REMATCH";
        this.settling = false;
      }
    },

    /* ---------------- controls ---------------- */
    bindControls() {
      const arena = this.arena;
      const stick = $("joystick");
      const knob = $("stick-knob");
      let stickId = null;
      const radius = 52;

      // horizontal-only movement: this is a side-view fighter, no vertical lane
      const setVector = (dx) => {
        arena.input.dx = dx;
      };
      const moveKnob = (x, y) => {
        knob.style.transform = `translate(${x}px, ${y}px)`;
      };
      const onStart = (event) => {
        const t = event.changedTouches ? event.changedTouches[0] : event;
        stickId = t.identifier !== undefined ? t.identifier : "mouse";
        stick.classList.add("is-active");
        onMove(event);
      };
      const onMove = (event) => {
        if (stickId === null) return;
        const rect = stick.getBoundingClientRect();
        const touches = event.changedTouches ? Array.from(event.changedTouches) : [event];
        const t = touches.find((x) => (x.identifier !== undefined ? x.identifier === stickId : true));
        if (!t) return;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = t.clientX - cx;
        let dy = t.clientY - cy;
        const len = Math.hypot(dx, dy) || 1;
        const capped = Math.min(len, radius);
        dx = (dx / len) * capped;
        dy = (dy / len) * capped;
        moveKnob(dx, dy * 0.35);
        setVector(dx / radius);
        event.preventDefault();
      };
      const onEnd = () => {
        stickId = null;
        stick.classList.remove("is-active");
        moveKnob(0, 0);
        setVector(0);
      };

      stick.addEventListener("touchstart", onStart, { passive: false });
      stick.addEventListener("touchmove", onMove, { passive: false });
      stick.addEventListener("touchend", onEnd);
      stick.addEventListener("touchcancel", onEnd);
      stick.addEventListener("mousedown", (e) => { onStart(e); e.preventDefault(); });
      window.addEventListener("mousemove", (e) => { if (stickId !== null) onMove(e); });
      window.addEventListener("mouseup", () => { if (stickId !== null) onEnd(); });

      const press = (node, fn) => {
        const handler = (event) => {
          event.preventDefault();
          fn();
          node.classList.add("is-press");
          setTimeout(() => node.classList.remove("is-press"), 130);
          haptic("light");
        };
        node.addEventListener("touchstart", handler, { passive: false });
        node.addEventListener("mousedown", handler);
      };
      press($("btn-attack"), () => { arena.input.attack = true; });
      for (let i = 0; i < 3; i += 1) {
        press($(`ab-${i}`), () => { arena.input.abilities[i] = true; });
      }

      // keyboard for desktop testing
      const keys = {};
      const applyKeys = () => {
        const dx = (keys.d || keys.ArrowRight ? 1 : 0) - (keys.a || keys.ArrowLeft ? 1 : 0);
        arena.input.dx = dx;
      };
      window.addEventListener("keydown", (e) => {
        if (state.screen !== "battle") return;
        keys[e.key] = true;
        if (e.key === " " || e.key === "j") arena.input.attack = true;
        if (e.key === "u") arena.input.abilities[0] = true;
        if (e.key === "i") arena.input.abilities[1] = true;
        if (e.key === "o") arena.input.abilities[2] = true;
        applyKeys();
      });
      window.addEventListener("keyup", (e) => { keys[e.key] = false; applyKeys(); });
    },
  };

  /* ------------------------------------------------------------------ *
   * rendering (home / store / satchel)
   * ------------------------------------------------------------------ */
  function setBar(id, ratio) {
    const node = $(id);
    if (node) node.style.width = `${clamp(ratio * 100, 0, 100).toFixed(1)}%`;
  }

  function render(view) {
    state.player = view;
    const { hero, quest, enemy, character, roster } = view;
    document.documentElement.style.setProperty("--element", character.element_color);
    document.documentElement.style.setProperty("--foe-element", enemy.element_color);

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
    $("version-note").textContent = `ChronicleRift ${state.version ? `v${state.version}` : ""}`;

    renderHealRail(view);
    renderHeroStore(view);
    renderShop(view);
    renderForge(view);
    renderSatchel(view);
    if (state.screen === "battle" && !Fight.started) Fight.renderAbilityButtons(view);
  }

  const HEAL_IDS = ["salve", "draught", "greater_draught", "regen_balm", "phoenix_tear", "elixir"];
  function healingItems(view) {
    return view.inventory.filter((c) => c.kind === "consumable" && (HEAL_IDS.includes(c.id) || /heal|hp|vital/i.test(c.ability)));
  }

  function renderHealRail(view) {
    const strip = $("rail-strip");
    if (!strip) return;
    strip.replaceChildren();
    const heals = healingItems(view);
    if (!heals.length) {
      const empty = el("button", "rail-empty");
      empty.type = "button";
      empty.innerHTML = "<b>No potions left</b><small>Tap to buy instantly</small>";
      empty.addEventListener("click", openRestock);
      strip.appendChild(empty);
      return;
    }
    heals.forEach((card) => {
      const btn = el("button", "rail-item");
      btn.type = "button";
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
      const kit = window.ChronicleArena.kitFor(card.element);
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
      const basic = el("li");
      basic.appendChild(el("b", null, kit.basic.name));
      basic.appendChild(el("span", null, "basic attack"));
      moves.appendChild(basic);
      kit.abilities.forEach((a) => {
        const li = el("li");
        li.appendChild(el("b", null, a.name));
        li.appendChild(el("span", null, `${a.cd}s CD`));
        moves.appendChild(li);
      });
      body.appendChild(moves);

      const btn = el("button", "btn-primary wide");
      btn.type = "button";
      btn.disabled = state.busy || card.active;
      btn.textContent = card.active ? "In play" : card.owned ? "Select hero" : `Recruit · ${card.cost} 🪙`;
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
    img.onerror = () => img.replaceWith(el("div", "item-emoji", card.emoji));
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
    view.shop.filter((c) => c.kind === "consumable").forEach((card) => {
      grid.appendChild(itemNode(card, {
        actionLabel: `${card.cost} 🪙`,
        disabled: view.hero.coins < card.cost,
        onAction: () => buyItem(card),
      }));
    });
  }

  function renderForge(view) {
    const grid = $("forge-list");
    grid.replaceChildren();
    view.relics.forEach((card) => {
      const capped = card.level >= card.max_level;
      grid.appendChild(itemNode(card, {
        actionLabel: capped ? "MAX" : `${card.next_cost} 🪙`,
        disabled: capped || view.hero.coins < (card.next_cost || 0),
        caption: `Lv ${card.level}/${card.max_level} · ${card.bonus_now || "not forged"}${card.bonus_next ? ` → ${card.bonus_next}` : ""}`,
        onAction: () => upgradeRelic(card),
      }));
    });
  }

  function renderSatchel(view) {
    const grid = $("satchel-list");
    grid.replaceChildren();
    if (!view.inventory.length) {
      grid.appendChild(el("p", "note", "Your satchel is empty. Win a duel to earn loot."));
      return;
    }
    view.inventory.forEach((card) => {
      const node = itemNode(card, {
        actionLabel: `Sell ${card.sell} 🪙`,
        onAction: () => sellItem(card),
        caption: `${card.desc} · carrying ${card.quantity}`,
      });
      if (card.kind === "consumable") {
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
   * item actions
   * ------------------------------------------------------------------ */
  async function itemCall(path, body) {
    if (state.busy) return null;
    state.busy = true;
    try {
      const data = await api(path, body);
      const hadHeals = state.player ? healingItems(state.player).length : 0;
      render(data.player);
      if (data.turn.success) { toast(data.turn.summary, "success"); haptic("success"); }
      else { toast(data.turn.reason || data.turn.summary, "error"); haptic("error"); }
      const now = healingItems(data.player).length;
      if (hadHeals > 0 && now === 0 && state.screen === "battle") openRestock();
      return data;
    } catch (err) {
      toast(err.message, "error");
      return null;
    } finally {
      state.busy = false;
    }
  }

  async function useItem(card) {
    const before = state.player?.hero.hp ?? 0;
    const data = await itemCall("/api/use", { item_id: card.id });
    if (!data) return;
    UI.heal();
    const healed = (data.player.hero.hp || 0) - before;
    // a potion drunk before or between rounds also tops up the arena fighter
    if (healed > 0 && Fight.arena?.player) {
      const f = Fight.arena.player;
      f.hp = Math.min(f.maxHp, f.hp + healed * HP_SCALE);
    }
  }
  const buyItem = (card) => itemCall("/api/buy", { item_id: card.id }).then((d) => { if (d) UI.coin(); return d; });
  const sellItem = (card) => itemCall("/api/sell", { item_id: card.id, quantity: 1 }).then((d) => { if (d) UI.coin(); return d; });
  const upgradeRelic = (card) => itemCall("/api/upgrade", { item_id: card.id }).then((d) => { if (d) UI.coin(); return d; });
  const buyCharacter = (card) => itemCall("/api/character/buy", { item_id: card.id }).then((d) => {
    if (d?.turn.success) { UI.win(); toast(`${card.name} joins your chronicle!`, "success"); }
  });
  const selectCharacter = (card) => itemCall("/api/character/select", { item_id: card.id }).then((d) => {
    if (d?.turn.success) UI.tap();
  });

  function openRestock() {
    if (!state.player) return;
    const list = $("restock-list");
    list.replaceChildren();
    const heals = state.player.shop.filter((c) => c.kind === "consumable" && /heal|hp|vital|revive/i.test(`${c.ability} ${c.desc}`));
    (heals.length ? heals : state.player.shop.filter((c) => c.kind === "consumable")).forEach((card) => {
      list.appendChild(itemNode(card, {
        actionLabel: `Buy ${card.cost} 🪙`,
        disabled: state.player.hero.coins < card.cost,
        onAction: async () => { await buyItem(card); closeModal($("restock-modal")); },
      }));
    });
    $("restock-sub").textContent = `You have ${state.player.hero.coins} coins. Restock without leaving the arena:`;
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
    UI.coin();
  }

  /* ------------------------------------------------------------------ *
   * modals + onboarding
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
    if (tab) { switchTab(tab.dataset.tab); UI.tap(); }
  });

  const SLIDES = [
    {
      kicker: "THE ARENA", title: "A real fight, not a menu", img: "intro-arena",
      body: "You and the chapter monster stand in one arena and duel in real time. Damage only lands when your attack physically connects — range and positioning matter.",
    },
    {
      kicker: "CONTROLS", title: "Joystick left, attacks right", img: "intro-moves",
      body: "Drag the left joystick to move forward, back and along the depth of the arena. The big sword button is your basic attack; the three icons above it are your abilities, each on its own cooldown.",
    },
    {
      kicker: "ABILITIES", title: "Every hero fights differently", img: "camp",
      body: "Fire cleaves and burns, Snow smashes and freezes, Wind whirls and blinks, Magic pierces and drains, Shadow reaps and vanishes. Watch your stamina — attacks cost it.",
    },
    {
      kicker: "HOME BASE", title: "Heroes, store and satchel", img: "intro-market",
      body: "Recruit heroes, buy potions and forge relics from the Home screen. Win a duel to clear the chapter and open a loot chest. Lose and you simply wake at camp, fully healed.",
    },
  ];
  let slideIndex = 0;
  const TUTORIAL_KEY = "cr_tutorial_v7";
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
    const pill = $("connection-status");
    try {
      const data = await api("/api/me");
      state.version = data.version || "";
      render(data.player);
      pill.innerHTML = "<i class='dot'></i>Live";
      pill.classList.add("is-live");
    } catch (err) {
      pill.innerHTML = "<i class='dot'></i>Offline";
      pill.classList.add("is-off");
      toast(err.message, "error");
    }
  }

  function syncSoundIcon() {
    $("sound-on-ic").hidden = !state.settings.sound;
    $("sound-off-ic").hidden = state.settings.sound;
    $("fight-sound").setAttribute("aria-pressed", String(state.settings.sound));
    $("set-sound").checked = state.settings.sound;
    window.ChronicleArena.setMuted(!state.settings.sound);
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
        if (key === "sound" && box.checked) UI.tap();
      });
    });
    $("set-tutorial").addEventListener("click", openTutorial);
  }

  function init() {
    loadSettings();
    try {
      tg?.ready();
      tg?.expand?.();
      tg?.setHeaderColor?.("#05060f");
      tg?.setBackgroundColor?.("#05060f");
      tg?.disableVerticalSwipes?.();
      tg?.BackButton?.onClick?.(() => goto("home"));
    } catch (_) { /* outside Telegram */ }

    bindSettings();
    syncSoundIcon();

    $("play-btn").addEventListener("click", () => goto("battle"));
    $("fight-exit").addEventListener("click", () => goto("home"));
    $("fight-leave").addEventListener("click", () => goto("home"));
    $("fight-start").addEventListener("click", () => Fight.begin());
    $("fight-help").addEventListener("click", openTutorial);
    $("fight-sound").addEventListener("click", () => {
      state.settings.sound = !state.settings.sound;
      saveSettings();
      syncSoundIcon();
      if (state.settings.sound) UI.tap();
    });
    $("loot-close").addEventListener("click", () => closeModal($("loot-modal")));
    $("onboard-next").addEventListener("click", () => {
      if (slideIndex >= SLIDES.length - 1) {
        closeModal($("onboard"));
        try { localStorage.setItem(TUTORIAL_KEY, "1"); } catch (_) { /* ignore */ }
        return;
      }
      slideIndex += 1;
      renderSlide();
      UI.tap();
    });

    refresh().then(() => {
      let seen = "1";
      try { seen = localStorage.getItem(TUTORIAL_KEY); } catch (_) { seen = "1"; }
      if (!seen) openTutorial();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
