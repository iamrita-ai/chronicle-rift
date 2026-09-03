/* ChronicleRift — Arena v5
 * A real-time, landscape fighting engine with Shadow-Fight-style fighters.
 *
 * Every fighter is a fully articulated rig drawn layer by layer with real
 * volume — head + hair, chest plate, pauldrons, two-bone arms with fists,
 * two-bone legs with feet, a flowing cape and a weapon welded to the hand
 * (sword, spear + shield, twin sabers, grimoire or scythe; monsters get
 * claws, horns, tails and stone gauntlets). Nothing is a flat picture: legs
 * march with heel-lifts, arms swing from the shoulder, the chest breathes,
 * body weight shifts, and the weapon keeps moving while you idle.
 *
 * The rig is shared by both renderers: the 2D engine draws it straight to the
 * canvas (crisp at any resolution, always works), the 3D engine billsboards
 * the same animated rig inside a lit Three.js arena. The 2D backdrop reacts
 * to which gate the boss guards — embers, snow, rain, fireflies and petals
 * drift past fog banks with flickering torch light.
 *
 * The simulation runs on a fixed 120 Hz step (rendered every frame) so the
 * fight stays smooth even on phones, and attack inputs are buffered so a tap
 * during recover chains into the next swing instead of being dropped. Heavy
 * hits punch the camera; ultimates slow time and zoom in for one cinematic
 * frame before the explosion lands.
 */
