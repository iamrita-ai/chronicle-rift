/* ChronicleRift Mini App — v0.10.0
 * Home hub + a real-time 3D arena fight (see arena.js for the engine),
 * a top player bar, and Profile / Rules / Terms screens. Bot buttons deep-link
 * into any screen via the Telegram WebApp start parameter (#play, #profile…).
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
    pendingScreen: null, // deep link from a bot button, resolved once data loads
    settings: { sound: true, haptics: true, shake: true, renderer: "auto" },
  };

  /* Telegram appends the WebApp start parameter as the URL hash (#/play). */
  function readStartParameter() {
    const hash = window.location.hash || "";
    const m = hash.match(/^#\/?([a-z0-9_-]+)/i);
    return m ? m[1].toLowerCase() : "";
  }
  const START_PARAM_SCREENS = {
    play: "battle",
    shop: "store",
    satchel: "bag",
    heroes: "store",
    profile: "profile",
    rules: "rules",
    terms: "terms",
    settings: "settings",
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
  const SCREENS = {
    home: "screen-home",
    battle: "screen-battle",
    store: "screen-store",
    bag: "screen-bag",
    settings: "screen-settings",
    powers: "screen-powers",
    profile: "screen-profile",
    rules: "screen-rules",
    terms: "screen-terms",
  };
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
      if (this.arena) this.arena.resize(section.offsetWidth, section.offsetHeight);
    },

    ensure() {
      if (this.arena) return this.arena;
      this.arena = new window.ChronicleArena.Arena({
        canvas: $("arena-canvas"),
        rendererPref: state.settings.renderer,
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
      // warm the art cache (decode + pre-tint) while the start card is up,
      // so the duel itself never stutters on a texture decode
      window.ChronicleArena.preloadFighters([p.art, e.art]);
      $("mu-hero-art").src = ART(view.character.art, "png");
      $("mu-hero-name").textContent = p.name;
      $("mu-hero-stats").textContent = `${p.stats.hp} HP · ${Math.round(p.stats.damage)} DMG · ${view.character.element_name}`;
      $("mu-foe-art").src = ART(view.enemy.sprite, "png");
      $("mu-foe-name").textContent = e.name;
      $("mu-foe-stats").textContent = `${e.stats.hp} HP · ${Math.round(e.stats.damage)} DMG · ${view.enemy.ability || "—"}${view.enemy.returning ? ` · RETURNED AT LV ${view.enemy.level}` : ""}`;
      $("hud-chapter").textContent = `CH ${view.quest.chapter}`;
      $("fight-start-sub").textContent = `${view.quest.title} · ${view.enemy.boss ? "BOSS FIGHT" : "Chapter duel"}`;
      $("fight-start-label").textContent = "FIGHT";
      document.documentElement.style.setProperty("--element", view.character.element_color);
      document.documentElement.style.setProperty("--foe-element", view.enemy.element_color);
      const scenes = { fire: "bg-ember", ice: "bg-frost", shadow: "bg-void", arcane: "bg-arcane", wind: "bg-arcane" };
      this.arena.setScene(view.enemy.boss ? "bg-gate" : scenes[view.enemy.element] || "bg-ember");
      this.renderAbilityButtons(view);
      renderHealRail(view);
      refreshHealChip();
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
      refreshHealChip();
      haptic("medium");
    },

    leave() {
      if (this.arena) this.arena.stop();
      this.started = false;
      $("heal-chip").hidden = true;
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
      $("hud-p-hp").textContent = `${Math.ceil(p.hp)}/${Math.ceil(p.maxHp)}`;
      $("hud-e-hp").textContent = `${Math.ceil(e.hp)}/${Math.ceil(e.maxHp)}`;
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

    renderTopbar(view);
    renderProfile(view);

    renderHealRail(view);
    renderPowers(view);
    renderHeroStore(view);
    renderShop(view);
    renderForge(view);
    renderSatchel(view);
    if (state.screen === "battle" && !Fight.started) Fight.renderAbilityButtons(view);
  }

  function renderTopbar(view) {
    const chip = $("topbar-profile");
    if (!chip) return;
    $("topbar-avatar").src = ART(view.character.art, "png");
    $("topbar-name").textContent = view.profile?.hero_name || view.hero.name;
    $("topbar-level").textContent = `Lv ${view.hero.level}`;
    $("topbar-coins").textContent = view.hero.coins;
    $("topbar-owner").hidden = !view.owner;
    chip.style.setProperty("--element", view.character.element_color);
  }

  function renderProfile(view) {
    const rec = view.record || {};
    const hero = view.hero;
    const set = (id, text) => { const n = $(id); if (n) n.textContent = text; };
    $("pf-avatar").src = ART(view.character.art, "png");
    $("pf-name").textContent = view.profile?.hero_name || hero.name;
    $("pf-title").textContent = view.character.title;
    $("pf-element").textContent = view.character.element_name.toUpperCase();
    $("pf-element").style.setProperty("--element", view.character.element_color);
    set("pf-username", view.profile?.username ? `@${view.profile.username}` : view.profile?.first_name || "");
    set("pf-wins", rec.wins ?? 0);
    set("pf-losses", rec.losses ?? 0);
    set("pf-boss", rec.boss_kills ?? 0);
    set("pf-chapter", rec.chapter ?? view.quest.chapter);
    set("pf-best", rec.best_chapter ?? view.quest.chapter);
    set("pf-coins", hero.coins);
    set("pf-points", hero.points);
    set("pf-gold", hero.gold);
    set("pf-hp", `${hero.hp}/${hero.max_hp}`);
    set("pf-owned", `${view.roster.filter((c) => c.owned).length} of ${view.roster.length}`);
    set("pf-hero", view.character.name);
    set("pf-relics", view.relics.length ? view.relics.map((r) => `${r.name} L${r.level}`).join(" · ") : "None forged yet");
    setBar("pf-xp", hero.progress);
    set("pf-xp-cap", `${hero.xp} XP · ${hero.xp_to_next} to level ${hero.level + 1}`);

    $("pf-owner").hidden = !view.owner;
    const tgUser = telegramUser();
    const tgRow = $("pf-tg-row");
    if (tgRow) {
      if (tgUser) {
        tgRow.hidden = false;
        const av = $("pf-tg-avatar");
        if (tgUser.photo_url) { av.src = tgUser.photo_url; av.hidden = false; }
        else av.hidden = true;
        set("pf-tg-name", [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || tgUser.username || "Telegram player");
        set("pf-tg-handle", tgUser.username ? `@${tgUser.username}` : `ID ${tgUser.id}`);
        const open = $("pf-tg-open");
        open.hidden = !tgUser.username;
        open.onclick = () => {
          try { tg?.openTelegramLink?.(`https://t.me/${tgUser.username}`); } catch (_) { /* ignore */ }
        };
      } else {
        tgRow.hidden = true;
      }
    }
  }

  function telegramUser() {
    try { return tg?.initDataUnsafe?.user || null; } catch (_) { return null; }
  }

  const HEAL_IDS = ["salve", "draught", "greater_draught", "regen_balm", "phoenix_tear", "elixir"];
  function healingItems(view) {
    return view.inventory.filter((c) => c.kind === "consumable" && (HEAL_IDS.includes(c.id) || /heal|hp|vital/i.test(c.ability)));
  }

  /* ---------------- Powers: trainable attributes ---------------- */
  function renderPowers(view) {
    const list = $("power-list");
    if (!list) return;
    const attrs = view.attributes || { points: 0, max_level: 100, list: [] };
    $("powers-coins").textContent = view.hero.coins;
    $("powers-points").textContent = attrs.points;
    $("powers-note").textContent = attrs.points > 0
      ? `${attrs.points} attribute points!`
      : "Train your hero";
    list.replaceChildren();
    attrs.list.forEach((power) => {
      const card = el("article", "power-card");
      const head = el("div", "power-head");
      head.appendChild(el("span", "power-icon", power.icon));
      const title = el("div", "power-title");
      title.appendChild(el("b", null, power.name));
      title.appendChild(el("small", null, power.desc));
      head.appendChild(title);
      head.appendChild(el("b", "power-level", `Lv ${power.level}`));
      card.appendChild(head);
      const bar = el("div", "power-bar");
      const fill = el("i");
      fill.style.width = `${Math.min(100, (power.level / power.max) * 100)}%`;
      bar.appendChild(fill);
      card.appendChild(bar);
      const actions = el("div", "power-actions");
      const maxed = power.level >= power.max;
      const pointBtn = el("button", "power-btn");
      pointBtn.type = "button";
      pointBtn.textContent = maxed ? "MASTERED" : "USE POINT";
      pointBtn.disabled = maxed || attrs.points < 1;
      pointBtn.addEventListener("click", () => upgradePower(power.id, "points"));
      actions.appendChild(pointBtn);
      const coinBtn = el("button", "power-btn is-coin");
      coinBtn.type = "button";
      coinBtn.textContent = maxed ? "MAX" : `BUY ${power.coin_cost}🪙`;
      coinBtn.disabled = maxed || view.hero.coins < (power.coin_cost || 0);
      coinBtn.addEventListener("click", () => upgradePower(power.id, "coins"));
      actions.appendChild(coinBtn);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function upgradePower(attribute, source) {
    return itemCall("/api/power", { attribute, source });
  }

  /* in-fight quick-heal chip pinned to the player's HP bar */
  function refreshHealChip() {
    const chip = $("heal-chip");
    if (!chip) return;
    const fighting = Fight.arena && Fight.started && !Fight.settling && !Fight.arena.over;
    const heals = fighting && state.player ? healingItems(state.player) : [];
    const best = heals.slice().sort((a, b) => (b.rarity || 0) - (a.rarity || 0))[0];
    if (!best) {
      if (fighting) {
        chip.hidden = false;
        chip.classList.add("is-empty");
        $("heal-chip-img").removeAttribute("src");
        $("heal-chip-qty").textContent = "+";
        chip.title = "No potions — tap to restock";
      } else {
        chip.hidden = true;
      }
      return;
    }
    chip.hidden = false;
    chip.classList.remove("is-empty");
    $("heal-chip-img").src = ART(best.art || "item-heal");
    $("heal-chip-qty").textContent = `×${best.quantity}`;
    chip.title = `${best.name} — ${best.ability}`;
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
      const baseDmg = heroBaseDamage(view);
      const basic = el("li");
      basic.appendChild(el("b", null, kit.basic.name));
      basic.appendChild(el("span", null, `≈${Math.round(baseDmg * kit.basic.mul * (kit.basic.hits || 1))} DMG · basic`));
      moves.appendChild(basic);
      kit.abilities.forEach((a) => {
        const li = el("li");
        li.appendChild(el("b", null, a.name));
        li.appendChild(el("span", null, `≈${Math.round(baseDmg * a.mul * (a.hits || 1))} DMG · ${abilityEffect(a)}`));
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

  /* Per-hero damage estimate — the same formula the arena fighter uses. */
  function heroBaseDamage(view) {
    const h = view.hero;
    return 7 + h.power * 2.2 + h.level * 1.4 + h.attack_bonus * 1.6;
  }

  /* A short, readable effect line for a hero ability (shown in the shop). */
  function abilityEffect(a) {
    const bits = [];
    if (a.hits > 1) bits.push(`${a.hits} hits`);
    if (a.volley > 1) bits.push(`${a.volley} shots`);
    if (a.burn) bits.push(`Burn ${a.burn}s`);
    if (a.freeze) bits.push(`Freeze ${a.freeze}s`);
    if (a.slow) bits.push(`Slow ${a.slow}s`);
    if (a.lifesteal) bits.push(`heals ${Math.round(a.lifesteal * 100)}%`);
    if (a.shield) bits.push(`−${Math.round(a.shield * 100)}% dmg ${a.buffTime}s`);
    if (a.regen) bits.push(`+${a.regen} stamina`);
    if (a.haste) bits.push(`+${Math.round((a.haste - 1) * 100)}% speed`);
    if (a.empower) bits.push(`next hit +${Math.round((a.empower - 1) * 100)}%`);
    if (a.pierceDef) bits.push("unblockable");
    if (a.knock >= 400) bits.push("huge knockback");
    else if (a.knock >= 250) bits.push("knockback");
    if (a.lift >= 150) bits.push("launches");
    if (a.type === "blink") bits.push("teleport");
    if (a.type === "dash") bits.push("dash");
    if (a.iframes) bits.push("untouchable");
    return bits.length ? bits.join(", ") : (a.desc || "ability");
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
    refreshHealChip();
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
   * voice narration — Groq Orpheus speaks the chronicle
   * ------------------------------------------------------------------ */
  let voiceAudio = null;
  async function playNarration() {
    const btn = $("quest-voice");
    if (!btn) return;
    if (voiceAudio && !voiceAudio.paused) {
      voiceAudio.pause();
      btn.classList.remove("is-playing");
      return;
    }
    btn.classList.add("is-busy");
    haptic("light");
    try {
      const res = await fetch("/api/voice", { method: "POST", headers: authHeaders() });
      if (!res.ok) {
        let detail = `Voice unavailable (${res.status})`;
        try {
          const data = await res.json();
          if (data?.detail) detail = data.detail;
        } catch (_) { /* keep the generic message */ }
        throw new Error(detail);
      }
      const blob = await res.blob();
      if (voiceAudio) {
        voiceAudio.pause();
        URL.revokeObjectURL(voiceAudio.src);
      }
      voiceAudio = new Audio(URL.createObjectURL(blob));
      voiceAudio.onended = () => btn.classList.remove("is-playing");
      btn.classList.add("is-playing");
      await voiceAudio.play();
    } catch (err) {
      btn.classList.remove("is-playing");
      toast(err.message, "error");
    } finally {
      btn.classList.remove("is-busy");
    }
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
    // Graphics: Auto uses 3D and falls back to 2D automatically; 3D/2D force
    // a renderer for devices where the automatic choice misbehaves.
    const gfxBtns = ["auto", "3d", "2d"].map((mode) => $(`set-gfx-${mode}`));
    const syncGfx = () => {
      gfxBtns.forEach((btn) => {
        btn.classList.toggle("is-on", state.settings.renderer === btn.dataset.mode);
      });
      const note = $("gfx-note");
      if (note) {
        note.textContent = Fight.arena
          ? `Currently rendering with the ${Fight.arena.use3D ? "3D" : "2D"} engine`
          : "Applies when you enter the arena";
      }
    };
    gfxBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.settings.renderer = btn.dataset.mode;
        saveSettings();
        // rebuild the arena so the choice takes effect immediately
        if (Fight.arena && state.screen !== "battle") {
          try { Fight.arena.stop(); } catch (_) { /* ignore */ }
          Fight.arena = null;
        }
        syncGfx();
        UI.tap();
      });
    });
    syncGfx();
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
    $("heal-chip").addEventListener("click", async () => {
      const heals = state.player ? healingItems(state.player) : [];
      if (!heals.length) { openRestock(); return; }
      const best = heals.slice().sort((a, b) => (b.rarity || 0) - (a.rarity || 0))[0];
      await useItem(best);
    });
    $("fight-help").addEventListener("click", openTutorial);
    $("fight-sound").addEventListener("click", () => {
      state.settings.sound = !state.settings.sound;
      saveSettings();
      syncSoundIcon();
      if (state.settings.sound) UI.tap();
    });
    $("loot-close").addEventListener("click", () => closeModal($("loot-modal")));
    $("quest-voice").addEventListener("click", playNarration);
    $("topbar-profile").addEventListener("click", () => goto("profile"));
    $("pf-play").addEventListener("click", () => goto("battle"));
    $("pf-heroes").addEventListener("click", () => goto("heroes"));
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

    // Deep link from a colored bot button (#play, #profile, #rules, …)
    const startParam = readStartParameter();
    try { history.replaceState(null, "", window.location.pathname); } catch (_) { /* ignore */ }
    const deepTarget = START_PARAM_SCREENS[startParam];
    if (deepTarget) state.pendingScreen = deepTarget;

    refresh().then(() => {
      if (state.pendingScreen) {
        const target = state.pendingScreen;
        state.pendingScreen = null;
        goto(target);
      }
      let seen = "1";
      try { seen = localStorage.getItem(TUTORIAL_KEY); } catch (_) { seen = "1"; }
      if (!seen && state.screen !== "battle") openTutorial();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
