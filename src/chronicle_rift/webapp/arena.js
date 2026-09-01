/* ChronicleRift — Arena v2
 * A real-time, landscape, side-view fighting engine.
 *
 * Fighters are the ACTUAL character / monster artwork: each PNG is keyed to
 * transparency once at load, split into a torso and a legs piece, and driven as
 * a two-part puppet (breathing, walk bounce, lunges, recoil, tumble, collapse).
 * Damage is only ever applied when an active hitbox overlaps a hurtbox.
 */
(() => {
  "use strict";

  const ARENA_HALF = 560;
  const GRAVITY = 1800;
  const FIGHTER_H = 168; // world units tall
  const HURT_W = 62;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const approach = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

  /* ================================================================== *
   * sprite keying — turn near-black artwork into a clean cut-out
   * ================================================================== */
  const spriteCache = new Map();

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function keySprite(entry) {
    const img = entry.img;
    if (!img.width) return;
    const W = 460;
    const H = Math.max(1, Math.round((img.height * W) / img.width));
    const c = makeCanvas(W, H);
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0, W, H);
    const data = cx.getImageData(0, 0, W, H);
    const d = data.data;
    let minX = W;
    let minY = H;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        let a = (lum - 16) / 40;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        // keep colour but push very dark pixels out entirely
        d[i + 3] = Math.round(a * 255);
        if (a > 0.12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    cx.putImageData(data, 0, 0);
    if (maxX <= minX || maxY <= minY) {
      minX = 0; minY = 0; maxX = W - 1; maxY = H - 1;
    }
    const tw = maxX - minX + 1;
    const th = maxY - minY + 1;
    const trimmed = makeCanvas(tw, th);
    trimmed.getContext("2d").drawImage(c, minX, minY, tw, th, 0, 0, tw, th);

    // white silhouette (hit flash) and a coloured silhouette (aura / afterimage)
    const white = makeCanvas(tw, th);
    const wx = white.getContext("2d");
    wx.drawImage(trimmed, 0, 0);
    wx.globalCompositeOperation = "source-in";
    wx.fillStyle = "#ffffff";
    wx.fillRect(0, 0, tw, th);

    entry.base = trimmed;
    entry.white = white;
    entry.w = tw;
    entry.h = th;
    entry.ready = true;
  }

  function loadSprite(src) {
    if (spriteCache.has(src)) return spriteCache.get(src);
    const entry = { ready: false, img: new Image(), base: null, white: null, w: 1, h: 1 };
    entry.img.crossOrigin = "anonymous";
    entry.img.onload = () => {
      try { keySprite(entry); } catch (_) { entry.ready = false; }
    };
    entry.img.src = src;
    spriteCache.set(src, entry);
    return entry;
  }

  /* pre-rendered soft glow used for every particle (no per-frame shadowBlur) */
  let GLOW = null;
  function glowSprite() {
    if (GLOW) return GLOW;
    const size = 64;
    GLOW = makeCanvas(size, size);
    const g = GLOW.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return GLOW;
  }
  const tintCache = new Map();
  function tintedGlow(color) {
    if (tintCache.has(color)) return tintCache.get(color);
    const size = 64;
    const c = makeCanvas(size, size);
    const g = c.getContext("2d");
    g.drawImage(glowSprite(), 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    tintCache.set(color, c);
    return c;
  }

  /* ================================================================== *
   * audio — a small, smooth synth bank
   * ================================================================== */
  const Audio2 = {
    ctx: null,
    master: null,
    muted: false,
    ready() {
      if (this.ctx) {
        if (this.ctx.state === "suspended") this.ctx.resume();
        return this.ctx;
      }
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.ratio.value = 8;
        this.master.connect(comp).connect(this.ctx.destination);
        // gentle ambience bus (short delay = space, keeps hits from sounding dry)
        this.wet = this.ctx.createGain();
        this.wet.gain.value = 0.16;
        const delay = this.ctx.createDelay();
        delay.delayTime.value = 0.13;
        const fb = this.ctx.createGain();
        fb.gain.value = 0.22;
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 2600;
        this.wet.connect(delay).connect(lp).connect(fb).connect(delay);
        lp.connect(this.master);
      } catch (_) {
        this.ctx = null;
      }
      return this.ctx;
    },
    env(node, t0, dur, peak, attack = 0.008) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      node.connect(g);
      g.connect(this.master);
      g.connect(this.wet);
      return g;
    },
    osc({ freq = 440, type = "sine", dur = 0.2, gain = 0.2, slide = 0, delay = 0, detune = 0, filter = 0 }) {
      if (this.muted || !this.ready()) return;
      const t0 = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
      let src = o;
      if (filter) {
        const f = this.ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(filter, t0);
        f.frequency.exponentialRampToValueAtTime(Math.max(200, filter * 0.25), t0 + dur);
        o.connect(f);
        src = f;
      }
      this.env(src, t0, dur, gain);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    },
    noise({ dur = 0.2, gain = 0.2, type = "bandpass", freq = 1200, q = 1, sweep = 0, delay = 0 }) {
      if (this.muted || !this.ready()) return;
      const t0 = this.ctx.currentTime + delay;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(freq, t0);
      if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(120, freq + sweep), t0 + dur);
      src.connect(f);
      this.env(f, t0, dur, gain, 0.004);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    },
  };

  const SFX = {
    step: () => Audio2.noise({ dur: 0.07, gain: 0.05, type: "bandpass", freq: 260, q: 1.2 }),
    whoosh: () => Audio2.noise({ dur: 0.16, gain: 0.1, type: "bandpass", freq: 900, q: 0.9, sweep: -600 }),
    clang: (el) => {
      const base = { fire: 300, ice: 520, wind: 640, arcane: 460, shadow: 240 }[el] || 340;
      Audio2.osc({ freq: base, type: "triangle", dur: 0.18, gain: 0.17, slide: -140, filter: 3200 });
      Audio2.osc({ freq: base * 1.5, type: "square", dur: 0.1, gain: 0.07, slide: -200, detune: 8 });
      Audio2.noise({ dur: 0.12, gain: 0.12, type: "bandpass", freq: 2200, q: 0.8, sweep: -1400 });
    },
    thud: () => {
      Audio2.osc({ freq: 130, type: "sine", dur: 0.34, gain: 0.3, slide: -95 });
      Audio2.noise({ dur: 0.26, gain: 0.18, type: "lowpass", freq: 700, sweep: -420 });
    },
    cast: (el) => {
      const base = { fire: 300, ice: 700, wind: 820, arcane: 560, shadow: 220 }[el] || 480;
      Audio2.osc({ freq: base, type: "sine", dur: 0.4, gain: 0.13, slide: base * 1.4, filter: 4000 });
      Audio2.osc({ freq: base * 2, type: "triangle", dur: 0.32, gain: 0.06, slide: base, delay: 0.05 });
    },
    boom: (el) => {
      if (el === "ice") {
        Audio2.noise({ dur: 0.3, gain: 0.2, type: "highpass", freq: 1800, sweep: 1200 });
        Audio2.osc({ freq: 900, type: "triangle", dur: 0.24, gain: 0.12, slide: -600 });
      } else if (el === "fire") {
        Audio2.noise({ dur: 0.42, gain: 0.22, type: "lowpass", freq: 1500, sweep: -1100 });
        Audio2.osc({ freq: 110, type: "sine", dur: 0.36, gain: 0.2, slide: -50 });
      } else {
        Audio2.osc({ freq: 220, type: "sine", dur: 0.4, gain: 0.2, slide: -120 });
        Audio2.noise({ dur: 0.3, gain: 0.16, type: "bandpass", freq: 1400, q: 0.7, sweep: -900 });
      }
    },
    dash: () => Audio2.noise({ dur: 0.24, gain: 0.13, type: "bandpass", freq: 1500, q: 0.7, sweep: -1200 }),
    ward: () => {
      Audio2.osc({ freq: 320, type: "sine", dur: 0.5, gain: 0.12, slide: 260 });
      Audio2.osc({ freq: 640, type: "sine", dur: 0.4, gain: 0.06, slide: 200, delay: 0.06 });
    },
    hurt: () => Audio2.osc({ freq: 200, type: "sawtooth", dur: 0.16, gain: 0.1, slide: -110, filter: 1400 }),
    ko: () => {
      Audio2.osc({ freq: 300, type: "sawtooth", dur: 0.5, gain: 0.16, slide: -220, filter: 1200 });
      Audio2.noise({ dur: 0.6, gain: 0.16, type: "lowpass", freq: 900, sweep: -700 });
    },
    win: () => [523, 659, 784, 1046].forEach((f, i) =>
      Audio2.osc({ freq: f, type: "triangle", dur: 0.5, gain: 0.11, delay: i * 0.11, filter: 5200 })),
  };

  /* ================================================================== *
   * kits
   * ================================================================== */
  const KITS = {
    fire: {
      color: "#ff8a3c", glow: "#ffd479", scene: "bg-ember",
      basic: { name: "Ember Slash", mul: 1.0, range: 104, knock: 130, type: "slash", stamina: 9 },
      abilities: [
        { id: "a1", name: "Molten Cleave", icon: "icon-fire-1", cd: 6, stamina: 26, type: "heavy",
          mul: 2.35, range: 124, knock: 470, lift: 210, windup: 0.32, active: 0.14, recover: 0.36,
          shake: 16, desc: "Overhead cleave, huge knockback" },
        { id: "a2", name: "Cinder Wave", icon: "icon-fire-2", cd: 8, stamina: 22, type: "magic",
          mul: 1.55, speed: 540, burn: 4, windup: 0.26, recover: 0.3, shake: 8,
          desc: "Fire projectile that sets Burning" },
        { id: "a3", name: "Ember Dash", icon: "icon-fire-3", cd: 7, stamina: 18, type: "dash",
          mul: 1.15, dashSpeed: 940, dashTime: 0.26, iframes: 0.3, burn: 2, knock: 190,
          desc: "Blaze through the enemy, immune while dashing" },
      ],
    },
    ice: {
      color: "#7fd8ff", glow: "#dff4ff", scene: "bg-frost",
      basic: { name: "Rime Jab", mul: 0.92, range: 100, knock: 110, type: "slash", stamina: 8 },
      abilities: [
        { id: "a1", name: "Glacier Smash", icon: "icon-ice-1", cd: 6.5, stamina: 28, type: "heavy",
          mul: 2.5, range: 118, knock: 430, lift: 170, windup: 0.38, active: 0.14, recover: 0.4,
          shake: 18, slow: 2.5, desc: "Ground-shattering smash that slows" },
        { id: "a2", name: "Deep Freeze", icon: "icon-ice-2", cd: 10, stamina: 24, type: "magic",
          mul: 1.25, speed: 450, freeze: 1.4, windup: 0.3, recover: 0.32, shake: 6,
          desc: "Freezes the enemy solid" },
        { id: "a3", name: "Frost Barrier", icon: "icon-ice-3", cd: 12, stamina: 20, type: "buff",
          shield: 0.55, buffTime: 5, windup: 0.22, recover: 0.28, desc: "Halves incoming damage for 5s" },
      ],
    },
    wind: {
      color: "#8ef0a8", glow: "#dcffe8", scene: "bg-arcane",
      basic: { name: "Twin Slice", mul: 0.85, range: 98, knock: 100, type: "slash", stamina: 7, hits: 2 },
      abilities: [
        { id: "a1", name: "Cyclone Kick", icon: "icon-wind-1", cd: 5.5, stamina: 24, type: "heavy",
          mul: 0.95, hits: 3, range: 112, knock: 270, lift: 120, windup: 0.2, active: 0.34,
          recover: 0.28, shake: 10, desc: "Spinning three-hit whirl" },
        { id: "a2", name: "Gale Flurry", icon: "icon-wind-2", cd: 7.5, stamina: 21, type: "magic",
          mul: 0.75, volley: 3, speed: 720, windup: 0.18, recover: 0.26, shake: 5, desc: "Three razor gusts" },
        { id: "a3", name: "Blink", icon: "icon-wind-3", cd: 6, stamina: 14, type: "blink",
          iframes: 0.35, hasteTime: 4, haste: 1.5, desc: "Teleport behind the enemy, +50% speed" },
      ],
    },
    arcane: {
      color: "#b48bff", glow: "#e8dcff", scene: "bg-arcane",
      basic: { name: "Rune Bolt", mul: 1.05, range: 108, knock: 120, type: "slash", stamina: 9 },
      abilities: [
        { id: "a1", name: "Sigil Burst", icon: "icon-arcane-1", cd: 7, stamina: 27, type: "heavy",
          mul: 2.15, range: 138, knock: 390, lift: 190, windup: 0.34, active: 0.16, recover: 0.38,
          shake: 15, desc: "Detonates a sigil around you" },
        { id: "a2", name: "Mind Siphon", icon: "icon-arcane-2", cd: 8.5, stamina: 23, type: "magic",
          mul: 1.6, speed: 490, lifesteal: 0.5, pierceDef: true, windup: 0.28, recover: 0.32,
          shake: 7, desc: "Unblockable bolt, heals 50%" },
        { id: "a3", name: "Rune Ward", icon: "icon-arcane-3", cd: 11, stamina: 18, type: "buff",
          shield: 0.62, buffTime: 4.5, regen: 22, windup: 0.22, recover: 0.26, desc: "Ward + fast stamina regen" },
      ],
    },
    shadow: {
      color: "#ff6ac1", glow: "#ffd6f0", scene: "bg-void",
      basic: { name: "Reap", mul: 1.1, range: 112, knock: 130, type: "slash", stamina: 10 },
      abilities: [
        { id: "a1", name: "Grave Arc", icon: "icon-shadow-1", cd: 6.5, stamina: 29, type: "heavy",
          mul: 2.45, range: 142, knock: 440, lift: 180, windup: 0.34, active: 0.16, recover: 0.38,
          shake: 17, desc: "Wide reaping arc" },
        { id: "a2", name: "Soul Harvest", icon: "icon-shadow-2", cd: 9, stamina: 25, type: "magic",
          mul: 1.7, speed: 480, lifesteal: 0.4, slow: 2, windup: 0.3, recover: 0.32, shake: 9,
          desc: "Drains life and slows" },
        { id: "a3", name: "Shadowstep", icon: "icon-shadow-3", cd: 8, stamina: 16, type: "blink",
          iframes: 0.45, empower: 1.9, empowerTime: 5, desc: "Vanish, reappear behind, next hit empowered" },
      ],
    },
  };
  const kitFor = (element) => KITS[element] || KITS.fire;

  /* ================================================================== *
   * fighter
   * ================================================================== */
  class Fighter {
    constructor(cfg) {
      this.name = cfg.name;
      this.element = cfg.element;
      this.kit = kitFor(cfg.element);
      this.isPlayer = !!cfg.isPlayer;
      this.build = cfg.build || "hero";
      this.stats = cfg.stats;
      this.sprite = loadSprite(cfg.art);
      this.artFacing = cfg.artFacing || 1; // which way the artwork looks
      this.maxHp = cfg.stats.hp;
      this.hp = cfg.stats.hp;
      this.maxStamina = 100;
      this.stamina = 100;
      this.x = cfg.x;
      this.y = 0;
      this.vx = 0;
      this.vy = 0;
      this.facing = cfg.facing;
      this.state = "idle";
      this.stateT = 0;
      this.animT = rand(0, 5);
      this.attack = null;
      this.phase = "";
      this.hitsDone = 0;
      this.cooldowns = [0, 0, 0];
      this.iframes = 0;
      this.shield = 0;
      this.shieldTime = 0;
      this.burn = 0;
      this.burnTick = 0;
      this.freeze = 0;
      this.slow = 0;
      this.haste = 0;
      this.hasteMul = 1;
      this.empower = 0;
      this.empowerMul = 1;
      this.dead = false;
      this.flash = 0;
      this.combo = 0;
      this.comboT = 0;
      this.stepT = 0;
      this.ghosts = [];
      // puppet pose
      this.pose = { torso: 0, lean: 0, bob: 0, breath: 1, squash: 1, dip: 0, spin: 0, reach: 0 };
      this.target = { ...this.pose };
    }

    get busy() {
      return ["attack", "ability", "dash", "hurt", "knock"].includes(this.state) || this.dead;
    }

    hurtbox() {
      const w = this.build === "brute" ? HURT_W * 1.3 : HURT_W;
      const h = FIGHTER_H * (this.build === "brute" ? 1.14 : 1);
      return { x: this.x - w / 2, w, y0: this.y, y1: this.y + h };
    }
  }

  /* ================================================================== *
   * arena
   * ================================================================== */
  class Arena {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.ctx = this.canvas.getContext("2d", { alpha: false });
      this.onEnd = opts.onEnd || (() => {});
      this.onHud = opts.onHud || (() => {});
      this.hits = [];
      this.shots = [];
      this.fx = [];
      this.numbers = [];
      this.shake = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      this.hitStop = 0;
      this.time = 0;
      this.over = false;
      this.ended = false;
      this.running = false;
      this.input = { dx: 0, attack: false, abilities: [false, false, false] };
      this.cam = { x: 0, zoom: 1 };
      this.scene = null;
      this.sceneLayer = null;
      this.w = 640;
      this.h = 360;
      this.dpr = 1;
    }

    setScene(name) {
      if (this.sceneName === name) return;
      this.sceneName = name;
      this.sceneReady = false;
      const img = new Image();
      img.onload = () => {
        this.sceneImg = img;
        this.sceneReady = true;
      };
      img.src = `./art/${name}.jpg`;
    }

    setFighters(playerCfg, enemyCfg) {
      this.player = new Fighter({ ...playerCfg, x: -220, facing: 1, isPlayer: true });
      this.enemy = new Fighter({ ...enemyCfg, x: 220, facing: -1, isPlayer: false });
      this.ai = { think: 0, mode: "approach" };
      this.over = false;
      this.ended = false;
      this.time = 0;
      this.fx.length = 0;
      this.hits.length = 0;
      this.shots.length = 0;
      this.numbers.length = 0;
      this.cam.x = 0;
    }

    resize(logicalW, logicalH) {
      this.w = Math.max(320, Math.round(logicalW));
      this.h = Math.max(200, Math.round(logicalH));
      // keep the pixel budget sane on phones — this is the main perf lever
      const raw = window.devicePixelRatio || 1;
      const budget = 1_600_000;
      let dpr = Math.min(raw, 2);
      while (this.w * this.h * dpr * dpr > budget && dpr > 1) dpr -= 0.1;
      this.dpr = Math.max(1, Math.round(dpr * 10) / 10);
      this.canvas.width = Math.floor(this.w * this.dpr);
      this.canvas.height = Math.floor(this.h * this.dpr);
      this.canvas.style.width = `${this.w}px`;
      this.canvas.style.height = `${this.h}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.imageSmoothingQuality = "low";
      this.groundYpx = this.h * 0.88;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      const loop = (now) => {
        if (!this.running) return;
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this.update(dt);
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }

    /* ---------------- projection (flat side view, horizontal only) --- */
    project(x, y) {
      return [
        this.w / 2 + (x - this.cam.x) * this.cam.zoom + this.shakeX,
        this.groundYpx - y * this.cam.zoom + this.shakeY,
      ];
    }

    /* ---------------- damage ---------------- */
    computeDamage(att, def, spec, mulOverride) {
      const mul = (mulOverride !== undefined ? mulOverride : spec.mul || 1) * att.empowerMul;
      let base = att.stats.damage * mul * (0.9 + Math.random() * 0.2);
      const crit = Math.random() < att.stats.crit;
      if (crit) base *= 1.75;
      if (!spec.pierceDef) {
        base *= 1 - def.stats.defense / (def.stats.defense + 70);
        if (def.shield > 0) base *= 1 - def.shield;
      }
      return { dmg: Math.max(1, Math.round(base)), crit };
    }

    spawnHit(owner, spec, opts = {}) {
      const reach = opts.range !== undefined ? opts.range : spec.range || owner.stats.range;
      this.hits.push({
        owner, spec, reach,
        x: owner.x + owner.facing * (reach / 2 + 16),
        w: reach,
        y0: owner.y - 10,
        y1: owner.y + FIGHTER_H + 12,
        life: opts.life || 0.12,
        knock: opts.knock !== undefined ? opts.knock : spec.knock || 120,
        lift: opts.lift !== undefined ? opts.lift : spec.lift || 0,
        mul: opts.mul,
        kind: opts.kind || spec.type || "slash",
        hitSet: new Set(),
      });
    }

    spawnShot(owner, spec) {
      this.shots.push({
        owner, spec,
        x: owner.x + owner.facing * 58,
        y: 88,
        vx: owner.facing * (spec.speed || 500),
        life: 2.2,
        trail: [],
      });
    }

    applyHit(att, def, box) {
      if (def.iframes > 0 || def.dead) return;
      const spec = box.spec;
      const { dmg, crit } = this.computeDamage(att, def, spec, box.mul);
      def.hp = Math.max(0, def.hp - dmg);
      def.flash = 1;
      att.empowerMul = 1;
      att.empower = 0;
      att.combo += 1;
      att.comboT = 1.6;

      if (spec.burn) { def.burn = Math.max(def.burn, spec.burn); def.burnTick = 0; }
      if (spec.freeze) def.freeze = Math.max(def.freeze, spec.freeze);
      if (spec.slow) def.slow = Math.max(def.slow, spec.slow);
      if (spec.lifesteal) {
        const heal = Math.round(dmg * spec.lifesteal);
        att.hp = Math.min(att.maxHp, att.hp + heal);
        this.number(att, `+${heal}`, "#8ef0a8", false);
        this.particles(att, 8, "#8ef0a8");
      }

      const dir = Math.sign(def.x - att.x) || att.facing;
      const knock = box.knock * (def.build === "brute" ? 0.6 : 1);
      def.vx += dir * knock;
      if (box.lift) { def.vy = box.lift; def.y = Math.max(def.y, 1); }
      def.state = box.lift > 120 || knock > 320 ? "knock" : "hurt";
      def.stateT = 0;
      def.attack = null;

      this.number(def, `${dmg}`, crit ? "#ffd479" : "#ff7a86", crit);
      this.impact(def, box.kind, crit, att);
      this.addShake(clamp((box.knock + dmg * 5) / 420, 0.25, 1.5) * (crit ? 14 : 9));
      this.hitStop = Math.max(this.hitStop, crit ? 0.09 : 0.05);
      if (box.kind === "heavy") SFX.thud();
      else if (box.kind === "magic") SFX.boom(att.element);
      else SFX.clang(att.element);
      if (Math.random() < 0.5) SFX.hurt();
      if (def.hp <= 0) this.knockout(def);
    }

    knockout(f) {
      f.dead = true;
      f.state = "dead";
      f.stateT = 0;
      f.vx += (f.facing > 0 ? -1 : 1) * 200;
      f.vy = 260;
      this.addShake(18);
      this.hitStop = 0.16;
      SFX.ko();
      const winner = f === this.player ? this.enemy : this.player;
      winner.state = "victory";
      winner.stateT = 0;
      this.over = true;
      this.endT = 0;
      setTimeout(() => SFX.win(), 650);
    }

    number(f, text, color, crit) {
      this.numbers.push({ x: f.x + rand(-14, 14), y: f.y + FIGHTER_H * 0.8, vy: 96, life: 1, text, color, crit });
    }
    particles(f, count, color, spread = 1) {
      if (this.fx.length > 130) return;
      for (let i = 0; i < count; i += 1) {
        this.fx.push({
          type: "mote", color,
          x: f.x + rand(-18, 18) * spread,
          y: f.y + FIGHTER_H * rand(0.3, 0.85),
          vx: rand(-230, 230) * spread,
          vy: rand(40, 330),
          life: rand(0.3, 0.7), max: 0.7, size: rand(6, 18),
        });
      }
    }
    impact(def, kind, crit, att) {
      const color = att.kit.color;
      const y = def.y + FIGHTER_H * 0.55;
      this.fx.push({ type: "ring", color, x: def.x, y, life: 0.32, max: 0.32, size: kind === "heavy" ? 18 : 12, grow: kind === "heavy" ? 210 : 130 });
      this.fx.push({ type: "flash", color: crit ? "#ffffff" : att.kit.glow, x: def.x, y, life: 0.18, max: 0.18, size: crit ? 90 : 62 });
      if (kind === "slash") {
        this.fx.push({ type: "slash", color: "#ffffff", x: def.x, y, life: 0.16, max: 0.16, size: 62, rot: rand(-0.9, -0.3) * att.facing });
        this.particles(def, 9, "#ffe9a8");
      } else if (kind === "heavy") {
        this.particles(def, 18, color, 1.4);
        this.particles(def, 8, "#ffffff", 1.1);
      } else {
        this.particles(def, 16, color, 1.2);
      }
    }
    addShake(v) {
      this.shake = Math.min(24, this.shake + v);
    }

    /* ---------------- actions ---------------- */
    canAct(f) {
      return !f.dead && !this.over && f.freeze <= 0 && !f.busy;
    }
    doBasic(f) {
      const spec = f.kit.basic;
      if (!this.canAct(f) || f.stamina < spec.stamina) return false;
      f.stamina -= spec.stamina;
      f.state = "attack";
      f.stateT = 0;
      f.phase = "windup";
      f.hitsDone = 0;
      f.attack = {
        ...spec,
        windup: 0.13 / f.stats.atkSpeed,
        active: 0.1 / f.stats.atkSpeed,
        recover: 0.19 / f.stats.atkSpeed,
        range: f.stats.range,
      };
      SFX.whoosh();
      return true;
    }
    doAbility(f, index) {
      const spec = f.kit.abilities[index];
      if (!spec || !this.canAct(f) || f.cooldowns[index] > 0 || f.stamina < spec.stamina) return false;
      f.stamina -= spec.stamina;
      f.cooldowns[index] = spec.cd;
      f.attack = { ...spec, windup: spec.windup || 0.25, active: spec.active || 0.14, recover: spec.recover || 0.3 };
      f.hitsDone = 0;
      f.phase = "windup";
      f.stateT = 0;

      if (spec.type === "dash") {
        f.state = "dash";
        f.iframes = spec.iframes;
        f.vx = f.facing * spec.dashSpeed;
        f.dashLeft = spec.dashTime;
        SFX.dash();
      } else if (spec.type === "blink") {
        const foe = f === this.player ? this.enemy : this.player;
        this.particles(f, 16, f.kit.color, 1.3);
        this.fx.push({ type: "ring", color: f.kit.color, x: f.x, y: f.y + 70, life: 0.3, max: 0.3, size: 12, grow: 170 });
        f.x = clamp(foe.x - foe.facing * 92, -ARENA_HALF, ARENA_HALF);
        f.facing = Math.sign(foe.x - f.x) || f.facing;
        f.iframes = spec.iframes;
        if (spec.hasteTime) { f.haste = spec.hasteTime; f.hasteMul = spec.haste; }
        if (spec.empower) { f.empower = spec.empowerTime; f.empowerMul = spec.empower; }
        this.particles(f, 16, f.kit.color, 1.3);
        f.state = "idle";
        f.attack = null;
        SFX.dash();
      } else {
        f.state = "ability";
        SFX.cast(f.element);
      }
      return true;
    }
    fireAttack(f) {
      const spec = f.attack;
      if (!spec) return;
      if (spec.type === "magic") {
        const volley = spec.volley || 1;
        this.spawnShot(f, spec);
        for (let i = 1; i < volley; i += 1) {
          setTimeout(() => { if (this.running && !f.dead) this.spawnShot(f, spec); }, i * 110);
        }
      } else if (spec.type === "buff") {
        f.shield = spec.shield;
        f.shieldTime = spec.buffTime;
        if (spec.regen) f.stamina = Math.min(f.maxStamina, f.stamina + spec.regen);
        this.fx.push({ type: "ring", color: f.kit.color, x: f.x, y: f.y + 70, life: 0.5, max: 0.5, size: 16, grow: 160 });
        this.particles(f, 16, f.kit.glow, 1.1);
        SFX.ward();
      } else {
        const hits = spec.hits || 1;
        this.spawnHit(f, spec, { life: (spec.active || 0.12) / hits, kind: spec.type === "heavy" ? "heavy" : "slash", range: spec.range });
        if (spec.type === "heavy") { this.addShake(spec.shake || 8); SFX.whoosh(); }
      }
    }

    /* ---------------- update ---------------- */
    update(dt) {
      if (this.hitStop > 0) { this.hitStop -= dt; dt *= 0.14; }
      this.time += dt;
      const p = this.player;
      const e = this.enemy;
      if (!p || !e) return;

      if (!this.over) {
        this.controlPlayer(p, dt);
        this.runAI(e, p, dt);
      } else {
        this.endT += dt;
        this.input.dx = 0;
      }
      this.stepFighter(p, dt);
      this.stepFighter(e, dt);
      this.separate(p, e);
      this.stepHits(dt);
      this.stepShots(dt);
      this.stepFx(dt);
      this.stepCamera(dt);

      if (this.over && this.endT > 2 && !this.ended) {
        this.ended = true;
        this.onEnd(p.dead ? "lose" : "win", Math.round(p.hp));
      }
      this.onHud(this);
    }

    controlPlayer(f, dt) {
      if (f.dead || f.freeze > 0) return;
      const sp = this.speed(f);
      if (!f.busy) f.vx = approach(f.vx, this.input.dx * sp, 11, dt);
      if (this.input.attack) {
        this.input.attack = false;
        this.faceFoe(f);
        this.doBasic(f);
      }
      for (let i = 0; i < 3; i += 1) {
        if (this.input.abilities[i]) {
          this.input.abilities[i] = false;
          this.faceFoe(f);
          this.doAbility(f, i);
        }
      }
    }

    speed(f) {
      let s = f.stats.speed * f.hasteMul;
      if (f.slow > 0) s *= 0.55;
      return s;
    }
    faceFoe(f) {
      const foe = f === this.player ? this.enemy : this.player;
      f.facing = Math.sign(foe.x - f.x) || f.facing;
    }

    runAI(f, foe, dt) {
      if (f.dead || f.freeze > 0) { f.vx = approach(f.vx, 0, 8, dt); return; }
      this.ai.think -= dt;
      const dx = foe.x - f.x;
      const dist = Math.abs(dx);
      f.facing = Math.sign(dx) || f.facing;

      if (this.ai.think <= 0) {
        this.ai.think = rand(0.16, 0.34);
        const hpRatio = f.hp / f.maxHp;
        const r = Math.random();
        if (f.stamina < 22 && dist < 200) this.ai.mode = "retreat";
        else if (hpRatio < 0.3 && r < 0.28) this.ai.mode = "retreat";
        else if (dist > f.stats.range + 30) this.ai.mode = "approach";
        else this.ai.mode = "fight";
      }
      let wish = 0;
      if (this.ai.mode === "approach") wish = Math.sign(dx);
      else if (this.ai.mode === "retreat") wish = -Math.sign(dx);
      if (!f.busy) f.vx = approach(f.vx, wish * this.speed(f), 9, dt);

      if (this.ai.mode === "fight" && this.canAct(f)) {
        for (let i = 0; i < 3; i += 1) {
          const spec = f.kit.abilities[i];
          const ready = f.cooldowns[i] <= 0 && f.stamina >= spec.stamina;
          const inRange = ["magic", "buff", "blink"].includes(spec.type) || dist < (spec.range || f.stats.range) + 26;
          if (ready && inRange && Math.random() < 0.42) {
            this.doAbility(f, i);
            this.ai.think = rand(0.45, 0.8); // breathing room after a big move
            return;
          }
        }
        if (dist < f.stats.range + 16 && Math.random() < 0.6) {
          this.doBasic(f);
          this.ai.think = rand(0.3, 0.55);
        }
      }
      if (this.canAct(f) && dist > 280 && Math.random() < 0.02) {
        const i = f.kit.abilities.findIndex((s, idx) => s.type === "magic" && f.cooldowns[idx] <= 0);
        if (i >= 0) this.doAbility(f, i);
      }
    }

    stepFighter(f, dt) {
      f.stateT += dt;
      f.animT += dt;
      f.flash = Math.max(0, f.flash - dt * 4.5);
      f.iframes = Math.max(0, f.iframes - dt);
      f.comboT = Math.max(0, f.comboT - dt);
      if (f.comboT <= 0) f.combo = 0;
      for (let i = 0; i < 3; i += 1) f.cooldowns[i] = Math.max(0, f.cooldowns[i] - dt);
      f.shieldTime = Math.max(0, f.shieldTime - dt);
      if (f.shieldTime <= 0) f.shield = 0;
      f.freeze = Math.max(0, f.freeze - dt);
      f.slow = Math.max(0, f.slow - dt);
      f.haste = Math.max(0, f.haste - dt);
      if (f.haste <= 0) f.hasteMul = 1;
      f.empower = Math.max(0, f.empower - dt);
      if (f.empower <= 0) f.empowerMul = 1;

      if (f.burn > 0 && !f.dead) {
        f.burn -= dt;
        f.burnTick -= dt;
        if (f.burnTick <= 0) {
          f.burnTick = 0.5;
          const dmg = Math.max(1, Math.round(f.maxHp * 0.011));
          f.hp = Math.max(0, f.hp - dmg);
          this.number(f, `${dmg}`, "#ff8a3c", false);
          this.particles(f, 3, "#ff8a3c", 0.6);
          if (f.hp <= 0) this.knockout(f);
        }
      }

      f.stamina = Math.min(f.maxStamina, f.stamina + (f.busy ? 7 : 18) * dt);

      if (f.state === "attack" || f.state === "ability") {
        const a = f.attack;
        if (a) {
          const wu = a.windup;
          const ac = a.active;
          if (f.phase === "windup" && f.stateT >= wu) {
            f.phase = "active";
            this.fireAttack(f);
            f.hitsDone = 1;
          } else if (f.phase === "active") {
            const hits = a.hits || 1;
            if (hits > 1 && f.hitsDone < hits && f.stateT >= wu + (ac / hits) * f.hitsDone) {
              this.spawnHit(f, a, { life: (ac / hits) * 0.9, kind: a.type === "heavy" ? "heavy" : "slash", range: a.range });
              f.hitsDone += 1;
              SFX.whoosh();
            }
            if (f.stateT >= wu + ac) f.phase = "recover";
          } else if (f.phase === "recover" && f.stateT >= wu + ac + a.recover) {
            f.state = "idle";
            f.attack = null;
          }
        } else f.state = "idle";
      } else if (f.state === "dash") {
        f.dashLeft -= dt;
        if (f.attack && f.dashLeft > 0) {
          this.spawnHit(f, f.attack, { life: 0.05, kind: "heavy", range: 74, knock: f.attack.knock });
          if (this.fx.length < 110) {
            f.ghosts.push({ x: f.x, life: 0.22, max: 0.22 });
          }
        }
        if (f.dashLeft <= 0) { f.state = "idle"; f.attack = null; f.vx *= 0.25; }
      } else if (f.state === "hurt") {
        if (f.stateT > 0.24) f.state = "idle";
      } else if (f.state === "knock") {
        if (f.y <= 0 && f.stateT > 0.45) f.state = "idle";
      } else if (f.state === "dead" || f.state === "victory") {
        f.vx = approach(f.vx, 0, 5, dt);
      } else {
        f.state = Math.abs(f.vx) > 26 ? "walk" : "idle";
      }

      // footsteps
      if (f.state === "walk" && f.y <= 0) {
        f.stepT -= dt * Math.abs(f.vx) / 120;
        if (f.stepT <= 0) {
          f.stepT = 0.5;
          SFX.step();
          this.fx.push({ type: "dust", color: "rgba(190,200,255,0.5)", x: f.x - Math.sign(f.vx) * 14, y: 4, vx: -Math.sign(f.vx) * 40, vy: 30, life: 0.4, max: 0.4, size: 16 });
        }
      }

      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.y > 0) f.vy -= GRAVITY * dt;
      if (f.y < 0) {
        f.y = 0;
        if (f.vy < -80 && !f.dead) { this.particles(f, 6, "#9fb0ff", 0.6); this.addShake(3); SFX.step(); }
        f.vy = 0;
      }
      const friction = f.state === "knock" || f.state === "dash" ? 1.8 : 10;
      if (f !== this.player || f.busy || Math.abs(this.input.dx) < 0.05) {
        f.vx = approach(f.vx, 0, friction, dt);
      }
      f.x = clamp(f.x, -ARENA_HALF, ARENA_HALF);
      if (!f.dead && !this.over) this.faceFoe(f);

      for (let i = f.ghosts.length - 1; i >= 0; i -= 1) {
        f.ghosts[i].life -= dt;
        if (f.ghosts[i].life <= 0) f.ghosts.splice(i, 1);
      }
      this.poseFighter(f, dt);
    }

    separate(a, b) {
      const minX = a.build === "brute" || b.build === "brute" ? 78 : 66;
      const dx = b.x - a.x;
      const overlap = minX - Math.abs(dx);
      if (overlap > 0 && a.state !== "dash" && b.state !== "dash") {
        const push = (overlap / 2) * Math.sign(dx || 1);
        a.x -= push;
        b.x += push;
      }
    }

    stepHits(dt) {
      for (let i = this.hits.length - 1; i >= 0; i -= 1) {
        const box = this.hits[i];
        box.life -= dt;
        box.x = box.owner.x + box.owner.facing * (box.w / 2 + 16);
        const t = box.owner === this.player ? this.enemy : this.player;
        if (!box.hitSet.has(t) && !t.dead) {
          const hb = t.hurtbox();
          const bx0 = box.x - box.w / 2;
          const bx1 = box.x + box.w / 2;
          if (bx1 > hb.x && bx0 < hb.x + hb.w && box.y1 > hb.y0 && box.y0 < hb.y1) {
            box.hitSet.add(t);
            this.applyHit(box.owner, t, box);
          }
        }
        if (box.life <= 0) this.hits.splice(i, 1);
      }
    }

    stepShots(dt) {
      for (let i = this.shots.length - 1; i >= 0; i -= 1) {
        const s = this.shots[i];
        s.life -= dt;
        s.x += s.vx * dt;
        s.trail.push(s.x);
        if (s.trail.length > 10) s.trail.shift();
        const target = s.owner === this.player ? this.enemy : this.player;
        const hb = target.hurtbox();
        if (!target.dead && s.x > hb.x - 14 && s.x < hb.x + hb.w + 14 && s.y > hb.y0 - 20 && s.y < hb.y1) {
          this.applyHit(s.owner, target, { spec: s.spec, knock: 190, lift: 0, kind: "magic", mul: s.spec.mul });
          this.explode(s);
          this.shots.splice(i, 1);
          continue;
        }
        if (Math.abs(s.x) > ARENA_HALF + 50 || s.life <= 0) {
          this.explode(s);
          this.shots.splice(i, 1);
        }
      }
    }
    explode(s) {
      const color = s.owner.kit.color;
      this.fx.push({ type: "ring", color, x: s.x, y: s.y, life: 0.38, max: 0.38, size: 12, grow: 250 });
      this.fx.push({ type: "flash", color: s.owner.kit.glow, x: s.x, y: s.y, life: 0.22, max: 0.22, size: 80 });
      for (let i = 0; i < 14 && this.fx.length < 140; i += 1) {
        this.fx.push({ type: "mote", color, x: s.x, y: s.y, vx: rand(-260, 260), vy: rand(-60, 300), life: rand(0.3, 0.65), max: 0.65, size: rand(8, 18) });
      }
    }

    stepFx(dt) {
      for (let i = this.fx.length - 1; i >= 0; i -= 1) {
        const p = this.fx[i];
        p.life -= dt;
        if (p.vx !== undefined) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy -= (p.type === "dust" ? 90 : 950) * dt;
          if (p.y < 0) { p.y = 0; p.vy *= -0.3; p.vx *= 0.7; }
        }
        if (p.grow) p.size += p.grow * dt;
        if (p.life <= 0) this.fx.splice(i, 1);
      }
      for (let i = this.numbers.length - 1; i >= 0; i -= 1) {
        const n = this.numbers[i];
        n.life -= dt;
        n.y += n.vy * dt;
        n.vy -= 95 * dt;
        if (n.life <= 0) this.numbers.splice(i, 1);
      }
      this.shake = Math.max(0, this.shake - dt * 44);
      this.shakeX = this.shake ? rand(-this.shake, this.shake) : 0;
      this.shakeY = this.shake ? rand(-this.shake, this.shake) * 0.5 : 0;
    }

    stepCamera(dt) {
      const mid = (this.player.x + this.enemy.x) / 2;
      const dist = Math.abs(this.player.x - this.enemy.x);
      const fit = (this.w - 120) / Math.max(300, dist + 300);
      const zoom = clamp(fit, 0.7, 1.4);
      this.cam.zoom = approach(this.cam.zoom, zoom, 3.5, dt);
      const halfView = this.w / 2 / this.cam.zoom;
      const limit = Math.max(0, ARENA_HALF + 70 - halfView);
      this.cam.x = approach(this.cam.x, clamp(mid, -limit, limit), 5.5, dt);
    }

    /* ---------------- poses (two-part puppet) ---------------- */
    poseFighter(f, dt) {
      const t = f.animT;
      const g = f.target;
      let rate = 12;
      const idle = () => {
        g.torso = 0; g.lean = 0; g.bob = 0; g.squash = 1; g.dip = 0; g.spin = 0; g.reach = 0;
        g.breath = 1;
      };
      switch (f.state) {
        case "idle":
          idle();
          // breathing: chest rises, whole body drifts, small forward sway
          g.breath = 1 + Math.sin(t * 2.1) * 0.022;
          g.bob = Math.sin(t * 2.1) * 2.6;
          g.torso = Math.sin(t * 2.1 + 0.4) * 0.02;
          g.lean = Math.sin(t * 0.9) * 0.012;
          rate = 6;
          break;
        case "walk": {
          idle();
          const w = t * 9.5;
          g.bob = Math.abs(Math.sin(w)) * 7;
          g.squash = 1 - Math.abs(Math.sin(w)) * 0.035;
          g.torso = Math.sin(w) * 0.06;
          g.lean = (f.vx * f.facing > 0 ? 0.1 : -0.07);
          g.breath = 1 + Math.sin(t * 3) * 0.015;
          rate = 14;
          break;
        }
        case "attack":
        case "ability": {
          const a = f.attack || {};
          idle();
          rate = 26;
          if (a.type === "magic" || a.type === "buff") {
            if (f.phase === "windup") { g.torso = -0.18; g.lean = -0.1; g.dip = 6; g.reach = -0.25; }
            else { g.torso = 0.16; g.lean = 0.14; g.reach = 0.5; }
          } else if (a.type === "heavy") {
            if (f.phase === "windup") { g.torso = -0.42; g.lean = -0.24; g.dip = 10; g.reach = -0.5; }
            else if (f.phase === "active") { g.torso = 0.5; g.lean = 0.36; g.dip = 16; g.reach = 1; g.squash = 1.05; }
            else { g.torso = 0.2; g.lean = 0.16; g.dip = 8; g.reach = 0.4; }
            if (a.hits > 1) g.spin = Math.sin(f.stateT * 22) * 0.5;
          } else {
            if (f.phase === "windup") { g.torso = -0.24; g.lean = -0.12; g.reach = -0.3; }
            else if (f.phase === "active") { g.torso = 0.34; g.lean = 0.26; g.reach = 0.95; }
            else { g.torso = 0.12; g.lean = 0.08; g.reach = 0.3; }
          }
          break;
        }
        case "dash":
          idle();
          g.lean = 0.42; g.torso = 0.2; g.dip = 12; g.squash = 1.06;
          rate = 24;
          break;
        case "hurt":
          idle();
          g.torso = -0.34; g.lean = -0.26; g.dip = 8; g.squash = 0.96;
          rate = 30;
          break;
        case "knock":
          idle();
          g.torso = -0.6; g.lean = -0.8; g.spin = -0.5;
          rate = 16;
          break;
        case "dead":
          idle();
          g.lean = -1.4; g.torso = -0.3; g.dip = 20;
          rate = 5;
          break;
        case "victory":
          idle();
          g.bob = Math.abs(Math.sin(t * 3.4)) * 12;
          g.torso = -0.12 + Math.sin(t * 3.4) * 0.05;
          g.breath = 1 + Math.sin(t * 3.4) * 0.04;
          rate = 8;
          break;
        default:
          idle();
      }
      const k = 1 - Math.exp(-rate * dt);
      const p = f.pose;
      p.torso = lerp(p.torso, g.torso, k);
      p.lean = lerp(p.lean, g.lean, k);
      p.bob = lerp(p.bob, g.bob, k);
      p.breath = lerp(p.breath, g.breath, k);
      p.squash = lerp(p.squash, g.squash, k);
      p.dip = lerp(p.dip, g.dip, k);
      p.spin = lerp(p.spin, g.spin, k);
      p.reach = lerp(p.reach, g.reach, k);
    }

    /* ================================================================ *
     * drawing
     * ================================================================ */
    draw() {
      const ctx = this.ctx;
      this.drawScene(ctx);
      const order = [this.player, this.enemy];
      order.forEach((f) => this.drawShadow(ctx, f));
      this.drawGroundFx(ctx);
      order.forEach((f) => this.drawFighter(ctx, f));
      this.drawShots(ctx);
      this.drawAirFx(ctx);
      this.drawNumbers(ctx);
      if (this.over) this.drawEndBanner(ctx);
    }

    drawScene(ctx) {
      const w = this.w;
      const h = this.h;
      if (this.sceneReady && this.sceneImg) {
        // parallax: the backdrop drifts a fraction of the camera
        const img = this.sceneImg;
        const scale = Math.max(w / img.width, h / img.height) * 1.14;
        const dw = img.width * scale;
        const dh = img.height * scale;
        const ox = -this.cam.x * 0.28 * this.cam.zoom + this.shakeX * 0.4;
        ctx.drawImage(img, w / 2 - dw / 2 + ox, h - dh + this.shakeY * 0.3, dw, dh);
      } else {
        ctx.fillStyle = "#0a0d22";
        ctx.fillRect(0, 0, w, h);
      }
      // darken the middle band so fighters always read
      const grad = this.bandGrad || (this.bandGrad = (() => {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, "rgba(4,6,16,0.55)");
        g.addColorStop(0.45, "rgba(4,6,16,0.12)");
        g.addColorStop(1, "rgba(4,6,16,0.72)");
        return g;
      })());
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    drawShadow(ctx, f) {
      if (!f) return;
      const [sx] = this.project(f.x, 0);
      const gy = this.groundYpx + this.shakeY;
      const lift = clamp(1 - f.y / 400, 0.4, 1);
      ctx.save();
      ctx.globalAlpha = 0.42 * lift;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(sx, gy, 42 * this.cam.zoom * lift, 11 * this.cam.zoom * lift, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawFighter(ctx, f) {
      const sp = f.sprite;
      const zoom = this.cam.zoom;
      const [sx, sy] = this.project(f.x, f.y);
      const p = f.pose;
      const flip = f.facing * f.artFacing;

      if (!sp.ready) {
        ctx.fillStyle = f.kit.color;
        ctx.fillRect(sx - 20, sy - 120, 40, 120);
        return;
      }

      const drawH = FIGHTER_H * (f.build === "brute" ? 1.16 : 1) * zoom;
      const drawW = (sp.w / sp.h) * drawH;
      const hipRatio = 0.52; // top 52% of the artwork is the torso piece
      const torsoH = drawH * hipRatio;
      const legsH = drawH - torsoH;
      const srcHip = Math.round(sp.h * hipRatio);

      ctx.save();
      ctx.translate(sx, sy - p.bob * zoom + p.dip * zoom * 0.4 + this.shakeY * 0);
      ctx.scale(flip, 1);
      ctx.rotate(p.lean * 0.55 + p.spin * 0.3);

      const alpha = f.dead ? clamp(1 - f.stateT * 0.35, 0, 1) : 1;
      ctx.globalAlpha = alpha;

      // dash afterimages
      f.ghosts.forEach((gh) => {
        const gx = (gh.x - f.x) * zoom * flip;
        ctx.globalAlpha = (gh.life / gh.max) * 0.35 * alpha;
        ctx.drawImage(sp.white, -drawW / 2 + gx, -drawH, drawW, drawH);
      });
      ctx.globalAlpha = alpha;

      // element rim: a soft coloured silhouette behind the art
      ctx.globalAlpha = alpha * (f.shield > 0 || f.empower > 0 ? 0.5 : 0.24);
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(tintedGlowSprite(sp, f.shield > 0 ? "#7fd8ff" : f.kit.color), -drawW / 2 - 5, -drawH - 5, drawW + 10, drawH + 10);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = alpha;

      const legScale = p.squash;
      // legs piece
      ctx.save();
      ctx.translate(0, 0);
      ctx.scale(1, legScale);
      ctx.drawImage(sp.base, 0, srcHip, sp.w, sp.h - srcHip, -drawW / 2, -legsH, drawW, legsH);
      if (f.flash > 0.02) {
        ctx.globalAlpha = alpha * f.flash;
        ctx.drawImage(sp.white, 0, srcHip, sp.w, sp.h - srcHip, -drawW / 2, -legsH, drawW, legsH);
        ctx.globalAlpha = alpha;
      }
      ctx.restore();

      // torso piece — rotates at the hip, breathes, and reaches into attacks
      ctx.save();
      ctx.translate(0, -legsH * legScale);
      ctx.rotate(p.torso);
      ctx.translate(p.reach * 12 * zoom * 0.4, 0);
      ctx.scale(1, p.breath);
      ctx.drawImage(sp.base, 0, 0, sp.w, srcHip, -drawW / 2, -torsoH, drawW, torsoH);
      if (f.flash > 0.02) {
        ctx.globalAlpha = alpha * f.flash;
        ctx.drawImage(sp.white, 0, 0, sp.w, srcHip, -drawW / 2, -torsoH, drawW, torsoH);
        ctx.globalAlpha = alpha;
      }
      ctx.restore();

      // frozen shell
      if (f.freeze > 0) {
        ctx.globalAlpha = 0.35 * alpha;
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(tintedGlowSprite(sp, "#7fd8ff"), -drawW / 2, -drawH, drawW, drawH);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();

      // weapon arc drawn in front of the fighter during active frames
      if ((f.state === "attack" || f.state === "ability") && f.phase === "active" && f.attack?.type !== "magic" && f.attack?.type !== "buff") {
        const reach = (f.attack.range || f.stats.range) * zoom;
        const [ax, ay] = this.project(f.x + f.facing * reach * 0.45, f.y + FIGHTER_H * 0.55);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.scale(f.facing, 1);
        ctx.rotate(-0.3);
        const prog = clamp((f.stateT - f.attack.windup) / (f.attack.active || 0.12), 0, 1);
        ctx.globalAlpha = 0.85 * (1 - prog);
        ctx.strokeStyle = f.kit.glow;
        ctx.lineWidth = 12 * zoom * (1 - prog * 0.5);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(0, 0, reach * 0.55, -1.1 + prog * 1.2, 0.5 + prog * 1.2);
        ctx.stroke();
        ctx.restore();
      }

      if (f.burn > 0 && Math.random() < 0.35) this.particles(f, 1, "#ff8a3c", 0.5);
    }

    drawGroundFx(ctx) {
      for (let i = 0; i < this.fx.length; i += 1) {
        const p = this.fx[i];
        if (p.type !== "ring") continue;
        const [sx, sy] = this.project(p.x, p.y);
        const a = clamp(p.life / p.max, 0, 1);
        ctx.save();
        ctx.globalAlpha = a * 0.9;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3 * a + 1;
        ctx.beginPath();
        ctx.ellipse(sx, sy, p.size * this.cam.zoom, p.size * 0.4 * this.cam.zoom, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawShots(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      this.shots.forEach((s) => {
        const glow = tintedGlow(s.owner.kit.color);
        const core = tintedGlow(s.owner.kit.glow);
        for (let i = 0; i < s.trail.length; i += 1) {
          const [tx, ty] = this.project(s.trail[i], s.y);
          const size = (i / s.trail.length) * 34 * this.cam.zoom;
          ctx.globalAlpha = (i / s.trail.length) * 0.5;
          ctx.drawImage(glow, tx - size / 2, ty - size / 2, size, size);
        }
        const [sx, sy] = this.project(s.x, s.y);
        const size = 54 * this.cam.zoom;
        ctx.globalAlpha = 0.95;
        ctx.drawImage(glow, sx - size / 2, sy - size / 2, size, size);
        ctx.globalAlpha = 1;
        ctx.drawImage(core, sx - size / 4, sy - size / 4, size / 2, size / 2);
      });
      ctx.restore();
    }

    drawAirFx(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < this.fx.length; i += 1) {
        const p = this.fx[i];
        if (p.type === "ring") continue;
        const [sx, sy] = this.project(p.x, p.y);
        const a = clamp(p.life / p.max, 0, 1);
        ctx.globalAlpha = a;
        if (p.type === "slash") {
          ctx.globalCompositeOperation = "source-over";
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(p.rot);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 7 * a;
          ctx.beginPath();
          ctx.arc(0, 0, p.size * this.cam.zoom, -0.9, 0.9);
          ctx.stroke();
          ctx.restore();
          ctx.globalCompositeOperation = "lighter";
        } else {
          const size = (p.size || 12) * (p.type === "flash" ? 1 : a + 0.4) * this.cam.zoom;
          ctx.drawImage(tintedGlow(p.color), sx - size / 2, sy - size / 2, size, size);
        }
      }
      ctx.restore();
    }

    drawNumbers(ctx) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      this.numbers.forEach((n) => {
        const [sx, sy] = this.project(n.x, n.y);
        ctx.globalAlpha = clamp(n.life, 0, 1);
        ctx.font = `900 ${(n.crit ? 32 : 23) * this.cam.zoom}px system-ui, sans-serif`;
        ctx.strokeText(n.text, sx, sy);
        ctx.fillStyle = n.color;
        ctx.fillText(n.text, sx, sy);
      });
      ctx.restore();
    }

    drawEndBanner(ctx) {
      const win = !this.player.dead;
      const a = clamp(this.endT / 0.35, 0, 1);
      ctx.save();
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = "#04050e";
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.font = `900 ${Math.min(76, this.w * 0.12)}px system-ui, sans-serif`;
      ctx.fillStyle = win ? "#ffd479" : "#ff5f6d";
      ctx.fillText(win ? "K.O.!" : "DEFEAT", this.w / 2, this.h / 2);
      ctx.font = "600 14px system-ui";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(win ? "Chapter cleared" : "You wake at camp, fully healed", this.w / 2, this.h / 2 + 30);
      ctx.restore();
    }
  }

  /* coloured silhouette cache, per sprite + colour */
  const silhouettes = new Map();
  function tintedGlowSprite(sp, color) {
    const key = `${sp.w}x${sp.h}:${color}`;
    let c = silhouettes.get(key);
    if (c) return c;
    c = makeCanvas(sp.w, sp.h);
    const g = c.getContext("2d");
    g.drawImage(sp.white, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, sp.w, sp.h);
    silhouettes.set(key, c);
    return c;
  }

  window.ChronicleArena = {
    Arena, KITS, kitFor,
    setMuted: (v) => { Audio2.muted = v; if (!v) Audio2.ready(); },
    unlockAudio: () => Audio2.ready(),
  };
})();