(() => {
  "use strict";

  const ARENA_HALF = 560;
  const GRAVITY = 1800;
  const FIGHTER_H = 116; // world units tall for a 1.0-scale hero
  const HURT_W = 46;
  const POSE_KEYS = [
    "head", "headZ", "torso", "torsoY", "armF", "armFE", "handF",
    "armB", "armBE", "handB", "legF", "legFK", "footF",
    "legB", "legBK", "footB", "bob", "rot", "dip", "breath", "glow", "crouch",
  ];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const approach = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  /* ================================================================== *\
   * skins — shared by the 2D and 3D renderers
   * ================================================================== */
  const SKINS = {
    fire: {
      armor: "#7a4229", armorHi: "#c07a41", armorLo: "#2e150f", cloth: "#a3391b", steel: "#8a7360",
      rim: "#ffb46e", hair: "#3a1207", flesh: "#c98a5e", glow: "#ff7a2a", weapon: "sword",
    },
    ice: {
      armor: "#2f5673", armorHi: "#6f9fc4", armorLo: "#10202c", cloth: "#1d6f92", steel: "#7f95a8",
      rim: "#aee6ff", hair: "#d9f2ff", flesh: "#cfe0ee", glow: "#6fd2ff", weapon: "spear",
    },
    wind: {
      armor: "#33654c", armorHi: "#6fb08a", armorLo: "#132a1f", cloth: "#2f7d55", steel: "#8aa08c",
      rim: "#b6ffcf", hair: "#1d3a28", flesh: "#c9a06e", glow: "#6cff9e", weapon: "sabers",
    },
    arcane: {
      armor: "#463871", armorHi: "#8474c4", armorLo: "#1b1530", cloth: "#5a3f96", steel: "#8d86a8",
      rim: "#cfb6ff", hair: "#241645", flesh: "#d2b8e6", glow: "#a97aff", weapon: "tome",
    },
    shadow: {
      armor: "#4d2747", armorHi: "#96518a", armorLo: "#1c0e1b", cloth: "#7a1f52", steel: "#a2839a",
      rim: "#ff9fd6", hair: "#180a15", flesh: "#b9a8c9", glow: "#ff5ec0", weapon: "scythe",
    },
  };
  const skinFor = (el) => SKINS[el] || SKINS.arcane;

  /* Monster silhouettes — beasts run lower on clawed paws, brutes tower in
     stone plates. The rig picks a body plan from `build`. */
  const BODIES = {
    hero:  { torso: 1.0, shoulder: 0.98, hip: 1.0, leg: 1.0, arm: 1.0, head: 1.0, hunch: 0.02, horn: 0, tail: 0, claws: 0 },
    beast: { torso: 0.92, shoulder: 0.86, hip: 0.94, leg: 0.88, arm: 0.9, head: 1.06, hunch: 0.16, horn: 1, tail: 1, claws: 1 },
    brute: { torso: 1.22, shoulder: 1.24, hip: 1.02, leg: 0.92, arm: 1.16, head: 0.86, hunch: 0.08, horn: 1, tail: 0, claws: 0 },
  };

  /* angle convention: 0 points straight down, positive swings forward (+x) */
  function jointAt(p, ang, len) {
    return { x: p.x + Math.sin(ang) * len, y: p.y + Math.cos(ang) * len };
  }

  /* ================================================================== *\
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

  /* ================================================================== *\
   * kits
   * ================================================================== */
  const KITS = {
    fire: {
      color: "#ff8a3c", glow: "#ffd479", scene: "bg-ember",
      basic: { name: "Ember Slash", mul: 1.0, range: 104, knock: 130, type: "slash", stamina: 9 },
      abilities: [
        { id: "a1", name: "Molten Cleave", icon: "icon-fire-1", cd: 6, stamina: 26, type: "heavy",
          mul: 2.35, range: 124, knock: 470, lift: 210, windup: 0.26, active: 0.14, recover: 0.3,
          shake: 16, desc: "Overhead cleave, huge knockback" },
        { id: "a2", name: "Cinder Wave", icon: "icon-fire-2", cd: 8, stamina: 22, type: "magic",
          mul: 1.55, speed: 540, burn: 4, windup: 0.22, recover: 0.26, shake: 8,
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
          mul: 2.5, range: 118, knock: 430, lift: 170, windup: 0.3, active: 0.14, recover: 0.32,
          shake: 18, slow: 2.5, desc: "Ground-shattering smash that slows" },
        { id: "a2", name: "Deep Freeze", icon: "icon-ice-2", cd: 10, stamina: 24, type: "magic",
          mul: 1.25, speed: 450, freeze: 1.4, windup: 0.25, recover: 0.27, shake: 6,
          desc: "Freezes the enemy solid" },
        { id: "a3", name: "Frost Barrier", icon: "icon-ice-3", cd: 12, stamina: 20, type: "buff",
          shield: 0.55, buffTime: 5, windup: 0.18, recover: 0.24, desc: "Halves incoming damage for 5s" },
      ],
    },
    wind: {
      color: "#8ef0a8", glow: "#dcffe8", scene: "bg-arcane",
      basic: { name: "Twin Slice", mul: 0.85, range: 98, knock: 100, type: "slash", stamina: 7, hits: 2 },
      abilities: [
        { id: "a1", name: "Cyclone Kick", icon: "icon-wind-1", cd: 5.5, stamina: 24, type: "heavy",
          mul: 0.95, hits: 3, range: 112, knock: 270, lift: 120, windup: 0.17, active: 0.34,
          recover: 0.24, shake: 10, desc: "Spinning three-hit whirl" },
        { id: "a2", name: "Gale Flurry", icon: "icon-wind-2", cd: 7.5, stamina: 21, type: "magic",
          mul: 0.75, volley: 3, speed: 720, windup: 0.15, recover: 0.22, shake: 5, desc: "Three razor gusts" },
        { id: "a3", name: "Blink", icon: "icon-wind-3", cd: 6, stamina: 14, type: "blink",
          iframes: 0.35, hasteTime: 4, haste: 1.5, desc: "Teleport behind the enemy, +50% speed" },
      ],
    },
    arcane: {
      color: "#b48bff", glow: "#e8dcff", scene: "bg-arcane",
      basic: { name: "Rune Bolt", mul: 1.05, range: 108, knock: 120, type: "slash", stamina: 9 },
      abilities: [
        { id: "a1", name: "Sigil Burst", icon: "icon-arcane-1", cd: 7, stamina: 27, type: "heavy",
          mul: 2.15, range: 138, knock: 390, lift: 190, windup: 0.27, active: 0.16, recover: 0.32,
          shake: 15, desc: "Detonates a sigil around you" },
        { id: "a2", name: "Mind Siphon", icon: "icon-arcane-2", cd: 8.5, stamina: 23, type: "magic",
          mul: 1.6, speed: 490, lifesteal: 0.5, pierceDef: true, windup: 0.23, recover: 0.27,
          shake: 7, desc: "Unblockable bolt, heals 50%" },
        { id: "a3", name: "Rune Ward", icon: "icon-arcane-3", cd: 11, stamina: 18, type: "buff",
          shield: 0.62, buffTime: 4.5, regen: 22, windup: 0.18, recover: 0.22, desc: "Ward + fast stamina regen" },
      ],
    },
    shadow: {
      color: "#ff6ac1", glow: "#ffd6f0", scene: "bg-void",
      basic: { name: "Reap", mul: 1.1, range: 112, knock: 130, type: "slash", stamina: 10 },
      abilities: [
        { id: "a1", name: "Grave Arc", icon: "icon-shadow-1", cd: 6.5, stamina: 29, type: "heavy",
          mul: 2.45, range: 142, knock: 440, lift: 180, windup: 0.27, active: 0.16, recover: 0.32,
          shake: 17, desc: "Wide reaping arc" },
        { id: "a2", name: "Soul Harvest", icon: "icon-shadow-2", cd: 9, stamina: 25, type: "magic",
          mul: 1.7, speed: 480, lifesteal: 0.4, slow: 2, windup: 0.24, recover: 0.27, shake: 9,
          desc: "Drains life and slows" },
        { id: "a3", name: "Shadowstep", icon: "icon-shadow-3", cd: 8, stamina: 16, type: "blink",
          iframes: 0.45, empower: 1.9, empowerTime: 5, desc: "Vanish, reappear behind, next hit empowered" },
      ],
    },
  };
  const kitFor = (element) => KITS[element] || KITS.fire;

  /* ================================================================== *\
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
      this.staminaRegenMul = (cfg.stats && cfg.stats.staminaRegenMul) || 1;
      this.artFacing = cfg.artFacing || 1; // which way the artwork looks
      this.art = cfg.art || null; // official key art used as the fighter sprite
      this.scale = cfg.scale || 1; // heroes 1.0, monsters larger, bosses largest
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
      this.squash = 0; // landing squash-and-stretch
      this.roar = 0; // heavy-weapon ignition glow, decays in stepFighter
      this.trail = [];
      this.wasAir = false;
      // skeletal pose (radians; bob/dip in world units, breath as a scale)
      this.pose = {};
      this.target = {};
      for (const key of POSE_KEYS) { this.pose[key] = 0; this.target[key] = 0; }
      this.pose.breath = 1;
      this.target.breath = 1;
      this.skin = skinFor(cfg.element);
      this.body = BODIES[cfg.build] || BODIES.hero;
      this.weapon = (BODIES[cfg.build] || BODIES.hero).claws ? "claws" : (this.skin.weapon || "sword");
      // verlet cloth: cape anchors at the neck, hair at the crown — each is a
      // small chain of points that lag behind the body for secondary motion
      this.cape = [];
      this.hair = [];
      for (let i = 0; i < 5; i += 1) this.cape.push({ x: 0, y: 0, px: 0, py: 0, init: false });
      for (let i = 0; i < 3; i += 1) this.hair.push({ x: 0, y: 0, px: 0, py: 0, init: false });
    }

    get busy() {
      return ["attack", "ability", "dash", "hurt", "knock"].includes(this.state) || this.dead;
    }

    hurtbox() {
      const w = HURT_W * this.scale;
      const h = FIGHTER_H * this.scale;
      return { x: this.x - w / 2, w, y0: this.y, y1: this.y + h };
    }
  }

  /* ================================================================== *\
   * 3D renderer (Three.js) — low-poly jointed puppets, GPU particles
   * ================================================================== */
  const ENV3D = {
    "bg-ember":    { sky: 0x201009, fog: 0x150b07, ground: 0x181009, accent: 0xff8a3c, mote: 0xffb066, hemiSky: 0xffb27a, moteVy: 14, rain: 0 },
    "bg-frost":    { sky: 0x0a1522, fog: 0x08111c, ground: 0x0d1622, accent: 0x7fd8ff, mote: 0xbfeaff, hemiSky: 0x9fd4ff, moteVy: -26, rain: 0 },
    "bg-arcane":   { sky: 0x130d24, fog: 0x0e091a, ground: 0x131020, accent: 0xb48bff, mote: 0xd0b8ff, hemiSky: 0xb9a4ff, moteVy: -8, rain: 0 },
    "bg-void":     { sky: 0x170a1c, fog: 0x0f0714, ground: 0x130b16, accent: 0xff6ac1, mote: 0xffa8d8, hemiSky: 0xd89adf, moteVy: 2, rain: 0 },
    "bg-colossus": { sky: 0x120a12, fog: 0x0b060d, ground: 0x120d14, accent: 0xff4d5e, mote: 0xff9a86, hemiSky: 0xa6789f, moteVy: -4, rain: 1 },
  };

  class Renderer3D {
    constructor(arena) {
      this.a = arena;
      const T = window.THREE;
      const canvas = arena.canvas;

      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      this.renderer = new T.WebGLRenderer({
        canvas,
        antialias: dpr <= 1.5,
        powerPreference: "high-performance",
      });
      this.renderer.setPixelRatio(dpr);
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.12;

      this.scene = new T.Scene();
      this.scene.background = new T.Color(0x150b07);
      this.scene.fog = new T.Fog(0x150b07, 620, 2000);

      this.camera = new T.PerspectiveCamera(42, 16 / 9, 1, 5000);
      this.cam = { x: 0, dist: 780, y: 96 };

      // lights
      this.hemi = new T.HemisphereLight(0xffb27a, 0x0a0a12, 0.75);
      this.key = new T.DirectionalLight(0xfff0dd, 1.25);
      this.key.position.set(220, 380, 320);
      this.fill = new T.DirectionalLight(0x88aaff, 0.3);
      this.fill.position.set(-260, 140, -180);
      this.accentLight = new T.PointLight(0xff8a3c, 2.2, 1100, 1.7);
      this.accentLight.position.set(0, 90, 160);
      this.scene.add(this.hemi, this.key, this.fill, this.accentLight);

      // textures
      this.glowTex = this.makeGlowTexture();
      this.blobTex = this.makeBlobTexture();

      // environment
      this.buildEnv();

      // fx pools
      this.particles = this.makeParticles(240);
      this.ringPool = [];
      this.flashPool = [];
      this.arcPool = [];
      this.ghostPool = [];
      this.shotPool = [];
      for (let i = 0; i < 8; i += 1) this.ringPool.push(this.makeRing());
      for (let i = 0; i < 8; i += 1) this.flashPool.push(this.makeFlash());
      for (let i = 0; i < 6; i += 1) this.arcPool.push(this.makeArc());
      for (let i = 0; i < 6; i += 1) this.ghostPool.push(this.makeGhost());
      for (let i = 0; i < 6; i += 1) this.shotPool.push(this.makeShot());

      // compile every material/shader up front so the first swing never
      // hitches on a shader-compile stall (the classic "lag on attack")
      try { this.renderer.compile(this.scene, this.camera); } catch (_) { /* older three */ }

      // DOM overlay for damage numbers and the K.O. banner
      this.dom = document.getElementById("arena-fx-host");
      if (!this.dom) {
        this.dom = document.createElement("div");
        this.dom.id = "arena-fx-host";
        this.dom.className = "arena-fx-host";
        if (canvas.parentNode) canvas.parentNode.appendChild(this.dom);
      }
      this.numEls = new Map();
      this.banner = null;

      this.rigs = new Map();
      this.sceneName = null;
      this.tmp = new T.Vector3();
      this.dprCap = 1.75;
      this.frameEma = 16.7;
      this.frameHot = 0;
      this.renderFails = 0;
      this.contextLost = false;
      this.lostCount = 0;

      // A GPU can drop the context (driver reset, memory pressure). Prevent
      // the default loss so the browser can restore it; if it keeps dying,
      // the arena falls back to the 2D renderer instead of going black.
      canvas.addEventListener(
        "webglcontextlost",
        (e) => {
          e.preventDefault();
          this.contextLost = true;
          this.lostCount += 1;
          if (this.lostCount >= 2) this.a.swapTo2D();
        },
        false
      );
      canvas.addEventListener(
        "webglcontextrestored",
        () => { this.contextLost = false; },
        false
      );
      this.charge = new WeakMap();
      this.chargeSprites = [];
      this.trailArc = new WeakMap();
      this.trailArcs = [];
    }

    /* ---------------- textures ---------------- */
    makeGlowTexture() {
      const size = 64;
      const c = makeCanvas(size, size);
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return new window.THREE.CanvasTexture(c);
    }
    makeBlobTexture() {
      const size = 64;
      const c = makeCanvas(size, size);
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, "rgba(0,0,0,0.85)");
      grad.addColorStop(0.6, "rgba(0,0,0,0.4)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return new window.THREE.CanvasTexture(c);
    }

    /* ---------------- environment ---------------- */
    buildEnv() {
      const T = window.THREE;
      const env = new T.Group();

      // sky dome (gradient painted per scene)
      this.skyMat = new T.MeshBasicMaterial({ side: T.BackSide, fog: false });
      this.sky = new T.Mesh(new T.SphereGeometry(2600, 24, 12), this.skyMat);
      this.scene.add(this.sky);

      // ground disc with painted battle rings
      this.groundMat = new T.MeshStandardMaterial({ roughness: 1, metalness: 0 });
      const ground = new T.Mesh(new T.CircleGeometry(1500, 48), this.groundMat);
      ground.rotation.x = -Math.PI / 2;
      env.add(ground);

      const ringMat = new T.MeshBasicMaterial({
        color: 0xff8a3c, transparent: true, opacity: 0.5, side: T.DoubleSide,
        blending: T.AdditiveBlending, depthWrite: false,
      });
      const ring = new T.Mesh(new T.RingGeometry(150, 168, 72), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.6;
      this.ringMat = ringMat;
      env.add(ring);
      const ring2 = new T.Mesh(new T.RingGeometry(60, 66, 48), ringMat.clone());
      ring2.material.opacity = 0.28;
      ring2.rotation.x = -Math.PI / 2;
      ring2.position.y = 0.6;
      this.ring2Mat = ring2.material;
      env.add(ring2);

      // faint radial grid for depth
      const pts = [];
      for (let i = 0; i < 24; i += 1) {
        const a = (i / 24) * Math.PI * 2;
        pts.push(0, 0, 0, Math.cos(a) * 620, 0, Math.sin(a) * 620);
      }
      for (let r = 130; r <= 620; r += 130) {
        for (let i = 0; i < 64; i += 1) {
          const a0 = (i / 64) * Math.PI * 2;
          const a1 = ((i + 1) / 64) * Math.PI * 2;
          pts.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r);
        }
      }
      const gridGeo = new T.BufferGeometry();
      gridGeo.setAttribute("position", new T.Float32BufferAttribute(pts, 3));
      const grid = new T.LineSegments(
        gridGeo,
        new T.LineBasicMaterial({ color: 0x3a4062, transparent: true, opacity: 0.28 })
      );
      grid.position.y = 0.3;
      env.add(grid);

      // standing rune pillars ringing the arena
      this.stoneMat = new T.MeshStandardMaterial({ color: 0x262c48, roughness: 0.85, metalness: 0.1 });
      this.pillarGlowMat = new T.MeshBasicMaterial({ color: 0xff8a3c });
      this.pillarGroup = new T.Group();
      for (let i = 0; i < 10; i += 1) {
        const a = (i / 10) * Math.PI * 2;
        const slab = new T.Mesh(new T.BoxGeometry(14, rand(46, 64), 5), this.stoneMat);
        slab.position.set(Math.cos(a) * 430, 26, Math.sin(a) * 430);
        slab.rotation.y = -a + Math.PI / 2;
        slab.rotation.x = rand(-0.05, 0.05);
        const glyph = new T.Mesh(new T.BoxGeometry(7, 38, 2), this.pillarGlowMat);
        glyph.position.set(0, 2, 3);
        slab.add(glyph);
        this.pillarGroup.add(slab);
      }
      env.add(this.pillarGroup);

      // floating rift rocks, slowly orbiting the arena
      this.rockMat = new T.MeshStandardMaterial({ color: 0x1c2340, roughness: 1 });
      this.rockList = [];
      for (let i = 0; i < 9; i += 1) {
        const m = new T.Mesh(new T.IcosahedronGeometry(rand(16, 46), 0), this.rockMat);
        this.rockList.push({
          m, r: rand(400, 900), a: rand(0, Math.PI * 2), y: rand(120, 440),
          sp: rand(0.02, 0.08) * (Math.random() < 0.5 ? -1 : 1),
          wob: rand(0, 6), amp: rand(8, 30),
        });
        env.add(m);
      }

      // twin braziers with live firelight
      this.brazierMat = new T.MeshBasicMaterial({ color: 0xffb066 });
      this.braziers = [];
      [[-470, -170], [470, -170]].forEach(([x, z]) => {
        const stand = new T.Mesh(new T.CylinderGeometry(6, 13, 74, 8), this.stoneMat);
        stand.position.set(x, 37, z);
        env.add(stand);
        const flame = new T.Mesh(new T.SphereGeometry(13, 10, 8), this.brazierMat);
        flame.position.set(x, 82, z);
        env.add(flame);
        const light = new T.PointLight(0xffb066, 1.1, 760, 1.8);
        light.position.set(x, 100, z);
        this.scene.add(light);
        this.braziers.push({ light, flame });
      });

      // distant monoliths and peaks (parallax silhouettes)
      for (let i = 0; i < 9; i += 1) {
        const a = rand(0, Math.PI * 2);
        const r = rand(1050, 1600);
        const w = rand(34, 90);
        const h = rand(180, 460);
        const rock = new T.Mesh(new T.BoxGeometry(w, h, w * 0.7), this.stoneMat);
        rock.position.set(Math.cos(a) * r, h / 2 - 8, Math.sin(a) * r);
        rock.rotation.y = rand(0, Math.PI);
        env.add(rock);
      }
      for (let i = 0; i < 6; i += 1) {
        const a = rand(0, Math.PI * 2);
        const r = rand(1700, 2300);
        const h = rand(380, 720);
        const peak = new T.Mesh(new T.ConeGeometry(rand(180, 340), h, 5), this.stoneMat);
        peak.position.set(Math.cos(a) * r, h / 2 - 30, Math.sin(a) * r);
        env.add(peak);
      }

      // drifting ambient motes (embers rise, snow falls, fireflies blink)
      const COUNT = 130;
      const pos = new Float32Array(COUNT * 3);
      this.moteData = [];
      for (let i = 0; i < COUNT; i += 1) {
        const x = rand(-760, 760);
        const y = rand(0, 340);
        const z = rand(-520, 260);
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        this.moteData.push({ vy: rand(6, 26), ph: rand(0, Math.PI * 2) });
      }
      // rain streaks (activated by the Colossus Gate scene)
      {
        const R = 260;
        const rp = new Float32Array(R * 6);
        this.rainData = [];
        for (let i = 0; i < R; i += 1) {
          const x = rand(-900, 900); const y = rand(0, 520); const z = rand(-460, 260);
          rp[i * 6] = x; rp[i * 6 + 1] = y; rp[i * 6 + 2] = z;
          rp[i * 6 + 3] = x + 5; rp[i * 6 + 4] = y - 26; rp[i * 6 + 5] = z;
          this.rainData.push({ x, y, z });
        }
        const rg = new T.BufferGeometry();
        rg.setAttribute("position", new T.BufferAttribute(rp, 3));
        this.rainMat = new T.LineBasicMaterial({ color: 0x9fb8ff, transparent: true, opacity: 0 });
        this.rain = new T.LineSegments(rg, this.rainMat);
        this.rain.frustumCulled = false;
        env.add(this.rain);
      }
      const moteGeo = new T.BufferGeometry();
      moteGeo.setAttribute("position", new T.BufferAttribute(pos, 3));
      const moteMat = new T.PointsMaterial({
        size: 9, map: this.glowTex, color: 0xffb066, transparent: true, opacity: 0.55,
        blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      });
      this.moteMat = moteMat;
      this.moteGeo = moteGeo;
      env.add(new T.Points(moteGeo, moteMat));

      this.envGroup = env;
      this.scene.add(env);
    }

    /* painted sky gradient — the dome reads as atmosphere, not flat colour */
    makeSkyTexture(env) {
      const c = makeCanvas(64, 512);
      const g = c.getContext("2d");
      const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
      const top = hex(env.sky);
      const fog = hex(env.fog);
      const glowC = hex(env.hemiSky);
      const grad = g.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0, "#04050c");
      grad.addColorStop(0.34, top);
      grad.addColorStop(0.5, glowC);
      grad.addColorStop(0.58, fog);
      grad.addColorStop(1, "#05060d");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 512);
      // stars in the upper sky
      for (let i = 0; i < 90; i += 1) {
        const y = Math.pow(Math.random(), 1.4) * 200;
        g.fillStyle = `rgba(255,255,255,${rand(0.1, 0.55)})`;
        g.fillRect(Math.random() * 64, y, 1.3, 1.3);
      }
      const tex = new window.THREE.CanvasTexture(c);
      return tex;
    }

    /* painted arena floor — rings, spokes and an elemental glow circle */
    makeGroundTexture(env) {
      const c = makeCanvas(512, 512);
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(256, 256, 20, 256, 256, 256);
      grad.addColorStop(0, "#414762");
      grad.addColorStop(0.5, "#272c41");
      grad.addColorStop(1, "#0b0d17");
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 512);
      g.strokeStyle = "rgba(255,255,255,0.14)";
      [70, 128, 196, 246].forEach((r, i) => {
        g.lineWidth = i === 2 ? 3 : 1.4;
        g.beginPath();
        g.arc(256, 256, r, 0, Math.PI * 2);
        g.stroke();
      });
      g.strokeStyle = "rgba(255,255,255,0.06)";
      for (let i = 0; i < 24; i += 1) {
        const a = (i / 24) * Math.PI * 2;
        g.beginPath();
        g.moveTo(256 + Math.cos(a) * 42, 256 + Math.sin(a) * 42);
        g.lineTo(256 + Math.cos(a) * 250, 256 + Math.sin(a) * 250);
        g.stroke();
      }
      const acc = `#${env.accent.toString(16).padStart(6, "0")}`;
      g.strokeStyle = acc;
      g.globalAlpha = 0.5;
      g.lineWidth = 4;
      g.beginPath(); g.arc(256, 256, 152, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 0.2;
      g.lineWidth = 12;
      g.beginPath(); g.arc(256, 256, 162, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
      for (let i = 0; i < 900; i += 1) {
        g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
        g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
      }
      return new window.THREE.CanvasTexture(c);
    }

    setScene(name) {
      if (this.sceneName === name) return;
      this.sceneName = name;
      const env = ENV3D[name] || ENV3D["bg-ember"];
      this.moteVy = env.moteVy || 14;
      this.moteBlink = name === "bg-void";
      if (this.rainMat) this.rainMat.opacity = env.rain ? 0.34 : 0;
      this.scene.background = new window.THREE.Color(env.sky);
      this.scene.fog.color.set(env.fog);
      if (this.skyMat.map) this.skyMat.map.dispose();
      this.skyMat.map = this.makeSkyTexture(env);
      this.skyMat.needsUpdate = true;
      if (this.groundMat.map) this.groundMat.map.dispose();
      this.groundMat.map = this.makeGroundTexture(env);
      this.groundMat.color.set(0xffffff);
      this.groundMat.needsUpdate = true;
      this.ringMat.color.set(env.accent);
      this.ring2Mat.color.set(env.accent);
      this.accentLight.color.set(env.accent);
      this.moteMat.color.set(env.mote);
      this.hemi.color.set(env.hemiSky);
      this.pillarGlowMat.color.set(env.accent);
      this.brazierMat.color.set(env.mote);
      this.braziers.forEach((b) => b.light.color.set(env.mote));
    }

    /* living environment: orbiting rocks, flickering braziers, pulsing runes */
    stepEnv(dt, t) {
      const d = dt || 1 / 60;
      this.pillarGroup.rotation.y += d * 0.02;
      // gate ambience: the Colossus Gate hurls rain, others drift motes only
      const envDef = ENV3D[this.sceneName] || ENV3D["bg-ember"];
      if (envDef.rain && this.rain) {
        const rp = this.rain.geometry.attributes.position.array;
        for (let i = 0; i < this.rainData.length; i += 1) {
          const r = this.rainData[i];
          r.y -= 1250 * d;
          r.x += 190 * d;
          if (r.y < -10) { r.y = rand(420, 620); r.x = rand(-1000, 700); }
          if (r.x > 950) r.x -= 1900;
          rp[i * 6] = r.x; rp[i * 6 + 1] = r.y; rp[i * 6 + 2] = r.z;
          rp[i * 6 + 3] = r.x + 5; rp[i * 6 + 4] = r.y - 26; rp[i * 6 + 5] = r.z;
        }
        this.rain.geometry.attributes.position.needsUpdate = true;
      }
      for (let i = 0; i < this.rockList.length; i += 1) {
        const r = this.rockList[i];
        r.a += r.sp * d * 2;
        r.m.position.set(Math.cos(r.a) * r.r, r.y + Math.sin(t * 0.5 + r.wob) * r.amp, Math.sin(r.a) * r.r);
        r.m.rotation.y += d * 0.1;
      }
      for (let i = 0; i < this.braziers.length; i += 1) {
        const b = this.braziers[i];
        b.light.intensity = 1.0 + Math.sin(t * 11 + i * 2.4) * 0.28 + Math.random() * 0.12;
        const s = 1 + Math.sin(t * 9 + i) * 0.12;
        b.flame.scale.set(s, 1.25 - s * 0.15, s);
      }
      const pulse = 0.42 + Math.sin(t * 2.2) * 0.14;
      this.ringMat.opacity = pulse;
      this.ring2Mat.opacity = pulse * 0.55;
    }

    /* ---------------- fx pools ---------------- */
    makeParticles(count) {
      const T = window.THREE;
      const geo = new T.BufferGeometry();
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) pos[i * 3 + 1] = -9999;
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      geo.setAttribute("color", new T.BufferAttribute(col, 3));
      const mat = new T.PointsMaterial({
        size: 17, map: this.glowTex, vertexColors: true, transparent: true,
        blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      });
      const points = new T.Points(geo, mat);
      points.frustumCulled = false;
      this.scene.add(points);
      const slots = new Array(count).fill(null);
      const c = new T.Color();
      return {
        geo, slots, count,
        spawn(x, y, color, vx, vy, life) {
          let slot = -1;
          for (let i = 0; i < count; i += 1) {
            if (!slots[i]) { slot = i; break; }
          }
          if (slot < 0) return;
          c.set(color);
          slots[slot] = { x, y, z: 0, vx, vy, life, max: life };
          pos[slot * 3] = x;
          pos[slot * 3 + 1] = y;
          pos[slot * 3 + 2] = 0;
          col[slot * 3] = c.r;
          col[slot * 3 + 1] = c.g;
          col[slot * 3 + 2] = c.b;
        },
      };
    }

    stepParticles(dt) {
      const { slots, geo, count } = this.particles;
      const pos = geo.attributes.position.array;
      const col = geo.attributes.color.array;
      for (let i = 0; i < count; i += 1) {
        const s = slots[i];
        if (!s) continue;
        s.life -= dt;
        if (s.life <= 0) {
          slots[i] = null;
          pos[i * 3 + 1] = -9999;
          continue;
        }
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy -= 950 * dt;
        if (s.y < 1) { s.y = 1; s.vy *= -0.3; s.vx *= 0.7; }
        pos[i * 3] = s.x;
        pos[i * 3 + 1] = s.y;
        col[i * 3] *= 0.995;
        col[i * 3 + 1] *= 0.995;
        col[i * 3 + 2] *= 0.995;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    }

    makeRing() {
      const T = window.THREE;
      const m = new T.Mesh(
        new T.RingGeometry(0.72, 1, 48),
        new T.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide,
          blending: T.AdditiveBlending, depthWrite: false,
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      return { m, life: 0, max: 1, size: 10, grow: 0, active: false };
    }
    fireRing(x, y, color, size, grow, life) {
      for (let i = 0; i < this.ringPool.length; i += 1) {
        const r = this.ringPool[i];
        if (!r.active) {
          r.active = true;
          r.life = life; r.max = life; r.size = size; r.grow = grow;
          r.m.position.set(x, 0.8, 0);
          r.m.material.color.set(color);
          r.m.visible = true;
          return;
        }
      }
    }

    makeFlash() {
      const T = window.THREE;
      const s = new T.Sprite(
        new T.SpriteMaterial({
          map: this.glowTex, color: 0xffffff, transparent: true, opacity: 0,
          blending: T.AdditiveBlending, depthWrite: false,
        })
      );
      s.visible = false;
      this.scene.add(s);
      return { s, life: 0, max: 1, size: 30, active: false };
    }
    fireFlash(x, y, color, size, life) {
      for (let i = 0; i < this.flashPool.length; i += 1) {
        const f = this.flashPool[i];
        if (!f.active) {
          f.active = true;
          f.life = life; f.max = life; f.size = size;
          f.s.position.set(x, y, 0);
          f.s.material.color.set(color);
          f.s.visible = true;
          return;
        }
      }
    }

    makeArc() {
      const T = window.THREE;
      const m = new T.Mesh(
        new T.RingGeometry(0.52, 0.78, 28, 1, 0, 1.5),
        new T.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide,
          blending: T.AdditiveBlending, depthWrite: false,
        })
      );
      m.visible = false;
      this.scene.add(m);
      return { m, life: 0, max: 1, size: 40, rot: 0, spin: 0, active: false };
    }
    fireArc(x, y, color, size, life, rot) {
      for (let i = 0; i < this.arcPool.length; i += 1) {
        const a = this.arcPool[i];
        if (!a.active) {
          a.active = true;
          a.life = life; a.max = life; a.size = size; a.rot = rot; a.spin = rand(-3, 3);
          a.m.position.set(x, y, 20);
          a.m.material.color.set(color);
          a.m.visible = true;
          return;
        }
      }
    }

    /* cached elemental-silhouette texture of a fighter's key art */
    tintTex(entry, color) {
      const canvas = entry.tint(color);
      if (!canvas) return null;
      if (!entry._tex3d) entry._tex3d = new Map();
      let tex = entry._tex3d.get(color);
      if (!tex) {
        tex = new window.THREE.CanvasTexture(canvas);
        entry._tex3d.set(color, tex);
      }
      return tex;
    }

    makeGhost() {
      const T = window.THREE;
      const m = new T.Mesh(
        new T.PlaneGeometry(1, 1),
        new T.MeshBasicMaterial({
          transparent: true, opacity: 0, blending: T.AdditiveBlending,
          depthWrite: false, toneMapped: false,
        })
      );
      m.visible = false;
      this.scene.add(m);
      return { m, life: 0, max: 1, active: false };
    }
    fireGhost(f, gh, size) {
      const entry = loadFighterArt(f.art);
      if (!entry.ready) return;
      const tex = this.tintTex(entry, f.kit.color);
      if (!tex) return;
      for (let i = 0; i < this.ghostPool.length; i += 1) {
        const g = this.ghostPool[i];
        if (!g.active) {
          g.active = true;
          g.life = gh.life; g.max = gh.max;
          const aspect = entry.img.width / entry.img.height;
          const ph = size * 1.22;
          g.m.position.set(gh.x, size * 0.5, 0);
          g.m.scale.set(ph * aspect, ph, 1);
          g.m.material.map = tex;
          g.m.material.color.set(0xffffff);
          g.m.visible = true;
          return;
        }
      }
    }
    /* A travelling projectile: bright core + soft elemental halo. */
    makeShot() {
      const T = window.THREE;
      const core = new T.Mesh(
        new T.CircleGeometry(7, 16),
        new T.MeshBasicMaterial({
          color: 0xffffff, transparent: true, blending: T.AdditiveBlending,
          depthWrite: false, toneMapped: false,
        })
      );
      const halo = new T.Mesh(
        new T.CircleGeometry(18, 16),
        new T.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.45,
          blending: T.AdditiveBlending, depthWrite: false, toneMapped: false,
        })
      );
      core.visible = false;
      halo.visible = false;
      this.scene.add(core, halo);
      return { core, halo, active: false, owner: null };
    }

    /* ---------------- fighter rigs — the animated Shadow rig on a lit
     * billboard plane. The SAME articulated skeleton the 2D engine paints
     * (legs marching, elbows swinging, cloth flying, weapon glowing) is
     * rendered to a small canvas every frame and pasted onto a camera-facing
     * plane inside the 3D arena, so limbs truly move in both renderers. */
    buildRig(f) {
      const T = window.THREE;
      const H = FIGHTER_H * f.scale;
      // offscreen canvas: ~2.5 px per world unit keeps the rig crisp when the
      // camera closes in, without wasting fill on weak phones
      const PX = Math.max(160, Math.round(H * 2.5));
      const c = makeCanvas(Math.round(PX * 0.92), PX);
      const rigCtx = c.getContext("2d");
      const tex = new T.CanvasTexture(c);
      if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
      tex.minFilter = T.LinearFilter;
      tex.generateMipmaps = false;

      const root = new T.Group(); // feet pivot in the 3D stage
      const mir = new T.Group();
      const spr = new T.Group();
      root.add(mir);
      mir.add(spr);

      const geo = new T.PlaneGeometry(1, 1);
      const bodyMat = new T.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, alphaTest: 0.02, toneMapped: false,
      });
      const body = new T.Mesh(geo, bodyMat);
      body.position.y = (PX / 2.5) * 0.5;
      body.scale.set((PX * 0.92) / 2.5, PX / 2.5, 1);
      mir.add(body);
      // elemental rim aura behind the rig sells the "living" feel
      const auraMat = new T.SpriteMaterial({
        map: this.glowTex, color: f.kit.color, transparent: true, opacity: 0,
        blending: T.AdditiveBlending, depthWrite: false,
      });
      const aura = new T.Sprite(auraMat);
      aura.position.set(0, H * 0.52, -8);
      aura.scale.set(H * 1.5, H * 1.5, 1);
      spr.add(aura);

      // grounded blob shadow that shrinks as the fighter rises
      const blobGeo = new T.PlaneGeometry(1, 1);
      const blobMat = new T.MeshBasicMaterial({
        map: this.blobTex, transparent: true, opacity: 0.42, depthWrite: false,
      });
      const blob = new T.Mesh(blobGeo, blobMat);
      blob.rotation.x = -Math.PI / 2;
      blob.position.set(0, 0.6, 0);
      this.scene.add(blob);

      // ward bubble
      const wardMat = new T.MeshBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.1, depthWrite: false, side: T.DoubleSide,
      });
      const ward = new T.Mesh(new T.SphereGeometry(0.60 * H, 20, 16), wardMat);
      ward.position.set(0, 0.55 * H, 0);
      ward.visible = false;
      this.scene.add(ward);

      this.scene.add(root);
      const rig = {
        f, H, root, mir, spr, body, bodyMat, aura, auraMat,
        blob, blobMat, ward, wardMat, geo, blobGeo, tex, c, rigCtx, px: PX,
      };
      rig.dispose = () => {
        this.scene.remove(root, blob, ward);
        geo.dispose();
        blobGeo.dispose();
        ward.geometry.dispose();
        tex.dispose();
        [bodyMat, auraMat, blobMat, wardMat].forEach((m) => m.dispose());
      };
      return rig;
    }

    /* Repaint the rig's offscreen canvas and hand it to the GPU. */
    paintRig(rig, dt) {
      const { rigCtx: g, c, px, f } = rig;
      g.clearRect(0, 0, c.width, c.height);
      drawRig(g, f, c.width * 0.52, c.height - 4, px * 0.94, { dt: dt || 1 / 60 });
      rig.tex.needsUpdate = true;
    }

    rigFor(f) {
      let rig = this.rigs.get(f);
      if (!rig) {
        rig = this.buildRig(f);
        this.rigs.set(f, rig);
      }
      return rig;
    }

    disposeRigs() {
      this.rigs.forEach((rig) => rig.dispose());
      this.rigs.clear();
      for (const sp of this.chargeSprites) {
        this.scene.remove(sp);
        sp.material.dispose();
      }
      this.chargeSprites.length = 0;
      for (const arc of this.trailArcs) {
        this.scene.remove(arc.m);
        arc.m.geometry.dispose();
        arc.m.material.dispose();
      }
      this.trailArcs.length = 0;
      this.charge = new WeakMap();
      this.trailArc = new WeakMap();
    }

    updateRig(f, dt) {
      const rig = this.rigFor(f);
      const sp = spritePose(f);
      const H = rig.H;

      // the articulated rig already carries lean, squash, fall and twirl —
      // the billboard plane only tracks the fighter and keeps a landing stretch
      this.paintRig(rig, dt);
      rig.root.position.set(f.x, f.y, 0);
      rig.mir.scale.x = sp.squashX;
      rig.mir.scale.y = sp.squashY;

      const alpha = f.dead ? clamp(1 - f.stateT * 0.32, 0, 1) : 1;
      rig.bodyMat.opacity = alpha;

      // cinematic push-in mirrors the 2D engine on heavy/ultimate impacts
      if (this.a.cineT > 0) {
        const k = Math.sin(Math.min(1, this.a.cineT / Math.max(0.01, this.a.cineDur)) * Math.PI);
        rig.root.scale.setScalar(1 + k * 0.06);
      } else if (rig.root.scale.x !== 1) {
        rig.root.scale.setScalar(1);
      }

      // elemental aura: empower, burn, or casting
      const casting = f.state === "ability" && f.phase === "windup";
      const auraOn = f.empower > 0 || f.burn > 0 || casting;
      rig.auraMat.opacity = auraOn
        ? 0.16 + Math.sin(f.animT * 9) * 0.06 + (casting ? 0.14 : 0)
        : 0;
      if (f.burn > 0) rig.auraMat.color.set(0xff8a3c);
      else rig.auraMat.color.set(f.kit.color);

      // blob shadow tracks height
      const lift = clamp(1 - f.y / 400, 0.35, 1);
      rig.blob.position.set(f.x, 0.6, 0);
      rig.blob.scale.set(H * 0.62 * lift * sp.squashX, H * 0.42 * lift, 1);
      rig.blobMat.opacity = 0.42 * lift * alpha;

      // ward bubble
      const hasWard = f.shield > 0;
      rig.ward.visible = hasWard;
      if (hasWard) {
        const pulse = 1 + Math.sin(f.animT * 8) * 0.04;
        rig.ward.scale.setScalar(pulse);
        rig.wardMat.opacity = 0.09 + Math.sin(f.animT * 8) * 0.03;
      }

      // charge glow gathers at the casting hand (front of the sprite)
      if (casting && (f.attack && (f.attack.type === "magic" || f.attack.type === "buff"))) {
        const charge = clamp(f.stateT / Math.max(0.01, f.attack.windup), 0, 1);
        this.tmp.set(f.x + f.facing * H * 0.36, f.y + H * 0.62, 0);
        let sp2 = this.charge.get(f);
        if (!sp2) {
          const T = window.THREE;
          sp2 = new T.Sprite(new T.SpriteMaterial({
            map: this.glowTex, color: f.kit.glow, transparent: true, opacity: 0.8,
            blending: T.AdditiveBlending, depthWrite: false,
          }));
          this.scene.add(sp2);
          this.charge.set(f, sp2);
          this.chargeSprites.push(sp2);
        }
        sp2.visible = true;
        sp2.position.copy(this.tmp);
        const s = (12 + charge * 40) * f.scale;
        sp2.scale.set(s, s, 1);
        sp2.material.opacity = 0.5 + charge * 0.5;
        if (Math.random() < 0.4) {
          this.particles.spawn(
            this.tmp.x + rand(-8, 8), this.tmp.y + rand(-8, 8), f.kit.color,
            rand(-60, 60), rand(-40, 80), 0.3
          );
        }
      } else if (this.charge.has(f)) {
        this.charge.get(f).visible = false;
      }

      // the weapon's light trail is painted inside the rig texture itself,
      // so it stays locked to the blade from every camera angle
    }

    /* ---------------- camera ---------------- */
    stepCamera(dt) {
      const a = this.a;
      if (!a.player || !a.enemy) return;
      const mid = (a.player.x + a.enemy.x) / 2;
      const sep = Math.abs(a.player.x - a.enemy.x);
      const halfSpan = Math.max(280, sep / 2 + 200);
      const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
      const tanH = tanV * this.camera.aspect;
      const targetDist = clamp((halfSpan + 150) / Math.max(0.2, tanH), 460, 1350);
      this.cam.x = approach(this.cam.x, mid, 6, dt);
      this.cam.dist = approach(this.cam.dist, targetDist, 3.5, dt);
      const avgY = (a.player.y + a.enemy.y) / 2;
      this.cam.y = approach(this.cam.y, 92 + avgY * 0.25, 4, dt);

      const shake = a.shake;
      const sx = shake ? rand(-shake, shake) * 0.5 : 0;
      const sy = shake ? rand(-shake, shake) * 0.25 : 0;
      // cinematic beat pulls the camera in (kept gentle so mobile aiming
      // never fights the stick)
      let cineK = 0;
      if (a.cineT > 0) {
        cineK = Math.sin(Math.min(1, a.cineT / Math.max(0.01, a.cineDur)) * Math.PI);
      }
      this.cam.dist = Math.max(360, this.cam.dist * (1 - cineK * 0.07));
      this.camera.position.set(this.cam.x + sx, this.cam.y + sy + cineK * 10, this.cam.dist);
      this.camera.lookAt(this.cam.x, 58 + cineK * 6, 0);
      // impact zoom: heavy blows punch the lens in for a frame or two
      this.camera.fov = 42 - (a.fovPunch || 0) - cineK * 3.2;
      this.camera.rotation.z = cineK * 0.014 * (a.player && a.player.x < a.enemy.x ? 1 : -1);
      this.camera.updateProjectionMatrix();
    }

    /* ---------------- DOM numbers + banner ---------------- */
    numElFor(n) {
      let el = this.numEls.get(n);
      if (el) return el;
      el = document.createElement("div");
      el.className = "fx3d-num";
      this.dom.appendChild(el);
      this.numEls.set(n, el);
      return el;
    }

    renderNumbers() {
      const a = this.a;
      if (!this.dom) return;
      const used = new Set();
      for (let i = 0; i < a.numbers.length; i += 1) {
        const n = a.numbers[i];
        const el = this.numElFor(n);
        used.add(n);
        this.tmp.set(n.x, n.y, 0).project(this.camera);
        if (this.tmp.z > 1) {
          el.style.display = "none";
          continue;
        }
        el.style.display = "";
        const sx = (this.tmp.x * 0.5 + 0.5) * this.a.w;
        const sy = (-this.tmp.y * 0.5 + 0.5) * this.a.h;
        el.style.left = `${sx.toFixed(1)}px`;
        el.style.top = `${sy.toFixed(1)}px`;
        el.style.opacity = clamp(n.life, 0, 1).toFixed(2);
        if (el.textContent !== n.text) el.textContent = n.text;
        el.style.color = n.color;
        el.classList.toggle("is-crit", !!n.crit);
      }
      for (const [n, el] of this.numEls) {
        if (!used.has(n)) {
          el.remove();
          this.numEls.delete(n);
        }
      }
    }

    renderBanner() {
      const a = this.a;
      if (!this.dom) return;
      if (a.over && a.endT > 0.25) {
        if (!this.banner) {
          this.banner = document.createElement("div");
          this.banner.className = "fx3d-banner";
          this.banner.innerHTML = "<b></b><small></small>";
          this.dom.appendChild(this.banner);
        }
        const win = !a.player.dead;
        this.banner.classList.toggle("is-win", win);
        this.banner.classList.toggle("is-lose", !win);
        if (this.banner.firstChild.textContent !== (win ? "VICTORY!" : "DEFEAT")) {
          this.banner.firstChild.textContent = win ? "VICTORY!" : "DEFEAT";
          this.banner.lastChild.textContent = win
            ? `The ${a.enemy ? a.enemy.name : "gate guardian"} falls — chapter cleared`
            : "You wake at camp, fully healed";
          this.banner.classList.remove("is-shown");
          void this.banner.offsetWidth;
        }
        this.banner.classList.add("is-shown");
      } else if (this.banner) {
        this.banner.remove();
        this.banner = null;
      }
    }

    /* ---------------- frame ---------------- */
    render(dt) {
      const a = this.a;
      if (!a.player || !a.enemy) return;
      if (this.sceneName === null) this.setScene(a.scene || "bg-ember");

      this.stepCamera(dt || 1 / 60);
      this.stepEnv(dt, a.time);
      this.updateRig(a.player, dt);
      this.updateRig(a.enemy, dt);

      // adaptive resolution — if frames run long, shed pixels before shedding smoothness
      if (dt && dt > 0.001) {
        this.frameEma = this.frameEma * 0.93 + dt * 1000 * 0.07;
        if (this.frameEma > 23) this.frameHot += 1;
        else if (this.frameEma < 17) this.frameHot = Math.max(0, this.frameHot - 1);
        if (this.frameHot > 45 && this.dprCap > 1) {
          this.dprCap = Math.max(1, this.dprCap - 0.25);
          this.frameHot = 0;
          this.frameEma = 18;
          this.renderer.setPixelRatio(this.effectiveDpr());
          this.renderer.setSize(this.a.w, this.a.h, false);
        }
      }

      // ambient motes drift with the scene's weather
      const pos = this.moteGeo.attributes.position.array;
      const t = a.time;
      const vy = this.moteVy || 14;
      for (let i = 0; i < this.moteData.length; i += 1) {
        const m = this.moteData[i];
        pos[i * 3 + 1] += (vy * (0.5 + ((i % 7) / 10)) + m.vy * 0.25) * (dt || 1 / 60);
        pos[i * 3] += Math.sin(t * 0.6 + m.ph) * 0.3 + (vy < 0 ? 0.2 : 0);
        if (pos[i * 3 + 1] > 360) pos[i * 3 + 1] = -4;
        if (pos[i * 3 + 1] < -6) pos[i * 3 + 1] = 358;
      }
      if (this.moteBlink) {
        this.moteMat.opacity = 0.45 + Math.sin(t * 2.6) * 0.18;
      } else {
        this.moteMat.opacity = 0.55;
      }
      this.moteGeo.attributes.position.needsUpdate = true;
      // Colossus Gate lightning: the whole arena strobes for a beat
      if ((a.lightningFlash || 0) > 0 && this.sceneName === "bg-colossus") {
        this.accentLight.intensity = 6 + a.lightningFlash * 22 + Math.random() * 3;
      } else {
        this.accentLight.intensity = approach(this.accentLight.intensity, 2.2, 6, dt || 1 / 60);
      }

      // consume sim fx
      for (let i = 0; i < a.fx.length; i += 1) {
        const p = a.fx[i];
        if (p.type === "mote" || p.type === "dust") {
          if (!p._seeded) {
            p._seeded = true;
            this.particles.spawn(p.x, p.y, p.color, p.vx || 0, p.vy || 0, p.life);
          }
        } else if (p.type === "ring") {
          if (!p._seeded) {
            p._seeded = true;
            this.fireRing(p.x, p.y, p.color, p.size, p.grow || 140, p.max);
          }
        } else if (p.type === "flash") {
          if (!p._seeded) {
            p._seeded = true;
            this.fireFlash(p.x, p.y, p.color, p.size, p.max);
          }
        } else if (p.type === "slash") {
          if (!p._seeded) {
            p._seeded = true;
            this.fireArc(p.x, p.y, p.color, p.size, p.max, p.rot || 0);
          }
        }
      }
      // dash ghosts
      for (const f of [a.player, a.enemy]) {
        for (let i = 0; i < f.ghosts.length; i += 1) {
          const gh = f.ghosts[i];
          if (!gh._seeded) {
            gh._seeded = true;
            this.fireGhost(f, gh, FIGHTER_H * f.scale);
          }
        }
      }
      // shots
      for (let i = 0; i < a.shots.length; i += 1) {
        const s = a.shots[i];
        let shot = this.shotPool.find((sp) => sp.active && sp.owner === s);
        if (!shot) {
          shot = this.shotPool.find((sp) => !sp.active) || null;
          if (shot) {
            shot.active = true;
            shot.owner = s;
            shot.core.material.color.set(s.owner.kit.glow);
            shot.halo.material.color.set(s.owner.kit.color);
          }
        }
        if (!shot) continue;
        shot.core.position.set(s.x, s.y, 0);
        shot.halo.position.set(s.x, s.y, 0);
      }
      for (const sp of this.shotPool) {
        const still = sp.owner && a.shots.includes(sp.owner);
        sp.core.visible = !!still;
        sp.halo.visible = !!still;
      }

      // step pools
      this.stepParticles(dt || 1 / 60);
      for (const r of this.ringPool) {
        if (!r.active) continue;
        r.life -= dt || 1 / 60;
        if (r.life <= 0) { r.active = false; r.m.visible = false; continue; }
        r.size += r.grow * (dt || 1 / 60);
        const k = r.life / r.max;
        r.m.scale.set(r.size, r.size, 1);
        r.m.material.opacity = 0.85 * k;
      }
      for (const fl of this.flashPool) {
        if (!fl.active) continue;
        fl.life -= dt || 1 / 60;
        if (fl.life <= 0) { fl.active = false; fl.s.visible = false; continue; }
        const k = fl.life / fl.max;
        const s = fl.size * (1.6 - k * 0.6);
        fl.s.scale.set(s, s, 1);
        fl.s.material.opacity = 0.9 * k;
      }
      for (const ar of this.arcPool) {
        if (!ar.active) continue;
        ar.life -= dt || 1 / 60;
        if (ar.life <= 0) { ar.active = false; ar.m.visible = false; continue; }
        const k = ar.life / ar.max;
        ar.rot += ar.spin * (dt || 1 / 60);
        const s = ar.size * (1.5 - k * 0.5);
        ar.m.scale.set(s, s, 1);
        ar.m.rotation.z = ar.rot;
        ar.m.material.opacity = 0.8 * k;
      }
      for (const g of this.ghostPool) {
        if (!g.active) continue;
        g.life -= dt || 1 / 60;
        if (g.life <= 0) { g.active = false; g.m.visible = false; continue; }
        const k = g.life / g.max;
        g.m.material.opacity = 0.32 * k;
      }

      this.renderNumbers();
      this.renderBanner();
      if (this.contextLost) return;
      try {
        this.renderer.render(this.scene, this.camera);
        this.renderFails = 0;
      } catch (err) {
        this.renderFails += 1;
        if (this.renderFails > 40) this.a.swapTo2D();
      }
    }

    /* Effective device-pixel ratio honouring the hard pixel budget. Big
       phone screens at full dpr can exhaust GPU memory and destroy the
       context — cap the buffer first, crispness second. */
    effectiveDpr() {
      let dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
      const budget = 2_300_000;
      while (dpr > 0.75 && this.a.w * this.a.h * dpr * dpr > budget) dpr -= 0.05;
      return Math.max(0.75, Math.round(dpr * 20) / 20);
    }

    resize(w, h) {
      this.a.w = w;
      this.a.h = h;
      this.renderer.setPixelRatio(this.effectiveDpr());
      this.renderer.setSize(w, h, false);
      this.a.canvas.style.width = `${w}px`;
      this.a.canvas.style.height = `${h}px`;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ================================================================== *\
   * 2D renderer (fallback when WebGL/Three is unavailable)
   * ================================================================== */
  /* ================================================================== *\
   * fighter art — preloaded, decoded, pre-tinted key art sprites
   * ================================================================== */
  const ART_CACHE = new Map();

  function tintCanvas(img, color) {
    const c = makeCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /* One shared loader: the battle preloads both fighters before the bell,
     so the first swing never stutters on a texture decode. */
  function loadFighterArt(url) {
    if (!url) return { ready: false, promise: Promise.resolve(null) };
    if (ART_CACHE.has(url)) return ART_CACHE.get(url);
    const entry = {
      img: null, ready: false, white: null, cyan: null, tints: new Map(),
      promise: null,
    };
    entry.tint = (color) => {
      let t = entry.tints.get(color);
      if (!t && entry.img) {
        t = tintCanvas(entry.img, color);
        entry.tints.set(color, t);
      }
      return t || null;
    };
    entry.promise = new Promise((resolve) => {
      const img = new Image();
      const done = () => {
        if (entry.ready) return resolve(entry);
        if (img.width) {
          entry.img = img;
          try {
            entry.white = tintCanvas(img, "#ffffff");
            entry.cyan = tintCanvas(img, "#9fe4ff");
          } catch (_) { entry.white = entry.cyan = null; }
          entry.ready = true;
        }
        resolve(entry);
      };
      img.onload = done;
      img.onerror = done;
      img.src = url;
    });
    ART_CACHE.set(url, entry);
    return entry;
  }

  /* Whole-sprite animation parameters for the current state. Positive
     `lean` tips the fighter toward the foe (anticipation = negative),
     `rot` falls it backwards, `spin` is the cyclone twirl. Landing
     impact reads the sim's `squash` value (physics feedback). */
  function spritePose(f) {
    const t = f.animT;
    const a = f.attack;
    const o = { lean: 0, squashX: 1, squashY: 1, bob: 0, rot: 0, spin: 0 };
    const k = clamp(f.squash || 0, 0, 1);
    if (k > 0) {
      o.squashX *= 1 + 0.16 * k;
      o.squashY *= 1 - 0.13 * k;
    }
    switch (f.state) {
      case "idle": {
        const br = Math.sin(t * 2.1);
        o.bob = br * 2.6;
        o.squashY *= 1 + br * 0.013;
        o.lean = Math.sin(t * 0.7) * 0.02;
        break;
      }
      case "walk": {
        const dir = f.vx * f.facing > 0 ? 1 : -1;
        const w = Math.abs(Math.sin(t * 10.5));
        o.bob = w * 4.5;
        o.lean = 0.09 * dir;
        o.squashY *= 1 + w * 0.02;
        break;
      }
      case "attack":
      case "ability": {
        const kind = a ? a.type : "slash";
        const multi = a && (a.hits || 1) > 1;
        if (f.phase === "windup") {
          const kw = kind === "heavy" ? 1.7 : kind === "magic" ? 1.1 : 1;
          o.lean = -0.13 * kw;           // coil backwards — anticipation
          o.squashY *= 1.05;
          o.squashX *= 0.96;
          o.bob = -2;
        } else if (f.phase === "active") {
          if (multi) {
            o.spin = -Math.PI * 2 *
              clamp((f.stateT - (a.windup || 0)) / Math.max(0.01, a.active || 0.3), 0, 1);
            o.bob = 5;
          } else if (kind === "magic" || kind === "buff" || kind === "blink") {
            o.lean = 0.1;
          } else {
            o.lean = kind === "heavy" ? 0.4 : 0.24;  // drive into the blow
            o.squashX *= 1.08;
            o.squashY *= 0.95;
          }
          o.bob -= 3;
        } else {
          o.lean = 0.1;                  // follow-through
          o.squashY *= 0.99;
        }
        break;
      }
      case "dash":
        o.lean = 0.42;
        o.squashX *= 1.15;
        o.squashY *= 0.94;
        break;
      case "hurt":
        o.lean = -0.3;
        o.squashX *= 1.05;
        o.bob = -1;
        break;
      case "knock":
        o.rot = 0.5 + Math.min(0.7, f.stateT * 1.4);
        o.lean = -0.2;
        break;
      case "dead":
        o.rot = 1.45 * clamp(f.stateT * 2.2, 0, 1);
        break;
      case "victory":
        o.bob = Math.abs(Math.sin(t * 3.6)) * 9;
        o.lean = -0.06;
        break;
      default:
        break;
    }
    return o;
  }

  /* ================================================================== *\
   * the rig — Shadow-Fight-style articulated fighter, shared by 2D + 3D
   *
   * Everything is computed in a normalized space: feet at (0, 0), the crown
   * of the head at y = -100. Renderers just multiply by their own pixel
   * height, so the same skeleton marches, swings and breathes identically in
   * the crisp 2D canvas and inside the lit 3D arena (billboarded plane).
   * Layers back-to-front: aura → back limbs → cape/tail → torso armor →
   * front leg → head + hair → front arm + weapon → rim light → glow.
   * ================================================================== */
  const DOWN = (a) => ({ x: Math.sin(a), y: Math.cos(a) }); // 0 = hangs down, + = toward foe
  const UP = (a) => ({ x: Math.sin(a), y: -Math.cos(a) }); // 0 = straight up
  const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
  const bobFor = (f) => f.pose.bob;

  /* pose world-unit bob/dip are tuned for a 116-unit tall fighter; scale
     them into the 100-unit normalized rig space */
  const K = 100 / FIGHTER_H;

  function rigSkeleton(f) {
    const p = f.pose;
    const b = f.body;
    const s = {
      hipX: p.torsoY * 3.2, hipY: -46 - p.bob * K + p.dip * K * 0.7 + p.crouch * 4.2,
    };
    // spine: pelvis → chest → neck, tilted by torso lean
    const chestV = UP(p.torso);
    s.chest = add({ x: s.hipX, y: s.hipY }, chestV, 20 * b.torso);
    s.neck = add(s.chest, chestV, 5.5 * b.torso);
    const headV = UP(p.torso * 0.5 + p.head * 0.6);
    s.head = add(s.neck, headV, (5.2 + 1.1 * p.breath) * b.head);
    const shoulderV = DOWN(p.torso); // perpendicular-ish to the spine, toward the foe
    s.shF = add(s.chest, { x: shoulderV.y, y: -shoulderV.x }, 2.6 * b.shoulder);
    s.shF = { x: s.shF.x + 1.6, y: s.chest.y - 6.4 * b.shoulder + chestV.x * 1.5 };
    s.shB = { x: s.chest.x - 3.4, y: s.chest.y - 5.6 * b.shoulder + chestV.x * 1.5 };
    // arms: shoulder angles are DOWN-convention, elbows relative
    const aFU = DOWN(p.armF);
    s.elF = add(s.shF, aFU, 12.2 * b.arm);
    const aFL = DOWN(p.armF + p.armFE);
    s.haF = add(s.elF, aFL, 11.6 * b.arm);
    const aBU = DOWN(p.armB);
    s.elB = add(s.shB, aBU, 12.2 * b.arm);
    const aBL = DOWN(p.armB + p.armBE);
    s.haB = add(s.elB, aBL, 11.6 * b.arm);
    // legs: hip angles DOWN-convention, knees relative (negative = heel up)
    const lFU = DOWN(p.legF);
    s.knF = add({ x: s.hipX + 1.6, y: s.hipY }, lFU, 15.6 * b.leg);
    const lFL = DOWN(p.legF + p.legFK);
    s.anF = add(s.knF, lFL, 15.4 * b.leg);
    const lBU = DOWN(p.legB);
    s.knB = add({ x: s.hipX - 2.2, y: s.hipY }, lBU, 15.6 * b.leg);
    const lBL = DOWN(p.legB + p.legBK);
    s.anB = add(s.knB, lBL, 15.4 * b.leg);
    // the weapon lives in the front fist, welded along the forearm line
    s.weaponAng = p.armF + p.armFE + p.handF;
    return s;
  }

  /* Verlet chains for the cape / tail / hair — anchored to the skeleton,
     gravity + wind + lag give them secondary motion for free. */
  function solveChain(pts, ax, ay, seg, dt, opts) {
    const step = Math.min(1 / 30, Math.max(1 / 240, dt || 1 / 60));
    if (!pts.length) return;
    pts[0].x = ax; pts[0].y = ay;
    if (!pts[0].init) {
      for (const q of pts) { q.x = ax; q.y = ay + seg * pts.indexOf(q); q.px = q.x; q.py = q.y; q.init = true; }
    }
    const g = opts.gravity ?? 430;
    const wind = (opts.wind || 0) + (opts.flutter || 0) * Math.sin((opts.t || 0) * (opts.flutRate || 7));
    for (let i = 1; i < pts.length; i += 1) {
      const q = pts[i];
      const vx = (q.x - q.px) * 0.86;
      const vy = (q.y - q.py) * 0.86;
      q.px = q.x; q.py = q.y;
      q.x += vx - wind * step * step * 38 * (i / pts.length);
      q.y += vy + g * step * step;
      q.x -= (opts.drag || 0) * step * (i / pts.length);
    }
    for (let it = 0; it < 3; it += 1) {
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i]; const b = pts[i + 1];
        const dx = b.x - a.x; const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        const diff = (seg - d) / d / 2;
        if (i === 0) { b.x += dx * diff * 2; b.y += dy * diff * 2; }
        else {
          a.x -= dx * diff; a.y -= dy * diff;
          b.x += dx * diff; b.y += dy * diff;
        }
      }
      pts[0].x = ax; pts[0].y = ay;
    }
  }

  /* A bone with real depth: dark outline, base fill, and an offset light
     core — reads as rounded volume instead of a flat bar. */
  function bone(ctx, x0, y0, x1, y1, w0, w1, base, dark, hi) {
    const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, -w0, 0, w1);
    g.addColorStop(0, hi);
    g.addColorStop(0.42, base);
    g.addColorStop(1, dark);
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(-len / 2 - w0 * 0.2, -w0 - 0.7);
    ctx.quadraticCurveTo(0, -w1 - 1.4, len / 2 + w1 * 0.2, -w1 - 0.7);
    ctx.quadraticCurveTo(0, w1 + 1.4, -len / 2 - w0 * 0.2, w0 + 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-len / 2, -w0);
    ctx.quadraticCurveTo(0, -w1, len / 2, -w1);
    ctx.quadraticCurveTo(0, w1, -len / 2, w0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function blob(ctx, x, y, r, base, dark) {
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.arc(x, y, r + 0.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = base;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  /* the whole fighter — limbs, armor, head, hair, weapon, glow and trail.
     `flash` (>0) paints the exact silhouette hot white like an impact coat;
     `freeze` tints it icy. opts.alpha fades for deaths and ghosts. */
  function drawRig(ctx, f, ox, oy, h, opts) {
    opts = opts || {};
    const p = f.pose;
    const sk = f.skin;
    const b = f.body;
    const alpha = opts.alpha === undefined ? 1 : opts.alpha;
    const dt = opts.dt || 1 / 60;
    const s = rigSkeleton(f);
    const shade = f.facing >= 0 ? 1 : 1; // rig is drawn mirrored by the ctx scale
    void shade;
    // breathing swells the chest plate
    const chestR = 8.6 * b.torso * p.breath;

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(ox, oy);
    if (p.rot) {
      // fall/twirl pivots at the hips so the feet leave the floor naturally
      ctx.translate(s.hipX, s.hipY);
      ctx.rotate(-p.rot);
      ctx.translate(-s.hipX, -s.hipY);
    }
    ctx.scale(f.facing || 1, 1);
    ctx.scale(h / 100, h / 100);

    const isFlash = p.glow !== undefined && (f.flash > 0.04 || f.freeze > 0);
    const armor = sk.armor, armorHi = sk.armorHi, armorLo = sk.armorLo;
    const back = "rgba(8,7,16,0.92)";
    const backHi = "rgba(64,60,96,0.9)";
    const dark = "rgba(4,4,10,0.96)";

    /* ---- 1. aura behind the body (empower / burn / casting) ---- */
    if (opts.glow !== false && (p.glow > 0.05 || f.burn > 0 || f.shield > 0)) {
      const warm = f.burn > 0 ? "#ff8a3c" : sk.glow;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.min(0.5, 0.14 + p.glow * 0.26 + (f.burn > 0 ? 0.1 : 0));
      ctx.fillStyle = warm;
      ctx.beginPath();
      ctx.ellipse(s.chest.x, s.chest.y - 2, 26 + p.glow * 8, 44, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /* ---- 2. back limbs (deep shade) ---- */
    bone(ctx, s.shB.x, s.shB.y, s.elB.x, s.elB.y, 3.4, 2.8, back, dark, backHi);
    bone(ctx, s.elB.x, s.elB.y, s.haB.x, s.haB.y, 2.7, 2.2, back, dark, backHi);
    blob(ctx, s.haB.x, s.haB.y, b.claws ? 3.0 : 2.6, back, dark);
    bone(ctx, s.knB.x, s.knB.y, s.anB.x, s.anB.y, 3.6, 2.7, back, dark, backHi);
    // back foot planted
    bone(ctx, s.anB.x, s.anB.y, s.anB.x + 4.4 * Math.cos(p.footB * 0.5) + DOWN(p.legB + p.legBK).y * 1.6,
      s.anB.y + 1.4 + p.footB, 2.1, 1.6, back, dark, backHi);

    /* ---- 3. cape / tail (verlet cloth anchored to the spine) ---- */
    solveChain(f.cape, s.chest.x - 2.4, s.chest.y - 3.2, 7.6, dt, {
      wind: -0.5 + (f.vx * 0.004 * (f.facing || 1)), drag: Math.abs(f.vx) * 0.012,
      t: f.animT, flutRate: 5.6, flutter: 0.55,
    });
    if (opts.cloth !== false) {
      ctx.save();
      ctx.beginPath();
      const c0 = f.cape[0];
      ctx.moveTo(c0.x - 5.4, c0.y - 2.2);
      for (let qi = 0; qi < f.cape.length; qi += 1) ctx.lineTo(f.cape[qi].x - 6.5 - qi * 0.7, f.cape[qi].y);
      for (let i = f.cape.length - 1; i >= 0; i -= 1) ctx.lineTo(f.cape[i].x + 1.5, f.cape[i].y);
      ctx.closePath();
      const cg = ctx.createLinearGradient(s.chest.x, s.chest.y, f.cape[f.cape.length - 1].x, f.cape[f.cape.length - 1].y);
      cg.addColorStop(0, sk.cloth);
      cg.addColorStop(1, "rgba(6,5,12,0.94)");
      ctx.fillStyle = cg;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.09)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();
      if (b.tail) {
        // beast tail: a simple springy curve that lags the hips
        const lag = clamp(-f.vx * 0.02, -7, 7);
        const sway = Math.sin(f.animT * 5.2) * 2.4 + bobFor(f) * 0.4;
        ctx.save();
        ctx.strokeStyle = dark;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.hipX - 3, s.hipY - 1);
        ctx.quadraticCurveTo(s.hipX - 11 - lag, s.hipY - 4 + sway, s.hipX - 15 - lag * 1.5, s.hipY - 11 + sway * 1.6);
        ctx.lineWidth = 4.6;
        ctx.stroke();
        ctx.strokeStyle = armor;
        ctx.lineWidth = 2.6;
        ctx.stroke();
        ctx.restore();
      }
    }

    /* ---- 4. torso: pelvis, chest plate, pauldrons, belt ---- */
    bone(ctx, s.hipX, s.hipY + 1.5, s.chest.x, s.chest.y + 4, 6.4, 7.4, armorLo, dark, armor);
    // chest plate
    ctx.save();
    ctx.translate(s.chest.x, s.chest.y - 1.5);
    ctx.rotate(-Math.asin(clamp(UP(p.torso).x, -1, 1)) * 0.55);
    const pg = ctx.createLinearGradient(-chestR, -chestR, chestR, chestR);
    pg.addColorStop(0, armorHi);
    pg.addColorStop(0.5, armor);
    pg.addColorStop(1, armorLo);
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(-chestR - 1.6, -9.2);
    ctx.quadraticCurveTo(0, -13.5, chestR + 2.6, -8.6);
    ctx.quadraticCurveTo(chestR + 1.6, 3.5, 0, 7.2);
    ctx.quadraticCurveTo(-chestR - 0.6, 3.5, -chestR - 1.6, -9.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.moveTo(-chestR, -8.6);
    ctx.quadraticCurveTo(0, -12.5, chestR + 1.8, -8);
    ctx.quadraticCurveTo(chestR + 0.8, 2.8, 0, 6.2);
    ctx.quadraticCurveTo(-chestR, 2.8, -chestR, -8.6);
    ctx.closePath();
    ctx.fill();
    // elemental core light in the breastplate
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = sk.glow;
    ctx.globalAlpha = 0.42 + p.glow * 0.5;
    ctx.beginPath();
    ctx.arc(1.8, -1.6, 2.1 + p.glow, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // belt
    bone(ctx, s.hipX - 5, s.hipY - 1.6, s.hipX + 5.4, s.hipY - 1.6, 2.4, 2.2, "rgba(24,20,30,0.95)", dark, "rgba(120,110,140,0.5)");

    /* ---- 5. front leg + foot ---- */
    bone(ctx, s.knF.x, s.knF.y, s.anF.x, s.anF.y, 4.2, 3.0, armor, armorLo, armorHi);
    const footAng = p.footF;
    ctx.save();
    ctx.translate(s.anF.x, s.anF.y);
    ctx.rotate(-footAng * 0.6);
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(-2.2, -1.4);
    ctx.lineTo(6.4, -2.2);
    ctx.quadraticCurveTo(8.4, 0.4, 6.2, 2.0);
    ctx.lineTo(-2.0, 2.0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = b.claws ? sk.cloth : armorHi;
    ctx.beginPath();
    ctx.moveTo(-1.8, -0.6);
    ctx.lineTo(5.6, -1.3);
    ctx.quadraticCurveTo(7.0, 0.2, 5.4, 1.0);
    ctx.lineTo(-1.6, 1.0);
    ctx.closePath();
    ctx.fill();
    if (b.claws) {
      ctx.strokeStyle = "#e8e2f0";
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath(); ctx.moveTo(5.4 + i * 0.7, 0.6); ctx.lineTo(7.6 + i, 2.2); ctx.stroke();
      }
    }
    ctx.restore();
    // thigh plate
    bone(ctx, s.hipX + 1.6, s.hipY, s.knF.x, s.knF.y, 5.6, 4.4, armor, armorLo, armorHi);

    /* ---- 6. head: helmet/face, hair, horns, eyes ---- */
    const headR = (b.head * 5.4) * (1 + 0.01);
    // hair first (behind the skull), verlet-anchored at the crown
    solveChain(f.hair, s.head.x - 2.2, s.head.y - 4.0, 3.6, dt, {
      wind: -0.3 + (f.vx * 0.003 * (f.facing || 1)), drag: Math.abs(f.vx) * 0.01,
      t: f.animT, flutRate: 9, flutter: 1.1, gravity: 320,
    });
    if (opts.cloth !== false && !b.claws) {
      ctx.save();
      ctx.strokeStyle = sk.hair;
      ctx.lineCap = "round";
      for (let w = 0; w < 3; w += 1) {
        ctx.lineWidth = 3.4 - w * 0.7;
        ctx.beginPath();
        ctx.moveTo(s.head.x - 2.6, s.head.y - 3.2);
        for (const q of f.hair) ctx.lineTo(q.x + (w - 1) * 1.6, q.y + w * 0.6);
        ctx.stroke();
      }
      ctx.restore();
    }
    // neck + skull
    bone(ctx, s.neck.x, s.neck.y, s.head.x, s.head.y + 2, 2.6, 2.4, armorLo, dark, armor);
    ctx.save();
    ctx.translate(s.head.x, s.head.y);
    ctx.rotate(-p.headZ * 0.55 - UP(p.torso * 0.5 + p.head * 0.6).x * 0.5);
    blob(ctx, 0, 0, headR, b.claws ? "#241a2c" : armor, dark);
    // face plate / snout
    ctx.fillStyle = b.claws ? "#38283e" : "rgba(18,14,26,0.95)";
    ctx.beginPath();
    if (b.claws) {
      ctx.moveTo(-1, -headR * 0.4);
      ctx.lineTo(headR + 3.4, headR * 0.1);
      ctx.lineTo(headR + 1.4, headR * 0.8);
      ctx.lineTo(-1, headR * 0.85);
      ctx.closePath();
    } else {
      ctx.moveTo(headR * 0.25, -headR * 0.55);
      ctx.quadraticCurveTo(headR + 1.8, -headR * 0.1, headR * 0.4, headR * 0.72);
      ctx.lineTo(headR * 0.1, headR * 0.8);
      ctx.closePath();
    }
    ctx.fill();
    // glowing eyes — the signature shadow-fight spark
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = sk.glow;
    ctx.globalAlpha = 0.85 + p.glow * 0.15;
    ctx.beginPath();
    ctx.ellipse(headR * (b.claws ? 0.6 : 0.42), -headR * 0.12, 1.7, 0.9, 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(headR * 0.42, -headR * 0.1, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (b.horn) {
      ctx.save();
      ctx.strokeStyle = "#d9d2e6";
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.head.x - headR * 0.5, s.head.y - headR * 0.8);
      ctx.quadraticCurveTo(s.head.x - headR * 1.5, s.head.y - headR * 1.9, s.head.x - headR * 0.4, s.head.y - headR * 2.3);
      ctx.moveTo(s.head.x + headR * 0.2, s.head.y - headR * 0.95);
      ctx.quadraticCurveTo(s.head.x + headR * 0.9, s.head.y - headR * 2.1, s.head.x + headR * 1.9, s.head.y - headR * 1.9);
      ctx.stroke();
      ctx.restore();
    }
    // pauldron on the front shoulder (armor silhouette)
    if (!b.claws) {
      ctx.save();
      const pgd = ctx.createLinearGradient(s.shF.x, s.shF.y - 4, s.shF.x, s.shF.y + 4);
      pgd.addColorStop(0, armorHi);
      pgd.addColorStop(1, armorLo);
      ctx.fillStyle = pgd;
      ctx.beginPath();
      ctx.ellipse(s.shF.x - 0.4, s.shF.y - 2.2, 5.6 * b.shoulder, 3.6 * b.shoulder, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.restore();
    }

    /* ---- 7. front arm + gauntlet ---- */
    bone(ctx, s.shF.x, s.shF.y, s.elF.x, s.elF.y, 3.8, 3.0, armor, armorLo, armorHi);
    bone(ctx, s.elF.x, s.elF.y, s.haF.x, s.haF.y, 3.0, 2.5, armorLo, dark, armor);
    blob(ctx, s.haF.x, s.haF.y, b.claws ? 3.2 : 2.8, armor, armorLo);

    /* ---- 8. the weapon, welded to the fist, lit by the fighter's element ---- */
    drawWeapon(ctx, f, s, armor, armorLo, armorHi);

    /* ---- 9. rim light down the back edge (backlight from the arena) ---- */
    if (opts.rim !== false) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = sk.rim;
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(s.shB.x - 2.4, s.shB.y - 3);
      ctx.quadraticCurveTo(s.hipX - 7.6, (s.chest.y + s.hipY) / 2, s.knB.x - 3.4, s.knB.y);
      ctx.moveTo(s.head.x - headR * 0.9, s.head.y - headR * 0.5);
      ctx.quadraticCurveTo(s.neck.x - 4.5, s.neck.y, s.shB.x - 2, s.shB.y);
      ctx.stroke();
      ctx.restore();
    }

    /* ---- 10. hit flash / freeze coat over the exact silhouette ---- */
    if (isFlash) {
      const coat = f.freeze > 0 ? "rgba(150,220,255," : "rgba(255,255,255,";
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= Math.min(0.85, (f.freeze > 0 ? 0.4 : f.flash * 0.8));
      ctx.strokeStyle = coat + "0.9)";
      ctx.fillStyle = coat + "0.55)";
      ctx.lineWidth = 1.6;
      const hipPt = { x: s.hipX, y: s.hipY };
      for (const segPair of [
        [s.shB, s.elB], [s.elB, s.haB], [s.shF, s.elF], [s.elF, s.haF],
        [s.chest, hipPt], [s.knB, s.anB], [s.knF, s.anF],
      ]) {
        ctx.beginPath();
        ctx.moveTo(segPair[0].x, segPair[0].y);
        ctx.lineTo(segPair[1].x, segPair[1].y);
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(s.head.x, s.head.y, headR + 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    /* ---- 11. the blade's light trail (written in rig space while swinging) ---- */
    if (f.trail && f.trail.length > 1 && opts.trail !== false) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < f.trail.length; i += 1) {
        const a = f.trail[i - 1]; const b2 = f.trail[i];
        const k = i / f.trail.length;
        ctx.strokeStyle = sk.glow;
        ctx.globalAlpha = (b2.life / 0.16) * k * 0.6;
        ctx.lineWidth = 1 + k * 4.4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b2.x, b2.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  /* Per-kit weapons: sword, spear+shield, twin sabers, grimoire, scythe —
     plus monster claws. The blade keeps a subtle idle drift and ignites
     with `glow` while swinging or empowered. */
  function drawWeapon(ctx, f, s, armor, armorLo, armorHi) {
    const p = f.pose;
    const sk = f.skin;
    const b = f.body;
    const wA = p.armF + p.armFE + p.handF;
    const wv = DOWN(wA - Math.PI * 0.62); // blade rides ~110° off the forearm
    const glow = clamp(p.glow, 0, 1);
    ctx.save();

    if (b.claws) {
      // monster claws from both fists — slashes carry the glow on both hands
      ctx.strokeStyle = "#e9e3f2";
      ctx.lineWidth = 1.0;
      ctx.lineCap = "round";
      for (const hand of [s.haF, s.haB]) {
        const hv = DOWN(hand === s.haF ? wA : p.armB + p.armBE);
        for (let i = -1; i <= 1; i += 1) {
          ctx.beginPath();
          ctx.moveTo(hand.x + i * 1.1, hand.y + i * 0.4);
          ctx.quadraticCurveTo(
            hand.x + hv.x * 5 + i * 1.4, hand.y + hv.y * 5 - 1,
            hand.x + hv.x * 7.4 + i * 2.2, hand.y + hv.y * 7.4 - 0.4 + i
          );
          ctx.stroke();
        }
      }
      if (glow > 0.05) {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = sk.glow;
        ctx.globalAlpha = glow * 0.5;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(s.haF.x, s.haF.y);
        ctx.lineTo(s.haF.x + wv.x * 9, s.haF.y + wv.y * 9);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    const hx = s.haF.x; const hy = s.haF.y;
    ctx.translate(hx, hy);
    ctx.rotate(Math.atan2(wv.y, wv.x));

    const steelG = ctx.createLinearGradient(0, -2.4, 0, 2.4);
    steelG.addColorStop(0, "#f2effa");
    steelG.addColorStop(0.5, sk.steel);
    steelG.addColorStop(1, "#201b28");

    if (f.weapon === "sword") {
      // hilt + burning greatsword
      ctx.fillStyle = "#241c14";
      ctx.fillRect(-5.6, -1.2, 5.2, 2.4);
      ctx.fillStyle = armorHi;
      ctx.fillRect(-0.9, -3.4, 1.9, 6.8);
      const bl = 30 + glow * 2;
      ctx.fillStyle = steelG;
      ctx.beginPath();
      ctx.moveTo(0.9, -2.4);
      ctx.lineTo(bl - 3.2, -1.9);
      ctx.lineTo(bl, 0);
      ctx.lineTo(bl - 3.2, 1.9);
      ctx.lineTo(0.9, 2.4);
      ctx.closePath();
      ctx.fill();
      if (glow > 0.02) {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = sk.glow;
        ctx.globalAlpha = glow * 0.55;
        ctx.beginPath();
        ctx.moveTo(0.9, -3.4); ctx.lineTo(bl, -1.6); ctx.lineTo(bl, 1.6); ctx.lineTo(0.9, 3.4);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = glow * 0.85;
        ctx.fillStyle = "#fff2cf";
        ctx.beginPath();
        ctx.ellipse(bl * 0.55, 0, bl * 0.42, 1.1 + glow, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (f.weapon === "spear") {
      const bl = 36;
      ctx.fillStyle = "#3a2c1d";
      ctx.fillRect(-14, -1.1, bl, 2.2);
      ctx.fillStyle = steelG;
      ctx.beginPath();
      ctx.moveTo(bl - 14.5, -2.6);
      ctx.lineTo(bl - 2, 0);
      ctx.lineTo(bl - 14.5, 2.6);
      ctx.closePath();
      ctx.fill();
      if (glow > 0.02) {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = sk.glow;
        ctx.globalAlpha = glow * 0.75;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(bl - 14.5, 0); ctx.lineTo(bl - 2, 0);
        ctx.stroke();
      }
      // frostward carries the tower shield on the back arm
      ctx.save();
      ctx.translate(hx - 3.5, hy - 1);
      ctx.rotate(-0.12);
      const sg = ctx.createLinearGradient(-6, -9, 6, 9);
      sg.addColorStop(0, "#9fd6f2");
      sg.addColorStop(0.5, "#31597a");
      sg.addColorStop(1, "#101f2d");
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(-5.5, -9.5);
      ctx.lineTo(6.5, -8.5);
      ctx.quadraticCurveTo(8.8, 0, 6.2, 8.6);
      ctx.lineTo(-5.4, 9.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(220,245,255,0.5)";
      ctx.lineWidth = 0.9;
      ctx.stroke();
      if (glow > 0.03) {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = sk.glow;
        ctx.globalAlpha = glow * 0.5;
        ctx.beginPath();
        ctx.arc(0.5, 0, 3.4 + glow * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (f.weapon === "sabers") {
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.rotate(side * 0.18);
        ctx.fillStyle = "#241c14";
        ctx.fillRect(-4.4, -1, 4, 2);
        ctx.fillStyle = steelG;
        const bl = 17 + glow * 1.4;
        ctx.beginPath();
        ctx.moveTo(0, -1.6); ctx.lineTo(bl, -1.1); ctx.lineTo(bl + 1.6, 0); ctx.lineTo(bl, 1.1); ctx.lineTo(0, 1.6);
        ctx.closePath(); ctx.fill();
        if (glow > 0.02) {
          ctx.globalCompositeOperation = "lighter";
          ctx.strokeStyle = sk.glow;
          ctx.globalAlpha = glow * 0.7;
          ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(bl + 1.4, 0); ctx.stroke();
        }
        ctx.restore();
      }
    } else if (f.weapon === "tome") {
      // grimoire hovers beside the hand, runes orbit while casting
      ctx.fillStyle = armor;
      ctx.beginPath();
      ctx.roundRect(-4, -8.5, 9.5, 13.5, 1.4);
      ctx.fill();
      ctx.fillStyle = "rgba(235,228,255,0.92)";
      ctx.fillRect(-2.4, -7, 7, 10.5);
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = sk.glow;
      for (let i = 0; i < 3; i += 1) {
        const a = f.animT * (1.6 + i * 0.4) + i * 2.1;
        ctx.globalAlpha = 0.35 + glow * 0.5;
        ctx.beginPath();
        ctx.arc(0.8 + Math.cos(a) * (6.5 + i), -1 + Math.sin(a) * (5 + i * 1.6), 1.05, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (f.weapon === "scythe") {
      const shaft = 30;
      ctx.fillStyle = "#221418";
      ctx.fillRect(-12, -1.3, shaft, 2.6);
      ctx.strokeStyle = steelG;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(shaft - 12, -1);
      ctx.quadraticCurveTo(shaft + 10, -8, shaft + 13, -19);
      ctx.stroke();
      if (glow > 0.02) {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = sk.glow;
        ctx.lineWidth = 4.4;
        ctx.globalAlpha = glow * 0.55;
        ctx.beginPath();
        ctx.moveTo(shaft - 12, -1);
        ctx.quadraticCurveTo(shaft + 10, -8, shaft + 13, -19);
        ctx.stroke();
      }
    } else {
      // fallback iron sword
      ctx.fillStyle = steelG;
      ctx.fillRect(0, -1.8, 24, 3.6);
    }
    ctx.restore();

    /* blade trail: the glowing tip writes a fading arc while swinging */
    if (!f.trail) f.trail = [];
    const tipX = hx + Math.cos(Math.atan2(wv.y, wv.x)) * 30;
    const tipY = hy + Math.sin(Math.atan2(wv.y, wv.x)) * 30;
    if (glow > 0.45) {
      f.trail.push({ x: tipX, y: tipY, life: 0.16 });
      if (f.trail.length > 9) f.trail.shift();
    } else if (f.trail.length) {
      for (let i = f.trail.length - 1; i >= 0; i -= 1) {
        f.trail[i].life -= 1 / 60;
        if (f.trail[i].life <= 0) f.trail.splice(i, 1);
      }
    }
  }

  /* pre-rendered soft glow used for every 2D particle (no per-frame shadowBlur) */
  let GLOW = null;
  function glowSprite2D() {
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
  function tintedGlow2D(color) {
    if (tintCache.has(color)) return tintCache.get(color);
    const size = 64;
    const c = makeCanvas(size, size);
    const g = c.getContext("2d");
    g.drawImage(glowSprite2D(), 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    tintCache.set(color, c);
    return c;
  }

  class Renderer2D {
    constructor(arena) {
      this.a = arena;
      this.bandGrad = null;
    }
    resize(w, h) {
      const a = this.a;
      a.w = w;
      a.h = h;
      // keep the pixel budget sane on phones — this is the main perf lever
      const raw = window.devicePixelRatio || 1;
      const budget = 1_600_000;
      let dpr = Math.min(raw, 2);
      while (a.w * a.h * dpr * dpr > budget && dpr > 1) dpr -= 0.1;
      a.dpr = Math.max(1, Math.round(dpr * 10) / 10);
      a.canvas.width = Math.floor(a.w * a.dpr);
      a.canvas.height = Math.floor(a.h * a.dpr);
      a.canvas.style.width = `${a.w}px`;
      a.canvas.style.height = `${a.h}px`;
      a.ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
      a.ctx.imageSmoothingQuality = "low";
      a.groundYpx = a.h * 0.88;
    }
    setScene(name) {
      const a = this.a;
      if (a.sceneName === name && a.bgCanvas) return;
      a.sceneName = name;
      a.bgCanvas = this.paintBackdrop(name);
    }
    render(dt) {
      this.a.draw2D(dt);
    }

    /* The 2D backdrop is painted, never loaded: gradient sky, stars, mountain
       silhouettes and an elemental horizon glow, themed per scene. No image
       files, no network, no flash of empty background. */
    paintBackdrop(name) {
      const env = ENV3D[name] || ENV3D["bg-ember"];
      const css = (n) => `#${n.toString(16).padStart(6, "0")}`;
      const W = 640;
      const H = 360;
      const c = makeCanvas(W, H);
      const g = c.getContext("2d");
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#04050c");
      grad.addColorStop(0.4, css(env.sky));
      grad.addColorStop(0.6, css(env.hemiSky));
      grad.addColorStop(0.7, css(env.fog));
      grad.addColorStop(1, css(env.ground));
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 70; i += 1) {
        g.fillStyle = `rgba(255,255,255,${rand(0.08, 0.5).toFixed(2)})`;
        g.fillRect(Math.random() * W, Math.pow(Math.random(), 1.5) * H * 0.38, 1.6, 1.6);
      }
      const layer = (baseY, amp, color, seed) => {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(0, H);
        g.lineTo(0, baseY);
        let x = 0;
        while (x < W) {
          x += rand(26, 70);
          g.lineTo(x, baseY + Math.sin((x + seed) * 0.018) * amp + rand(-12, 12));
        }
        g.lineTo(W, H);
        g.closePath();
        g.fill();
      };
      layer(H * 0.64, 30, "rgba(12,14,30,0.85)", 40);
      layer(H * 0.7, 20, "rgba(7,9,20,0.94)", 110);
      // elemental glow along the horizon
      const glow = g.createRadialGradient(W / 2, H * 0.72, 20, W / 2, H * 0.72, 330);
      g.globalAlpha = 0.4;
      glow.addColorStop(0, css(env.accent));
      glow.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = glow;
      g.fillRect(0, H * 0.4, W, H * 0.5);
      g.globalAlpha = 1;
      // the guarded gate itself — a landmark silhouette behind the stage
      g.save();
      g.translate(W / 2, H * 0.72);
      g.globalAlpha = 0.9;
      const gateCol = "rgba(9,10,22,0.96)";
      if (name === "bg-colossus") {
        // the Ebon Colossus: a mountain-sized warden straddling the arch
        g.fillStyle = "rgba(15,12,20,0.94)";
        g.beginPath();
        g.moveTo(-150, 0); g.lineTo(-118, -150); g.lineTo(-64, -178);
        g.lineTo(-52, -232); g.lineTo(-20, -240); g.lineTo(20, -238);
        g.lineTo(34, -180); g.lineTo(104, -158); g.lineTo(150, 0);
        g.closePath(); g.fill();
        g.globalCompositeOperation = "lighter";
        g.fillStyle = "rgba(255,77,94,0.85)";
        g.beginPath(); g.arc(2, -222, 3.4, 0, Math.PI * 2); g.arc(16, -224, 3.4, 0, Math.PI * 2); g.fill();
      } else if (name === "bg-void") {
        // the Rift Gate: a torn eye of light hanging in the dark
        g.globalCompositeOperation = "lighter";
        const rg = g.createRadialGradient(0, -96, 4, 0, -96, 86);
        rg.addColorStop(0, "rgba(255,106,193,0.5)");
        rg.addColorStop(0.5, "rgba(122,31,82,0.24)");
        rg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = rg;
        g.beginPath(); g.ellipse(0, -96, 118, 40, 0.12, 0, Math.PI * 2); g.fill();
        g.strokeStyle = "rgba(255,168,216,0.55)";
        g.lineWidth = 2.2;
        g.beginPath(); g.ellipse(0, -96, 74, 22, 0.12, 0, Math.PI * 2); g.stroke();
      } else {
        // stone archway with an elemental keystone glow
        g.fillStyle = gateCol;
        g.beginPath();
        g.moveTo(-96, 6); g.lineTo(-84, -116);
        g.quadraticCurveTo(0, -176, 84, -116);
        g.lineTo(96, 6); g.lineTo(72, 6); g.lineTo(64, -102);
        g.quadraticCurveTo(0, -148, -64, -102);
        g.lineTo(-72, 6); g.closePath(); g.fill();
        for (let i = 0; i < 6; i += 1) {
          const a0 = -2.6 + (i / 5) * 2.0;
          g.beginPath();
          g.arc(Math.cos(a0) * 78, -110 + Math.sin(a0) * 34, 3.2, 0, Math.PI * 2);
          g.fillStyle = css(env.accent);
          g.globalAlpha = 0.5;
          g.fill();
        }
        g.globalAlpha = 1;
        if (name === "bg-frost") {
          g.fillStyle = "rgba(160,220,255,0.10)";
          g.beginPath(); g.moveTo(-64, 6); g.lineTo(0, -120); g.lineTo(64, 6); g.closePath(); g.fill();
        } else if (name === "bg-ember") {
          g.globalCompositeOperation = "lighter";
          const lgg = g.createLinearGradient(0, 40, 0, -60);
          lgg.addColorStop(0, "rgba(255,138,60,0.35)");
          lgg.addColorStop(1, "rgba(255,138,60,0)");
          g.fillStyle = lgg;
          g.fillRect(-64, -80, 128, 90);
        } else if (name === "bg-arcane") {
          g.globalCompositeOperation = "lighter";
          g.fillStyle = "rgba(180,139,255,0.32)";
          for (let i = 0; i < 4; i += 1) g.fillRect(-52 + i * 34, -142 - (i % 2) * 12, 10, 10);
        }
      }
      g.restore();
      // arena floor band + battle ring
      g.fillStyle = css(env.ground);
      g.fillRect(0, H * 0.74, W, H * 0.26);
      g.strokeStyle = css(env.accent);
      g.globalAlpha = 0.4;
      g.lineWidth = 2.5;
      g.beginPath();
      g.ellipse(W / 2, H * 0.87, 250, 30, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.18;
      g.beginPath();
      g.ellipse(W / 2, H * 0.87, 320, 40, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      return c;
    }
  }

  /* ================================================================== *\
   * arena
   * ================================================================== */
  class Arena {
    constructor(opts) {
      this.canvas = opts.canvas;
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
      this.slowmo = 1;
      this.time = 0;
      this.over = false;
      this.ended = false;
      this.running = false;
      this.input = { dx: 0, attack: false, abilities: [false, false, false] };
      this.buffer = null; // buffered attack/ability so taps never feel dropped
      this.cam = { x: 0, zoom: 1 };
      this.scene = null;
      this.bgCanvas = null;
      this.w = 640;
      this.h = 360;
      this.dpr = 1;
      this.groundYpx = this.h * 0.88;

      // Renderer choice. 3D when WebGL + Three are available, 2D otherwise.
      // Every failure path is survivable: a WebGL context that dies or a
      // constructor that throws can never leave the player staring at a
      // black canvas — the arena swaps to the 2D renderer on a fresh canvas.
      this.rendererPref = (opts.rendererPref || "auto").toLowerCase();
      this._cfgP = null;
      this._cfgE = null;
      this.use3D = false;
      const want3D = this.rendererPref !== "2d";
      if (want3D && typeof window.THREE !== "undefined" && window.THREE.WebGLRenderer && this.probeWebGL()) {
        try {
          this.r = new Renderer3D(this);
          this.use3D = true;
        } catch (err) {
          this.use3D = false;
          this._rendererError = String((err && err.message) || err);
        }
        if (!this.use3D) this.replaceCanvas(); // the dead GL context must not poison 2D
      }
      if (!this.use3D) {
        // A canvas element can host only ONE context type for its whole life.
        // If a previous renderer (the 3D engine, or a probe that failed) bound
        // WebGL to this node, getContext("2d") returns null and forcing 2D
        // would show a dead arena. Hand the 2D renderer a pristine node — this
        // is why "Graphics → 2D" now always works, even after switching back.
        this.replaceCanvas();
        this.ctx = this.canvas.getContext("2d", { alpha: false });
        if (!this.ctx) this.ctx = this.canvas.getContext("2d");
        this.r = new Renderer2D(this);
      }
      // scene-reactive ambience: embers / snow / rain / fireflies / petals
      this.ambient = [];
      this.ambientScene = null;
      this.lightningT = 3;
      this.lightningFlash = 0;
      this.flashScreen = 0;
      this.cineT = 0;
      this.cineDur = 1;
      this.cineZoom = 1;
    }

    /* one cinematic beat: slow-motion + push-in + optional white flash —
       used by heavy/ultimate releases and the killing blow */
    cinematic(dur = 0.34, zoom = 1.07, slow = 0.42, flash = 0) {
      this.cineT = dur; this.cineDur = dur; this.cineZoom = zoom;
      this.cineSlow = slow;
      if (flash) this.flashScreen = Math.max(this.flashScreen, flash);
    }

    /* A potion drunk mid-duel: instantly top the fighter up and print the
       healed amount in friendly green above the bar. */
    healFighter(f, amount) {
      if (!f || f.dead) return 0;
      const before = f.hp;
      f.hp = Math.min(f.maxHp, f.hp + amount);
      const healed = Math.round(f.hp - before);
      if (healed > 0) {
        this.number(f, `+${healed}`, "#8ef0a8", false);
        this.particles(f, 10, "#8ef0a8", 0.8);
        this.fx.push({
          type: "ring", color: "#8ef0a8", x: f.x, y: f.y + 50 * f.scale,
          life: 0.5, max: 0.5, size: 12, grow: 150,
        });
        SFX.ward();
      }
      return healed;
    }

    /* A canvas can host exactly one context type. If a WebGL attempt failed
       after binding a context, hand the 2D renderer a brand-new canvas node. */
    replaceCanvas() {
      const old = this.canvas;
      const fresh = old.cloneNode(false);
      if (old.parentNode) old.parentNode.replaceChild(fresh, old);
      this.canvas = fresh;
      return fresh;
    }

    /* Cheap up-front WebGL probe on the real canvas; THREE reuses the context. */
    probeWebGL() {
      try {
        const gl = this.canvas.getContext("webgl2") || this.canvas.getContext("webgl");
        return !!gl;
      } catch (_) {
        return false;
      }
    }

    /* Last-resort graphics safety: move the duel to the 2D renderer. */
    swapTo2D() {
      if (!this.use3D) return;
      this.use3D = false;
      try { this.r.renderer.dispose(); } catch (_) { /* already gone */ }
      try { this.r.disposeRigs(); } catch (_) { /* already gone */ }
      this.replaceCanvas();
      this.ctx = this.canvas.getContext("2d", { alpha: false });
      this.r = new Renderer2D(this);
      this.sceneName = null;
      if (this._cfgP && this._cfgE) {
        const running = this.running;
        const scene = this.scene;
        this.setFighters(this._cfgP, this._cfgE);
        if (scene) this.setScene(scene);
        this.resize(this.w, this.h);
        if (running) this.start();
        else this.draw();
      }
    }

    setScene(name) {
      this.scene = name;
      this.r.setScene(name);
      this.seedAmbient(name);
    }

    /* Scene ambience is chosen by WHICH GATE THE BOSS GUARDS: the Ember Gate
       rains rising cinders, the Frost Gate snows, the Obsidian/Arcane gate
       drifts glowing petals, the Rift Gate swarms with fireflies, and the
       Colossus Gate storms with rain, wind and distant lightning. */
    seedAmbient(name) {
      if (this.ambientScene === name) return;
      this.ambientScene = name;
      const a = [];
      const kinds = {
        "bg-ember": [["ember", 34], ["smoke", 10]],
        "bg-frost": [["snow", 44], ["mist", 8]],
        "bg-arcane": [["petal", 22], ["sparkle", 14], ["mist", 5]],
        "bg-void": [["firefly", 18], ["dust", 18]],
        "bg-colossus": [["rain", 70], ["spray", 10], ["ember", 8]],
      }[name] || [["ember", 26]];
      for (const [kind, n] of kinds) {
        for (let i = 0; i < n; i += 1) {
          a.push({
            kind,
            x: Math.random(), y: Math.random(),
            v: rand(0.02, 0.12), drift: rand(-0.03, 0.03),
            size: kind === "rain" ? rand(9, 20) : rand(1.2, 3.4),
            ph: rand(0, 6.28), speed: rand(0.6, 1.6),
          });
        }
      }
      this.ambient = a;
    }

    stepAmbient(dt) {
      const windy = this.scene === "bg-colossus" ? 0.5 : 0.06;
      for (const m of this.ambient) {
        switch (m.kind) {
          case "ember": case "sparkle":
            m.y -= (m.v * 0.55 + 0.02) * dt * m.speed;
            m.x += Math.sin(this.time * 1.7 + m.ph) * 0.015 * dt + windy * dt * 0.05;
            if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
            break;
          case "snow": case "petal": {
            const fall = m.kind === "petal" ? 0.16 : 0.22;
            m.y += fall * dt * m.speed;
            m.x += (Math.sin(this.time * (m.kind === "petal" ? 1.1 : 0.7) + m.ph) * 0.06 + windy * 0.12) * dt;
            if (m.y > 1.02) { m.y = -0.02; m.x = Math.random(); }
            break;
          }
          case "rain":
            m.y += (0.85 + m.v) * dt * m.speed;
            m.x += (0.16 + windy * 0.3) * dt;
            if (m.y > 1.02) { m.y = -0.06; m.x = Math.random(); }
            if (m.x > 1.02) m.x -= 1.04;
            break;
          case "firefly": case "dust": case "mist": case "spray":
            m.x += Math.sin(this.time * 0.42 + m.ph) * 0.02 * dt + windy * 0.04 * dt;
            m.y += Math.cos(this.time * 0.31 + m.ph * 1.7) * 0.012 * dt;
            if (m.x > 1.03) m.x -= 1.06;
            if (m.x < -0.03) m.x += 1.06;
            if (m.y > 1.03) m.y -= 1.06;
            if (m.y < -0.03) m.y += 1.06;
            break;
          default: break;
        }
      }
      // distant lightning at the Colossus Gate
      if (this.scene === "bg-colossus") {
        this.lightningT -= dt;
        if (this.lightningT <= 0) {
          this.lightningT = rand(4.2, 9.5);
          this.flashScreen = Math.max(this.flashScreen, 0.16);
          this.lightningFlash = 0.34;
          Audio2.noise({ dur: 1.1, gain: 0.07, type: "lowpass", freq: 220, sweep: -120, delay: 0.25 });
        }
      }
      if (this.flashScreen > 0) this.flashScreen = Math.max(0, this.flashScreen - dt * 1.9);
      if (this.lightningFlash > 0) this.lightningFlash = Math.max(0, (this.lightningFlash || 0) - dt * 2.4);
      if (this.cineT > 0) this.cineT = Math.max(0, this.cineT - dt);
    }

    setFighters(playerCfg, enemyCfg) {
      this._cfgP = playerCfg;
      this._cfgE = enemyCfg;
      if (this.use3D) this.r.disposeRigs(); // free GPU memory from the previous cast
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
      this.buffer = null;
      this.slowmo = 1;
      this.cam.x = 0;
      this.fovPunch = 0;
      if (this.use3D) this.r.cam.dist = 1600; // swoop in for the duel
    }

    resize(logicalW, logicalH) {
      this.w = Math.max(320, Math.round(logicalW));
      this.h = Math.max(200, Math.round(logicalH));
      this.r.resize(this.w, this.h);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      this.acc = 0;
      this.hudT = 0;
      const STEP = 1 / 120; // fixed 120 Hz sim: smooth on 60/90/120 Hz displays
      const loop = (now) => {
        if (!this.running) return;
        let frame = (now - this.last) / 1000;
        this.last = now;
        if (frame > 0.1) frame = 0.1; // tab was backgrounded — never spiral
        this.acc += frame;
        let steps = 0;
        while (this.acc >= STEP && steps < 10) {
          this.update(STEP);
          this.acc -= STEP;
          steps += 1;
        }
        if (steps === 10) this.acc = 0;
        this.hudT += frame;
        if (this.hudT >= 1 / 30 && this.player) {
          this.hudT = 0;
          this.onHud(this);
        }
        this.r.render(frame);
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
      // reactive players are rewarded: every chained hit in the combo window
      // escalates damage up to +30%, so fast attacks genuinely hit harder
      const comboMul = 1 + Math.min(0.3, 0.05 * Math.max(0, att.combo - 1));
      let base = att.stats.damage * mul * comboMul * (0.9 + Math.random() * 0.2);
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
        y1: owner.y + FIGHTER_H * owner.scale + 12,
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
        y: FIGHTER_H * owner.scale * 0.62,
        vx: owner.facing * (spec.speed || 500),
        vy: (spec.volley ? rand(18, 52) : 34) + this.shots.length * 0,
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

      // damage numbers are side-coded: YOUR hits burn in your element colour,
      // the evil's hits bleed red, crits always flare gold, heals come green.
      const sideColor = att.isPlayer ? att.kit.color : "#ff5f6d";
      this.number(def, `${dmg}`, crit ? "#ffd479" : sideColor, crit);
      if (att.combo >= 3 && (att.combo === 3 || att.combo % 4 === 0)) {
        this.number(att, `${att.combo}× COMBO`, "#ffd479", false);
      }
      this.impact(def, box.kind, crit, att);
      this.addShake(clamp((box.knock + dmg * 5) / 420, 0.25, 1.5) * (crit ? 14 : 9));
      this.hitStop = Math.max(this.hitStop, crit ? 0.05 : 0.032);
      this.fovPunch = Math.max(this.fovPunch || 0, crit ? 4 : box.kind === "heavy" ? 3 : 1.6);
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
      this.hitStop = 0.13;
      this.slowmo = 0.3; // the last blow lands in slow motion
      this.cinematic(0.55, 1.1, 0.3, 0.22);
      SFX.ko();
      const winner = f === this.player ? this.enemy : this.player;
      winner.state = "victory";
      winner.stateT = 0;
      this.over = true;
      this.endT = 0;
      setTimeout(() => SFX.win(), 650);
    }

    number(f, text, color, crit) {
      this.numbers.push({ x: f.x + rand(-14, 14), y: f.y + FIGHTER_H * f.scale * 0.95, vy: 96, life: 1, text, color, crit });
    }
    particles(f, count, color, spread = 1) {
      if (this.fx.length > 130) return;
      for (let i = 0; i < count; i += 1) {
        this.fx.push({
          type: "mote", color,
          x: f.x + rand(-18, 18) * spread,
          y: f.y + FIGHTER_H * f.scale * rand(0.3, 0.85),
          vx: rand(-230, 230) * spread,
          vy: rand(40, 330),
          life: rand(0.3, 0.7), max: 0.7, size: rand(6, 18),
        });
      }
    }
    impact(def, kind, crit, att) {
      const color = att.kit.color;
      const y = def.y + FIGHTER_H * def.scale * 0.55;
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
      f.vx -= f.facing * 40; // small weight shift back before the swing
      f.attack = {
        ...spec,
        windup: 0.1 / f.stats.atkSpeed,
        active: 0.09 / f.stats.atkSpeed,
        recover: 0.15 / f.stats.atkSpeed,
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
        if (spec.type === "heavy") f.vx -= f.facing * 90; // wind up by stepping back
        SFX.cast(f.element);
      }
      return true;
    }

    /* buffered inputs: a tap during recover becomes the next swing */
    bufferAction(f, what) {
      if (f.dead || this.over) return;
      this.buffer = { f, what, t: 0.45 };
    }
    flushBuffer(f, dt) {
      if (!this.buffer || this.buffer.f !== f) return;
      this.buffer.t -= dt;
      if (this.buffer.t <= 0) {
        if (this.buffer.f === f) this.buffer = null;
        return;
      }
      if (this.canAct(f) && f.state === "idle") {
        const what = this.buffer.what;
        this.buffer = null;
        if (what.type === "basic") this.doBasic(f);
        else this.doAbility(f, what.index);
      }
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
        if (spec.type === "heavy") {
          this.addShake(spec.shake || 8);
          SFX.whoosh();
          // ultimate rule: cinematic frame before a devastating blow lands
          const isUlt = (spec.mul || 1) >= 2.1;
          f.roar = 1;
          this.fx.push({ type: "flash", color: f.kit.glow, x: f.x + f.facing * 40, y: f.y + 70 * f.scale, life: 0.2, max: 0.2, size: 70 });
          if (isUlt && !this.over) this.cinematic(0.3, 1.075, 0.4, 0.1);
        }
      }
    }

    /* ---------------- update ---------------- */
    update(dt) {
      if (this.hitStop > 0) { this.hitStop -= dt; dt *= 0.22; }
      if (this.cineT > 0 && !this.over) dt *= this.cineSlow || 0.5; // ultimate slow-mo
      if (this.over && this.slowmo < 1) this.slowmo = approach(this.slowmo, 1, 1.4, dt);
      if (this.over) dt *= this.slowmo;
      this.time += dt;
      this.stepAmbient(dt / (this.cineT > 0 ? (this.cineSlow || 0.5) : 1));
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
    }

    controlPlayer(f, dt) {
      if (f.dead || f.freeze > 0) return;
      const sp = this.speed(f);
      if (!f.busy) f.vx = approach(f.vx, this.input.dx * sp, 11, dt);
      if (this.input.attack) {
        this.input.attack = false;
        this.faceFoe(f);
        if (!this.doBasic(f) && !f.dead) this.bufferAction(f, { type: "basic" });
      }
      for (let i = 0; i < 3; i += 1) {
        if (this.input.abilities[i]) {
          this.input.abilities[i] = false;
          this.faceFoe(f);
          if (!this.doAbility(f, i) && !f.dead) this.bufferAction(f, { type: "ability", index: i });
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

      f.stamina = Math.min(f.maxStamina, f.stamina + (f.busy ? 7 : 18) * (f.staminaRegenMul || 1) * dt);
      if (f.roar > 0) {
        f.roar = Math.max(0, f.roar - dt * 2.1);
        f.pose.glow = Math.max(f.pose.glow, f.roar * 0.9);
      }

      const prevState = f.state;
      if (f.state === "attack" || f.state === "ability") {
        const a = f.attack;
        if (a) {
          const wu = a.windup;
          const ac = a.active;
          if (f.phase === "windup" && f.stateT >= wu) {
            f.phase = "active";
            // the fighter physically drives into the blow
            const lunge = a.type === "heavy" ? 360 : a.type === "magic" ? -110 : 190;
            f.vx += f.facing * lunge * (a.hits > 1 ? 0.5 : 1);
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
        if (f.stateT > 0.17) f.state = "idle";
      } else if (f.state === "knock") {
        if (f.y <= 0 && f.stateT > 0.34) f.state = "idle";
      } else if (f.state === "dead" || f.state === "victory") {
        f.vx = approach(f.vx, 0, 5, dt);
      } else {
        f.state = Math.abs(f.vx) > 26 ? "walk" : "idle";
      }

      // a buffered swing fires the moment the fighter is free again
      if (prevState !== "idle" && f.state === "idle") this.flushBuffer(f, 0);
      this.flushBuffer(f, dt);

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
        const impact = -f.vy;
        f.y = 0;
        if (impact > 260) {
          f.squash = clamp(impact / 950, 0.25, 1);
          this.particles(f, Math.min(16, 4 + Math.round(impact / 130)), "#aab6e8", 0.85);
          this.addShake(clamp(impact / 260, 1, 6));
          if (impact > 520 && !f.dead) SFX.thud();
        } else if (impact > 80 && !f.dead) {
          this.particles(f, 6, "#9fb0ff", 0.6);
          SFX.step();
        }
        f.vy = 0;
      }
      f.wasAir = f.y > 2;
      f.squash = Math.max(0, f.squash - dt * 5.5);
      const friction = f.state === "knock" || f.state === "dash" ? 1.8 : 10;
      if (f !== this.player || f.busy || Math.abs(this.input.dx) < 0.05) {
        f.vx = approach(f.vx, 0, friction, dt);
      }
      const wall = f.x < -ARENA_HALF ? -1 : f.x > ARENA_HALF ? 1 : 0;
      f.x = clamp(f.x, -ARENA_HALF, ARENA_HALF);
      if (wall && Math.abs(f.vx) > 240) {
        // bounce off the arena rim with spark + shake — momentum matters
        f.vx *= -0.42;
        f.squash = Math.max(f.squash, 0.6);
        this.fx.push({ type: "flash", color: f.kit.glow, x: f.x + wall * 14, y: f.y + FIGHTER_H * f.scale * 0.5, life: 0.16, max: 0.16, size: 46 });
        this.particles(f, 5, f.kit.color, 0.8);
        this.addShake(4);
      }
      if (!f.dead && !this.over) this.faceFoe(f);

      for (let i = f.ghosts.length - 1; i >= 0; i -= 1) {
        f.ghosts[i].life -= dt;
        if (f.ghosts[i].life <= 0) f.ghosts.splice(i, 1);
      }
      this.poseFighter(f, dt);
    }

    separate(a, b) {
      const minX = 42 * (a.scale + b.scale);
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
        s.vy -= 150 * dt;
        s.y += s.vy * dt;
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
      this.fovPunch = Math.max(0, (this.fovPunch || 0) - dt * 26);
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

    /* ---------------- poses — a full articulated skeleton ---------------- *\
     * Angles are radians; the convention: 0 hangs straight down, positive
     * swings toward the enemy. Elbows/knees are RELATIVE to the upper bone,
     * so a leg's shin angle is hip + knee (knee negative bends backwards,
     * an arm's forearm is shoulder + elbow). Bob/dip are world-unit offsets,
     * breath is a chest scale, `glow` drives the weapon's energy aura.
     * Everything is driven to the target pose exponentially, which keeps the
     * animation smooth at any frame rate while snapping fast on attacks.
     * ================================================================ */
    poseFighter(f, dt) {
      const t = f.animT;
      const g = f.target;
      let rate = 13;
      const base = () => {
        // neutral guard stance: front hand up around the weapon, weight even
        g.head = 0; g.headZ = 0; g.torso = 0; g.torsoY = 0;
        g.armF = -0.55; g.armFE = -1.15; g.handF = 0;
        g.armB = 0.34; g.armBE = -1.0; g.handB = 0;
        g.legF = 0.16; g.legFK = -0.14; g.footF = -0.02;
        g.legB = -0.18; g.legBK = -0.2; g.footB = 0.06;
        g.bob = 0; g.rot = 0; g.dip = 0; g.crouch = 0; g.breath = 1; g.glow = 0;
      };
      const a = f.attack || {};
      const phaseT = f.stateT;
      const kind = a.type || "slash";

      switch (f.state) {
        case "idle": {
          base();
          // living guard: the chest breathes, the weapon hand sways, the head
          // drifts and occasionally snaps toward the foe like a real fighter
          const br = Math.sin(t * 2.0);
          g.breath = 1 + br * 0.028;
          g.bob = br * 1.9;
          g.dip = (1 + Math.sin(t * 2.0 - 0.5)) * 1.2;
          g.head = -0.05 + Math.sin(t * 0.7) * 0.04;
          g.headZ = Math.sin(t * 2.0 + 0.4) * 0.02;
          g.torso = 0.05 + br * 0.02;
          g.torsoY = br * 0.04;
          g.armF = -0.62 + Math.sin(t * 2.0 + 0.6) * 0.09;
          g.armFE = -1.22 + Math.sin(t * 2.0 + 0.9) * 0.07;
          g.handF = 0.14 + Math.sin(t * 2.0 + 1.2) * 0.1; // weapon keeps moving
          g.armB = 0.32 + Math.sin(t * 2.0 + 1.5) * 0.07;
          g.armBE = -0.95 + Math.sin(t * 2.0 + 1.8) * 0.05;
          g.legF = 0.15 + Math.sin(t * 2.0) * 0.02;
          g.legB = -0.17 - Math.sin(t * 2.0) * 0.02;
          g.glow = f.empower > 0 ? 0.55 + Math.sin(t * 10) * 0.2 : 0;
          rate = 7;
          break;
        }
        case "walk": {
          base();
          // real marching: thighs swing opposite to the arms, the swinging leg
          // lifts its heel (knee bends forward) and the plant leg compresses
          const dirSign = f.vx * f.facing > 0 ? 1 : -1;
          const w = t * 11.2 * dirSign;
          const sw = Math.sin(w);
          const cs = Math.cos(w);
          g.legF = sw * 0.62;
          g.legFK = -Math.max(0, -sw) * 1.15 - Math.max(0, sw) * 0.12;
          g.footF = sw > 0 ? 0.4 * sw : -0.22;
          g.legB = -sw * 0.62;
          g.legBK = -Math.max(0, sw) * 1.15 - Math.max(0, -sw) * 0.12;
          g.footB = -sw > 0 ? 0.4 * -sw : -0.22;
          g.bob = Math.abs(cs) * 5.2 - 2;
          g.dip = 2 + Math.max(0, -cs) * 2.6;
          g.crouch = 0.16;
          g.torso = 0.12 * dirSign;
          g.torsoY = sw * 0.07;
          g.head = -0.05 * dirSign + Math.sin(w * 2) * 0.03;
          g.armF = -0.6 + sw * 0.34 * dirSign;
          g.armFE = -1.18 - Math.max(0, sw) * 0.1;
          g.handF = 0.12 - sw * 0.3 * dirSign;
          g.armB = 0.34 - sw * 0.4 * dirSign;
          g.armBE = -0.98 - Math.max(0, -sw) * 0.14;
          g.breath = 1 + Math.sin(w * 2) * 0.016;
          rate = 17;
          break;
        }
        case "attack": {
          base();
          rate = 44;
          const p = f.phase;
          if (p === "windup") {
            // coil: weapon hand rises behind the helmet, weight sinks back
            const k = clamp(phaseT / Math.max(0.01, a.windup || 0.1), 0, 1);
            g.torso = -0.3 - k * 0.1; g.torsoY = -0.35 * k;
            g.armF = -0.55 - k * 2.2;         // shoulder rotates back-up
            g.armFE = -1.15 - k * 0.6;        // elbow folds the blade behind
            g.handF = 0.4 - k * 1.1;
            g.armB = 0.34 + k * 0.5; g.armBE = -1.0 + k * 0.35;
            g.head = -0.1 - k * 0.1; g.headZ = -k * 0.06;
            g.legF = 0.05; g.legB = -0.34; g.legBK = -0.42 * k; g.crouch = 0.24 * k;
            g.dip = 3 + k * 3;
            g.glow = k * 0.5;
          } else if (p === "active") {
            // strike: whole body uncoils through the swing, fist leads
            const k = clamp((phaseT - (a.windup || 0)) / Math.max(0.01, a.active || 0.1), 0, 1);
            const snap = 1 - Math.pow(1 - k, 2.2);
            g.torso = 0.42 * snap - 0.3 * (1 - snap); g.torsoY = 0.5 * snap;
            g.armF = -2.75 + snap * 4.3;              // overhead -> down on the foe
            g.armFE = -1.75 + snap * 1.15;
            g.handF = -0.7 + snap * 1.05;
            g.armB = 0.84 - snap * 1.5; g.armBE = -0.65 - snap * 0.4;
            g.head = 0.16; g.headZ = 0.05;
            g.legF = 0.72; g.legFK = -0.3; g.footF = 0.3;
            g.legB = -0.55; g.legBK = -0.66; g.crouch = 0.4;
            g.bob = -3; g.dip = 6;
            g.glow = snap >= 0.99 ? 1 : 0.65;
          } else {
            // recover: momentum carries, then settles back toward guard
            const k = clamp((phaseT - ((a.windup || 0) + (a.active || 0.1))) / Math.max(0.01, a.recover || 0.15), 0, 1);
            const e = 1 - k;
            g.torso = 0.2 * e; g.torsoY = 0.2 * e;
            g.armF = 1.55 - 2.1 * k; g.armFE = -0.6 * e; g.handF = 0.3 * e;
            g.armB = 0.34; g.armBE = -0.95;
            g.legF = 0.5 * e + 0.16; g.legB = -0.4 * e - 0.18; g.crouch = 0.3 * e;
            g.dip = 4 * e; g.glow = 0.5 * e;
          }
          break;
        }
        case "ability": {
          base();
          rate = 36;
          const p = f.phase;
          if (kind === "heavy" && (a.hits || 1) > 1) {
            // cyclone whirl: the body spins on one leg, arms out wide
            const spin = p === "active"
              ? ((phaseT - (a.windup || 0)) / Math.max(0.01, a.active || 0.3)) * Math.PI * 2
              : 0;
            g.rot = -spin * (f.facing > 0 ? 1 : 1);
            g.torso = 0.2; g.head = -0.1;
            g.armF = p === "windup" ? -1.9 : 1.75 + Math.sin(spin) * 0.7;
            g.armFE = -0.35; g.armB = -1.6 - Math.sin(spin) * 0.7; g.armBE = -0.3;
            g.legF = p === "active" ? 1.35 : 0.2; g.legFK = -1.4; g.footF = 0.4;
            g.legB = -0.15; g.legBK = -0.2;
            g.bob = p === "active" ? 7 : -2; g.dip = 8; g.crouch = 0.3;
            g.glow = p === "active" ? 1 : 0.4;
            rate = 46;
          } else if (kind === "heavy") {
            if (p === "windup") {
              // both hands raise the weapon high — legs sink under the load
              const k = clamp(phaseT / Math.max(0.01, a.windup || 0.25), 0, 1);
              g.torso = -0.5 - 0.15 * k; g.head = -0.3;
              g.armF = -0.55 - 2.6 * k; g.armFE = -1.15 - 0.55 * k;
              g.armB = 0.34 - 2.2 * k; g.armBE = -1.0 - 0.5 * k;
              g.handF = -0.4; g.handB = -0.4;
              g.legF = 0.1; g.legB = -0.42; g.legBK = -0.6; g.crouch = 0.55 * k;
              g.dip = 4 + 8 * k; g.glow = k;
            } else if (p === "active") {
              const k = clamp((phaseT - (a.windup || 0)) / Math.max(0.01, a.active || 0.14), 0, 1);
              const snap = 1 - Math.pow(1 - k, 2.6);
              g.torso = 0.72 * snap - 0.65 * (1 - snap); g.head = 0.34;
              g.armF = -3.15 + snap * 5.15; g.armFE = -1.7 + snap * 1.5;
              g.armB = -1.86 + snap * 2.4; g.armBE = -1.5 + snap * 0.8;
              g.legF = 0.95; g.legFK = -0.2; g.footF = 0.45;
              g.legB = -0.7; g.legBK = -0.5; g.crouch = 0.65;
              g.dip = 14; g.bob = -5; g.glow = 1;
            } else {
              g.torso = 0.34; g.armF = 2.1; g.armFE = -0.5; g.armB = 0.55; g.armBE = -0.8;
              g.legF = 0.6; g.legB = -0.5; g.crouch = 0.4; g.dip = 9; g.glow = 0.6;
            }
          } else if (kind === "magic") {
            if (p === "windup") {
              // gathering: palms apart, energy pulls between them
              const k = clamp(phaseT / Math.max(0.01, a.windup || 0.22), 0, 1);
              g.torso = -0.24; g.head = -0.2;
              g.armF = -2.35 + Math.sin(t * 24) * 0.06; g.armFE = -0.35;
              g.armB = -2.75 - Math.sin(t * 24) * 0.06; g.armBE = 0.3;
              g.handF = -0.6; g.handB = 0.5;
              g.legF = 0.24; g.legB = -0.34; g.legBK = -0.34; g.crouch = 0.3 * k;
              g.dip = 5; g.breath = 1.05; g.glow = k;
            } else if (p === "active") {
              // release: front palm thrusts the bolt out
              g.torso = 0.3; g.head = 0.12;
              g.armF = -0.95; g.armFE = 0.28; g.handF = -0.5;
              g.armB = -1.9; g.armBE = 0.2;
              g.legF = 0.52; g.legB = -0.5; g.legBK = -0.3; g.crouch = 0.4;
              g.dip = 3; g.glow = 1;
            } else {
              g.torso = 0.1; g.armF = -1.2; g.armFE = -0.8; g.armB = -0.6; g.glow = 0.3;
            }
          } else {
            // buff / ward — palms up, knees sink, chest lifts
            if (p === "windup") {
              g.armF = -2.5; g.armFE = -0.35; g.armB = -2.5; g.armBE = 0.35;
              g.torso = -0.18; g.dip = 7; g.crouch = 0.4; g.breath = 1.06; g.glow = 0.8;
            } else {
              g.armF = -1.75; g.armFE = -1.2; g.armB = -1.75; g.armBE = -1.2;
              g.torso = 0.12; g.head = -0.22; g.bob = 4; g.breath = 1.08; g.glow = 1;
            }
          }
          break;
        }
        case "dash": {
          base();
          // low sprint: torso over the front knee, arms driving back
          g.torso = 0.62; g.head = 0.25; g.headZ = -0.1;
          g.armF = -1.1; g.armFE = -1.7; g.handF = 0.2;
          g.armB = 1.9; g.armBE = -1.3;
          g.legF = 1.15; g.legFK = -1.5; g.footF = 0.5;
          g.legB = -0.95; g.legBK = -0.5; g.footB = 0.3;
          g.crouch = 0.5; g.dip = 10; g.bob = -2; g.rot = 0.06;
          rate = 30;
          break;
        }
        case "hurt": {
          base();
          // head-snapping recoil, arms flail up, front foot scrubs backwards
          const k = clamp(1 - f.stateT / 0.17, 0, 1);
          g.torso = -0.6 * k - 0.05; g.head = -0.85 * k; g.headZ = 0.2 * k;
          g.armF = -1.35 * k - 0.6; g.armFE = -2.1 * k - 1.0;
          g.armB = 1.2 * k + 0.3; g.armBE = -2.0 * k - 0.9;
          g.legF = -0.4 * k + 0.16; g.legFK = -1.0 * k; g.footF = 0.5 * k;
          g.legB = -0.15 - 0.35 * k; g.crouch = 0.3 * k; g.dip = 3 + 4 * k;
          g.torsoY = -0.3 * k;
          rate = 36;
          break;
        }
        case "knock": {
          base();
          // launched: body pinwheels while airborne, limbs stream back
          const air = clamp(f.y / 60, 0, 1);
          g.rot = -0.5 - Math.min(0.85, f.stateT * 1.6) - air * 0.25;
          g.torso = -0.5; g.head = -0.75;
          g.armF = -2.0; g.armFE = -0.5; g.armB = -2.6; g.armBE = -0.4;
          g.legF = -0.75; g.legFK = -0.3; g.legB = 0.6; g.legBK = -0.9;
          g.dip = 4; g.glow = 0;
          rate = 20;
          break;
        }
        case "dead": {
          base();
          // topple past the fall and go flat, weapon hand slackens
          const k = clamp(1 - Math.exp(-f.stateT * 3.2), 0, 1);
          g.rot = -1.52 * k;
          g.torso = -0.3 * k; g.head = -0.6 * k; g.headZ = 0.3 * k;
          g.armF = -1.1 - 0.6 * k; g.armFE = -1.2 + 0.7 * k;
          g.armB = -0.4 * k + 0.3; g.armBE = -1.3;
          g.legF = -0.5; g.legFK = -0.2; g.legB = 0.4; g.legBK = -0.1;
          g.dip = 4; g.glow = 0;
          rate = 9;
          break;
        }
        case "victory": {
          base();
          // winning loop: weapon raised, one knee drives up, chest swells
          const v = Math.abs(Math.sin(t * 3.4));
          g.armF = -2.65 + Math.sin(t * 3.4) * 0.09; g.armFE = -0.35;
          g.handF = -0.55;
          g.armB = 0.6 + Math.sin(t * 3.4 + 0.6) * 0.2; g.armBE = -1.5;
          g.bob = v * 11; g.dip = (1 - v) * 6;
          g.legB = -0.42 - v * 0.3; g.legBK = -0.75 - v * 0.5;
          g.head = -0.28; g.torso = 0.14; g.breath = 1 + v * 0.07;
          g.glow = 0.75 + v * 0.25;
          rate = 11;
          break;
        }
        default:
          base();
      }

      const k = 1 - Math.exp(-rate * dt);
      const p2 = f.pose;
      for (const key of POSE_KEYS) p2[key] = lerp(p2[key], g[key], k);
    }

    /* ================================================================ *\
     * drawing (2D fallback path — the 3D renderer owns its own scene)
     * ================================================================ */
    draw() {
      this.r.render();
    }

    draw2D(dt) {
      const ctx = this.ctx;
      if (!this.running && dt) {
        // keep the world alive behind the match card — the arena should never
        // feel like a paused screenshot
        this.time += dt;
        this.stepAmbient(dt);
      }
      // cinematic push-in (ultimates / the killing blow)
      const cine = this.cineT > 0 ? 1 + (this.cineZoom - 1) * Math.sin(Math.min(1, this.cineT / this.cineDur) * Math.PI) : 1;
      const zoomBefore = this.cam.zoom;
      this.cam.zoom *= cine;
      this.drawScene(ctx, dt);
      const order = [this.player, this.enemy];
      order.forEach((f) => this.drawShadow(ctx, f));
      this.drawGroundFx(ctx);
      this.drawAmbient(ctx, "back");
      order.forEach((f) => this.drawFighter(ctx, f, dt));
      this.drawShots(ctx);
      this.drawAirFx(ctx);
      this.drawAmbient(ctx, "front");
      // drifting foreground fog for depth
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = "#d5e2ff";
      for (let i = 0; i < 3; i += 1) {
        const fx = ((this.time * (8 + i * 5)) % (this.w + 400)) - 200;
        ctx.beginPath();
        ctx.ellipse(fx, this.h * (0.3 + i * 0.2), 240, 44 + i * 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      if (this.flashScreen > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `rgba(255,246,222,${(this.flashScreen * 0.5).toFixed(3)})`;
        ctx.fillRect(0, 0, this.w, this.h);
        ctx.restore();
      }
      this.drawNumbers(ctx);
      // cinematic letterbox bars slide in during the slow-motion beat
      if (cine > 1.002) {
        const bar = (cine - 1) * 520;
        ctx.save();
        ctx.fillStyle = "rgba(3,4,10,0.92)";
        ctx.fillRect(0, 0, this.w, bar);
        ctx.fillRect(0, this.h - bar, this.w, bar);
        ctx.restore();
      }
      this.cam.zoom = zoomBefore;
      if (this.over) this.drawEndBanner(ctx);
    }

    drawScene(ctx, dt) {
      const w = this.w;
      const h = this.h;
      if (this.bgCanvas) {
        // parallax: the painted backdrop drifts a fraction of the camera
        const img = this.bgCanvas;
        const scale = Math.max(w / img.width, h / img.height) * 1.14;
        const dw = img.width * scale;
        const dh = img.height * scale;
        const ox = -this.cam.x * 0.28 * this.cam.zoom + this.shakeX * 0.4;
        ctx.drawImage(img, w / 2 - dw / 2 + ox, h - dh + this.shakeY * 0.3, dw, dh);
      } else {
        ctx.fillStyle = "#0a0d22";
        ctx.fillRect(0, 0, w, h);
      }
      // torch flicker — two warm pools of light pulse on the stage edges
      const t = this.time;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const side of [-1, 1]) {
        const fx = w / 2 + side * w * 0.34 - this.cam.x * 0.2 * this.cam.zoom;
        const flick = 0.10 + Math.sin(t * 11 + side * 2.4) * 0.03 + Math.random() * 0.012;
        const g = ctx.createRadialGradient(fx, h * 0.62, 6, fx, h * 0.62, h * 0.5);
        g.addColorStop(0, `rgba(255,190,110,${flick.toFixed(3)})`);
        g.addColorStop(1, "rgba(255,190,110,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
      this.drawAmbient(ctx, "back");
      // rolling ground fog
      ctx.save();
      const fogG = ctx.createLinearGradient(0, h * 0.72, 0, h);
      fogG.addColorStop(0, "rgba(140,160,220,0)");
      fogG.addColorStop(1, "rgba(150,170,230,0.13)");
      ctx.fillStyle = fogG;
      const wob = Math.sin(t * 0.5) * 14;
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, h * 0.86 + wob * 0.4);
      for (let x = 0; x <= w; x += w / 6) {
        ctx.quadraticCurveTo(
          x + w / 12, h * 0.82 + Math.sin(t * 0.7 + x * 0.01) * 7 - wob * 0.3,
          x + w / 6, h * 0.87 + Math.sin(t * 0.5 + x * 0.013) * 8
        );
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
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
      void dt;
    }

    /* ambient particles — drawn behind or in front of the fighters */
    drawAmbient(ctx, layer) {
      const w = this.w;
      const h = this.h;
      const front = new Set(["rain", "ember", "sparkle", "firefly"]);
      ctx.save();
      for (const m of this.ambient) {
        const isFront = front.has(m.kind);
        if (isFront !== (layer === "front")) continue;
        const x = m.x * w + Math.sin(this.time * 0.8 + m.ph) * 6 - this.cam.x * 0.12 * this.cam.zoom;
        const y = m.y * h;
        switch (m.kind) {
          case "rain": {
            ctx.strokeStyle = "rgba(174,196,255,0.34)";
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 4.5, y + m.size * 1.6);
            ctx.stroke();
            break;
          }
          case "snow": {
            ctx.globalAlpha = 0.75;
            ctx.fillStyle = "#eef7ff";
            ctx.beginPath();
            ctx.arc(x, y, m.size * 0.9, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case "ember": {
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = 0.55 + Math.sin(this.time * 6 + m.ph) * 0.2;
            ctx.drawImage(tintedGlow2D("#ffb066"), x - m.size * 2.4, y - m.size * 2.4, m.size * 4.8, m.size * 4.8);
            break;
          }
          case "sparkle": case "firefly": {
            const col = m.kind === "firefly" ? "#ff8ad8" : "#c0a4ff";
            ctx.globalCompositeOperation = "lighter";
            const tw = Math.pow(Math.max(0, Math.sin(this.time * (m.kind === "firefly" ? 1.9 : 3.1) + m.ph)), 3);
            ctx.globalAlpha = 0.15 + tw * 0.8;
            ctx.drawImage(tintedGlow2D(col), x - m.size * 3, y - m.size * 3, m.size * 6, m.size * 6);
            break;
          }
          case "petal": {
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = "#c4b1ff";
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(m.ph + this.time * 1.4);
            ctx.beginPath();
            ctx.ellipse(0, 0, m.size * 1.5, m.size * 0.7, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            break;
          }
          case "mist": case "spray": {
            ctx.globalAlpha = 0.05;
            ctx.fillStyle = "#b9c8ff";
            ctx.beginPath();
            ctx.ellipse(x, y, m.size * 22, m.size * 7, 0, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case "dust": {
            ctx.globalAlpha = 0.22;
            ctx.fillStyle = "#caa0e8";
            ctx.fillRect(x, y, 1.4, 1.4);
            break;
          }
          default: break;
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
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
      ctx.ellipse(sx, gy, 30 * f.scale * this.cam.zoom * lift, 8 * f.scale * this.cam.zoom * lift, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawFighter(ctx, f, dt) {
      const zoom = this.cam.zoom;
      const [sx, sy] = this.project(f.x, f.y);
      const o = spritePose(f); // whole-body accents: squash on landing, dash stretch
      const H = FIGHTER_H * f.scale * zoom * 1.08;
      const alpha = f.dead ? clamp(1 - f.stateT * 0.32, 0, 1) : 1;

      // dash after-images: the same rig burned into additive light behind the path
      if (f.ghosts.length) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (const gh of f.ghosts) {
          const [gx, gy] = this.project(gh.x, f.y);
          ctx.save();
          ctx.translate(gx, gy);
          drawRig(ctx, f, 0, 0, H, { alpha: (gh.life / gh.max) * 0.42, rim: true, cloth: false, trail: false, dt: 1 / 120 });
          ctx.restore();
        }
        ctx.restore();
      }

      ctx.save();
      ctx.translate(sx, sy);
      // squash & stretch around the landing point keeps feet on the floor
      ctx.scale(o.squashX, o.squashY);
      ctx.translate(0, -o.bob * zoom * 0.35);
      drawRig(ctx, f, 0, 0, H, { alpha, dt: dt || 1 / 60 });
      ctx.restore();

      // ward bubble
      if (f.shield > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.3 + Math.sin(f.animT * 8) * 0.08;
        ctx.strokeStyle = "#7fd8ff";
        ctx.lineWidth = 3 * zoom;
        ctx.beginPath();
        ctx.ellipse(sx, sy - H * 0.5, H * 0.44, H * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha *= 0.35;
        ctx.fillStyle = "#7fd8ff";
        ctx.beginPath();
        ctx.ellipse(sx, sy - H * 0.5, H * 0.42, H * 0.58, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (f.empower > 0 && Math.random() < 0.5) this.particles(f, 1, f.kit.color, 0.4);
      if (f.burn > 0 && Math.random() < 0.34) this.particles(f, 1, "#ff8a3c", 0.5);

      // charge gathering at the casting hand
      if (f.state === "ability" && f.phase === "windup" &&
          (f.attack?.type === "magic" || f.attack?.type === "buff")) {
        const charge = clamp(f.stateT / Math.max(0.01, f.attack.windup), 0, 1);
        const hx = sx + f.facing * H * 0.3;
        const hy = sy - H * 0.62;
        const size = (14 + charge * 44) * zoom;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 + charge * 0.45;
        ctx.drawImage(tintedGlow2D(f.kit.glow), hx - size / 2, hy - size / 2, size, size);
        ctx.restore();
        if (Math.random() < 0.5) {
          this.fx.push({
            type: "mote", color: f.kit.color,
            x: f.x + f.facing * 26 * f.scale + rand(-30, 30),
            y: f.y + FIGHTER_H * f.scale * 0.62 + rand(-24, 24),
            vx: -f.facing * rand(40, 140), vy: rand(-40, 60),
            life: 0.28, max: 0.28, size: rand(8, 14),
          });
        }
      }
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
        const glow = tintedGlow2D(s.owner.kit.color);
        const core = tintedGlow2D(s.owner.kit.glow);
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
          ctx.drawImage(tintedGlow2D(p.color), sx - size / 2, sy - size / 2, size, size);
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
      const label = win ? "VICTORY!" : "DEFEAT";
      // the winning word stamps in with a slight overshoot, like a seal
      const stamp = clamp((this.endT - 0.12) * 5, 0, 1);
      const pop = 1 + (1 - stamp) * (1 - stamp) * 0.6;
      ctx.save();
      ctx.translate(this.w / 2, this.h / 2);
      ctx.scale(pop, pop);
      ctx.fillStyle = win ? "#ffd479" : "#ff5f6d";
      ctx.fillText(label, 0, 0);
      ctx.restore();
      ctx.font = "600 14px system-ui";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(
        win ? "Chapter cleared — the gate grinds open" : "You wake at camp, fully healed",
        this.w / 2, this.h / 2 + 30
      );
      ctx.restore();
    }
  }

  window.ChronicleArena = {
    Arena, KITS, kitFor, loadFighterArt,
    /* Preload + decode fighter key art (and pre-tint flash silhouettes)
       before the duel starts, so combat never stutters on a decode. */
    preloadFighters: (urls) => Promise.all((urls || []).map((u) => loadFighterArt(u).promise)),
    setMuted: (v) => { Audio2.muted = v; if (!v) Audio2.ready(); },
    unlockAudio: () => Audio2.ready(),
  };
})();
