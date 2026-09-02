/* ChronicleRift — Arena v4
 * A real-time, landscape, 3D fighting engine.
 *
 * Fighters are low-poly jointed puppets (pelvis, torso, neck, head, two-bone
 * arms and legs, cloth cape and a weapon welded to the hand) rendered with
 * Three.js when WebGL is available, with a full 2D canvas fallback otherwise.
 * Every animation moves real joints: the sword travels with the arm, abilities
 * carry the body across the floor, and hits land only when an active hitbox
 * overlaps a hurtbox.
 *
 * The simulation runs on a fixed 120 Hz step (rendered every frame) so the
 * fight stays smooth even on phones, and attack inputs are buffered so a tap
 * during recover chains into the next swing instead of being dropped.
 */
(() => {
  "use strict";

  const ARENA_HALF = 560;
  const GRAVITY = 1800;
  const FIGHTER_H = 116; // world units tall for a 1.0-scale hero
  const HURT_W = 46;
  const POSE_KEYS = ["head", "torso", "armF", "armB", "legF", "legB", "bob", "rot", "dip", "breath"];

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
    fire:   { armor: "#7a4229", armorHi: "#c07a41", armorLo: "#2e150f", cloth: "#a3391b", steel: "#8a7360" },
    ice:    { armor: "#2f5673", armorHi: "#6f9fc4", armorLo: "#10202c", cloth: "#1d6f92", steel: "#7f95a8" },
    wind:   { armor: "#33654c", armorHi: "#6fb08a", armorLo: "#132a1f", cloth: "#2f7d55", steel: "#8aa08c" },
    arcane: { armor: "#463871", armorHi: "#8474c4", armorLo: "#1b1530", cloth: "#5a3f96", steel: "#8d86a8" },
    shadow: { armor: "#4d2747", armorHi: "#96518a", armorLo: "#1c0e1b", cloth: "#7a1f52", steel: "#a2839a" },
  };
  const skinFor = (el) => SKINS[el] || SKINS.arcane;

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
      this.artFacing = cfg.artFacing || 1; // which way the artwork looks
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
      // skeletal pose (radians, except bob/dip in world units and breath as a scale)
      this.pose = { head: 0, torso: 0, armF: 0, armB: 0, legF: 0, legB: 0, bob: 0, rot: 0, dip: 0, breath: 1 };
      this.target = { ...this.pose };
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
    "bg-ember":  { sky: 0x201009, fog: 0x150b07, ground: 0x181009, accent: 0xff8a3c, mote: 0xffb066, hemiSky: 0xffb27a },
    "bg-frost":  { sky: 0x0a1522, fog: 0x08111c, ground: 0x0d1622, accent: 0x7fd8ff, mote: 0xbfeaff, hemiSky: 0x9fd4ff },
    "bg-arcane": { sky: 0x130d24, fog: 0x0e091a, ground: 0x131020, accent: 0xb48bff, mote: 0xd0b8ff, hemiSky: 0xb9a4ff },
    "bg-void":   { sky: 0x170a1c, fog: 0x0f0714, ground: 0x130b16, accent: 0xff6ac1, mote: 0xffa8d8, hemiSky: 0xd89adf },
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

      const ground = new T.Mesh(
        new T.CircleGeometry(1500, 48),
        new T.MeshStandardMaterial({ color: 0x181009, roughness: 1, metalness: 0 })
      );
      ground.rotation.x = -Math.PI / 2;
      this.groundMat = ground.material;
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
        new T.LineBasicMaterial({ color: 0x3a4062, transparent: true, opacity: 0.35 })
      );
      grid.position.y = 0.3;
      env.add(grid);

      // distant monoliths and peaks (parallax silhouettes)
      const rockMat = new T.MeshStandardMaterial({ color: 0x141828, roughness: 1 });
      for (let i = 0; i < 9; i += 1) {
        const a = rand(0, Math.PI * 2);
        const r = rand(520, 980);
        const w = rand(34, 90);
        const h = rand(180, 460);
        const rock = new T.Mesh(new T.BoxGeometry(w, h, w * 0.7), rockMat);
        rock.position.set(Math.cos(a) * r, h / 2 - 8, Math.sin(a) * r);
        rock.rotation.y = rand(0, Math.PI);
        env.add(rock);
      }
      for (let i = 0; i < 6; i += 1) {
        const a = rand(0, Math.PI * 2);
        const r = rand(1050, 1450);
        const h = rand(380, 720);
        const peak = new T.Mesh(new T.ConeGeometry(rand(180, 340), h, 5), rockMat);
        peak.position.set(Math.cos(a) * r, h / 2 - 30, Math.sin(a) * r);
        env.add(peak);
      }

      // drifting ambient motes (embers / frost / sparks)
      const COUNT = 110;
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

    setScene(name) {
      if (this.sceneName === name) return;
      this.sceneName = name;
      const env = ENV3D[name] || ENV3D["bg-ember"];
      this.scene.background = new window.THREE.Color(env.sky);
      this.scene.fog.color.set(env.fog);
      this.groundMat.color.set(env.ground);
      this.ringMat.color.set(env.accent);
      this.ring2Mat.color.set(env.accent);
      this.accentLight.color.set(env.accent);
      this.moteMat.color.set(env.mote);
      this.hemi.color.set(env.hemiSky);
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

    makeGhost() {
      const T = window.THREE;
      const m = new T.Mesh(
        new T.CapsuleGeometry(1, 3.2, 3, 10),
        new T.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0,
          blending: T.AdditiveBlending, depthWrite: false,
        })
      );
      m.visible = false;
      this.scene.add(m);
      return { m, life: 0, max: 1, active: false };
    }
    fireGhost(x, color, size, life) {
      for (let i = 0; i < this.ghostPool.length; i += 1) {
        const g = this.ghostPool[i];
        if (!g.active) {
          g.active = true;
          g.life = life; g.max = life;
          // unit capsule is 5.2 tall; scale so the ghost matches the fighter's height
          g.m.position.set(x, size * 0.5, 0);
          g.m.scale.set(size * 0.13, size * 0.19, size * 0.13);
          g.m.material.color.set(color);
          g.m.visible = true;
          return;
        }
      }
    }

    makeShot() {
      const T = window.THREE;
      const core = new T.Sprite(new T.SpriteMaterial({
        map: this.glowTex, color: 0xffffff, transparent: true, opacity: 0.95,
        blending: T.AdditiveBlending, depthWrite: false,
      }));
      const halo = new T.Sprite(new T.SpriteMaterial({
        map: this.glowTex, color: 0xffffff, transparent: true, opacity: 0.5,
        blending: T.AdditiveBlending, depthWrite: false,
      }));
      core.scale.set(20, 20, 1);
      halo.scale.set(52, 52, 1);
      this.scene.add(core, halo);
      return { core, halo, life: 0, active: false };
    }

    /* ---------------- fighter rigs ---------------- */
    buildRig(f) {
      const T = window.THREE;
      const H = FIGHTER_H * f.scale;
      const S = skinFor(f.element);
      const acc = f.kit.color;
      const bulk = f.build === "brute" ? 1.34 : f.build === "beast" ? 1.14 : 1;
      const monster = f.build !== "hero";

      const mats = {
        body: new T.MeshStandardMaterial({ color: S.armor, roughness: 0.55, metalness: 0.35 }),
        hi: new T.MeshStandardMaterial({ color: S.armorHi, roughness: 0.4, metalness: 0.5 }),
        lo: new T.MeshStandardMaterial({ color: S.armorLo, roughness: 0.7, metalness: 0.3 }),
        cloth: new T.MeshStandardMaterial({ color: S.cloth, roughness: 0.95, side: T.DoubleSide }),
        steel: new T.MeshStandardMaterial({ color: S.steel, roughness: 0.3, metalness: 0.85 }),
        eye: new T.MeshStandardMaterial({ color: 0x050508, emissive: acc, emissiveIntensity: 2.4 }),
        accent: new T.MeshStandardMaterial({
          color: acc, emissive: acc, emissiveIntensity: 1.0, roughness: 0.5, metalness: 0.2,
        }),
      };
      const geo = [];

      const root = new T.Group();

      // pelvis
      const pelvisG = new T.BoxGeometry(0.19 * H * bulk, 0.1 * H, 0.15 * H * bulk);
      geo.push(pelvisG);
      const pelvis = new T.Mesh(pelvisG, mats.body);
      pelvis.position.set(0, 0.47 * H, 0);
      root.add(pelvis);

      // legs (front limb on the camera side: local -x)
      const buildLeg = (side) => {
        const hipG = new T.Group();
        hipG.position.set(side * 0.04 * H * bulk, 0.47 * H, 0);
        root.add(hipG);
        const thighG = new T.CapsuleGeometry(0.075 * H * bulk, 0.12 * H, 3, 10);
        geo.push(thighG);
        const thigh = new T.Mesh(thighG, side < 0 ? mats.body : mats.lo);
        thigh.position.set(0, -0.115 * H, 0);
        hipG.add(thigh);
        const kneeG = new T.Group();
        kneeG.position.set(0, -0.225 * H, 0);
        hipG.add(kneeG);
        const shinG = new T.CapsuleGeometry(0.055 * H * bulk, 0.11 * H, 3, 10);
        geo.push(shinG);
        const shin = new T.Mesh(shinG, side < 0 ? mats.body : mats.lo);
        shin.position.set(0, -0.1 * H, 0);
        kneeG.add(shin);
        const footG = new T.BoxGeometry(0.085 * H, 0.05 * H, 0.15 * H);
        geo.push(footG);
        const foot = new T.Mesh(footG, mats.lo);
        foot.position.set(0, -0.208 * H, 0.035 * H);
        kneeG.add(foot);
        return { hipG, kneeG };
      };
      const legF = buildLeg(-1);
      const legB = buildLeg(1);

      // torso
      const torsoG = new T.Group();
      torsoG.position.set(0, 0.5 * H, 0);
      root.add(torsoG);
      const chestG = new T.CapsuleGeometry(0.1 * H * bulk, 0.1 * H, 4, 14);
      geo.push(chestG);
      const chest = new T.Mesh(chestG, mats.body);
      chest.position.set(0, 0.125 * H, 0);
      torsoG.add(chest);
      const plateG = new T.BoxGeometry(0.16 * H * bulk, 0.1 * H, 0.05 * H);
      geo.push(plateG);
      const plate = new T.Mesh(plateG, mats.hi);
      plate.position.set(0, 0.15 * H, 0.062 * H);
      torsoG.add(plate);
      const beltG = new T.BoxGeometry(0.21 * H * bulk, 0.035 * H, 0.16 * H * bulk);
      geo.push(beltG);
      const belt = new T.Mesh(beltG, mats.lo);
      belt.position.set(0, 0.015 * H, 0);
      torsoG.add(belt);
      const sigilG = new T.BoxGeometry(0.045 * H, 0.045 * H, 0.02 * H);
      geo.push(sigilG);
      const sigil = new T.Mesh(sigilG, mats.accent);
      sigil.position.set(0, 0.14 * H, 0.092 * H);
      torsoG.add(sigil);
      const neckG = new T.CapsuleGeometry(0.028 * H, 0.03 * H, 3, 8);
      geo.push(neckG);
      const neck = new T.Mesh(neckG, mats.lo);
      neck.position.set(0, 0.235 * H, 0);
      torsoG.add(neck);

      // head
      const headG = new T.Group();
      headG.position.set(0, 0.27 * H, 0);
      torsoG.add(headG);
      const skullG = new T.SphereGeometry(0.09 * H, 18, 14);
      geo.push(skullG);
      const skull = new T.Mesh(skullG, mats.body);
      skull.scale.set(0.95, 1.1, 1);
      headG.add(skull);
      const faceG = new T.BoxGeometry(0.1 * H, 0.075 * H, 0.05 * H);
      geo.push(faceG);
      const face = new T.Mesh(faceG, mats.hi);
      face.position.set(0, -0.012 * H, 0.068 * H);
      headG.add(face);
      const eyeG = new T.BoxGeometry(0.07 * H, 0.016 * H, 0.02 * H);
      geo.push(eyeG);
      const eye = new T.Mesh(eyeG, mats.eye);
      eye.position.set(0, 0.008 * H, 0.098 * H);
      headG.add(eye);

      const ornaments = [];
      if (monster) {
        // horns
        const hornG = new T.ConeGeometry(0.028 * H, 0.14 * H, 8);
        geo.push(hornG);
        [-1, 1].forEach((s) => {
          const horn = new T.Mesh(hornG, mats.lo);
          horn.position.set(s * 0.055 * H, 0.1 * H, -0.03 * H);
          horn.rotation.set(-0.7, 0, -s * 0.55);
          headG.add(horn);
          ornaments.push(horn);
        });
      } else {
        // hero crest / per-element identity
        if (f.element === "fire") {
          const flameG = new T.ConeGeometry(0.022 * H, 0.13 * H, 7);
          geo.push(flameG);
          [-0.03, 0, 0.03].forEach((x, i) => {
            const fl = new T.Mesh(flameG, mats.accent);
            fl.position.set(x * H, 0.1 + (i === 1 ? 0.02 : 0) * H, -0.02 * H);
            headG.add(fl);
            ornaments.push(fl);
          });
        } else if (f.element === "arcane") {
          const gemG = new T.OctahedronGeometry(0.03 * H, 0);
          geo.push(gemG);
          const gem = new T.Mesh(gemG, mats.accent);
          gem.position.set(0, 0.05 * H, 0.085 * H);
          headG.add(gem);
          ornaments.push(gem);
        } else if (f.element === "shadow") {
          const crestG = new T.ConeGeometry(0.02 * H, 0.16 * H, 6);
          geo.push(crestG);
          [-1, 1].forEach((s) => {
            const cr = new T.Mesh(crestG, mats.accent);
            cr.position.set(s * 0.04 * H, 0.12 * H, -0.01 * H);
            cr.rotation.z = s * 0.5;
            headG.add(cr);
            ornaments.push(cr);
          });
        }
      }

      // arms (front = -x, camera side)
      const buildArm = (side) => {
        const shG = new T.Group();
        shG.position.set(side * 0.078 * H * bulk, 0.2 * H, 0);
        torsoG.add(shG);
        const padG = new T.SphereGeometry(0.062 * H * bulk, 12, 10);
        geo.push(padG);
        const pad = new T.Mesh(padG, side < 0 ? mats.hi : mats.lo);
        pad.scale.set(1, 0.8, 1);
        shG.add(pad);
        const upperG = new T.CapsuleGeometry(0.05 * H * bulk, 0.09 * H, 3, 10);
        geo.push(upperG);
        const upper = new T.Mesh(upperG, side < 0 ? mats.body : mats.lo);
        upper.position.set(0, -0.09 * H, 0);
        shG.add(upper);
        const elG = new T.Group();
        elG.position.set(0, -0.17 * H, 0);
        shG.add(elG);
        const foreG = new T.CapsuleGeometry(0.042 * H * bulk, 0.09 * H, 3, 10);
        geo.push(foreG);
        const fore = new T.Mesh(foreG, side < 0 ? mats.body : mats.lo);
        fore.position.set(0, -0.08 * H, 0);
        elG.add(fore);
        const handG = new T.Group();
        handG.position.set(0, -0.16 * H, 0);
        elG.add(handG);
        const handMeshG = new T.SphereGeometry(0.04 * H, 10, 8);
        geo.push(handMeshG);
        const handMesh = new T.Mesh(handMeshG, mats.lo);
        handG.add(handMesh);
        return { shG, elG, handG };
      };
      const armF = buildArm(-1);
      const armB = buildArm(1);

      // weapons
      const weapon = new T.Group();
      if (f.build === "beast") {
        const clawG = new T.ConeGeometry(0.02 * H, 0.13 * H, 7);
        geo.push(clawG);
        [-0.3, 0, 0.3].forEach((a, i) => {
          const claw = new T.Mesh(clawG, i === 1 ? mats.accent : mats.lo);
          claw.position.set(Math.sin(a) * 0.05 * H, -0.09 * H, Math.cos(a) * 0.05 * H);
          claw.rotation.x = Math.PI + 0.35;
          claw.rotation.z = a;
          weapon.add(claw);
        });
      } else {
        const brutal = f.build === "brute";
        const ws = brutal ? 1.45 : 1;
        const sword = new T.Group();
        sword.rotation.x = 1.15;
        sword.scale.setScalar(ws);
        weapon.add(sword);
        const gripG = new T.CylinderGeometry(0.016 * H, 0.018 * H, 0.08 * H, 8);
        geo.push(gripG);
        const grip = new T.Mesh(gripG, mats.lo);
        grip.position.set(0, 0.02 * H, 0);
        sword.add(grip);
        const pomG = new T.SphereGeometry(0.024 * H, 10, 8);
        geo.push(pomG);
        const pom = new T.Mesh(pomG, mats.accent);
        pom.position.set(0, 0.068 * H, 0);
        sword.add(pom);
        const guardG = new T.BoxGeometry(0.1 * H, 0.022 * H, 0.034 * H);
        geo.push(guardG);
        const guard = new T.Mesh(guardG, mats.hi);
        guard.position.set(0, 0.052 * H, 0);
        sword.add(guard);
        const bladeG = new T.BoxGeometry(0.034 * H, 0.4 * H, 0.011 * H);
        geo.push(bladeG);
        const blade = new T.Mesh(bladeG, mats.steel);
        blade.position.set(0, -0.24 * H, 0);
        sword.add(blade);
        const edgeG = new T.BoxGeometry(0.01 * H, 0.39 * H, 0.018 * H);
        geo.push(edgeG);
        const edge = new T.Mesh(edgeG, mats.accent);
        edge.position.set(0, -0.24 * H, 0);
        sword.add(edge);
        const tipG = new T.ConeGeometry(0.017 * H, 0.07 * H, 4);
        geo.push(tipG);
        const tip = new T.Mesh(tipG, mats.steel);
        tip.position.set(0, -0.485 * H, 0);
        tip.rotation.x = Math.PI;
        sword.add(tip);
      }
      armF.handG.add(weapon);

      // ice hero: kite shield on the off hand
      if (f.build === "hero" && f.element === "ice") {
        const shieldG = new T.BoxGeometry(0.15 * H, 0.2 * H, 0.02 * H);
        geo.push(shieldG);
        const shield = new T.Mesh(shieldG, mats.hi);
        shield.position.set(0, -0.07 * H, 0.05 * H);
        armB.handG.add(shield);
        const rimG = new T.BoxGeometry(0.16 * H, 0.21 * H, 0.014 * H);
        geo.push(rimG);
        const rim = new T.Mesh(rimG, mats.accent);
        rim.position.set(0, -0.07 * H, 0.045 * H);
        armB.handG.add(rim);
      }
      // arcane hero: a levitating rune orb
      let orb = null;
      if (f.build === "hero" && f.element === "arcane") {
        const orbG = new T.SphereGeometry(0.05 * H, 14, 12);
        geo.push(orbG);
        orb = new T.Mesh(orbG, mats.accent);
        orb.position.set(0, -0.12 * H, 0.1 * H);
        armB.handG.add(orb);
      }
      // wind hero: fluttering scarf
      const scarf = new T.Group();
      scarf.position.set(0, 0.24 * H, -0.05 * H);
      torsoG.add(scarf);
      const s1G = new T.BoxGeometry(0.055 * H, 0.16 * H, 0.014 * H);
      geo.push(s1G);
      const s1 = new T.Mesh(s1G, mats.cloth);
      s1.position.set(0, -0.08 * H, 0);
      scarf.add(s1);
      const s2G = new T.BoxGeometry(0.05 * H, 0.12 * H, 0.012 * H);
      geo.push(s2G);
      const s2 = new T.Mesh(s2G, mats.cloth);
      s2.position.set(0, -0.17 * H, 0);
      scarf.add(s2);

      // cape
      const capeG = new T.Group();
      capeG.position.set(0, 0.44 * H, -0.07 * H);
      root.add(capeG);
      const c1G = new T.PlaneGeometry(0.2 * H * bulk, 0.24 * H);
      geo.push(c1G);
      const c1 = new T.Mesh(c1G, mats.cloth);
      c1.position.set(0, -0.12 * H, 0);
      capeG.add(c1);
      const c2G = new T.PlaneGeometry(0.24 * H * bulk, 0.2 * H);
      geo.push(c2G);
      const c2 = new T.Mesh(c2G, mats.cloth);
      c2.position.set(0, -0.32 * H, 0);
      c2.rotation.x = 0.18;
      capeG.add(c2);

      // blob shadow
      const blob = new T.Mesh(
        new T.PlaneGeometry(1, 1),
        new T.MeshBasicMaterial({
          map: this.blobTex, transparent: true, opacity: 0.4, depthWrite: false,
        })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.scale.set(0.42 * H, 0.3 * H, 1);
      this.scene.add(blob);

      // hit flash silhouette
      const flashMat = new T.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
      });
      const fBodyG = new T.CapsuleGeometry(0.12 * H * bulk, 0.34 * H, 3, 10);
      const fHeadG = new T.SphereGeometry(0.1 * H, 12, 10);
      const fBody = new T.Mesh(fBodyG, flashMat);
      fBody.position.set(0, 0.55 * H, 0);
      const fHead = new T.Mesh(fHeadG, flashMat);
      fHead.position.set(0, 0.78 * H, 0);
      fBody.visible = false;
      fHead.visible = false;
      this.scene.add(fBody, fHead);

      // ward bubble
      const wardMat = new T.MeshBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.1, side: T.DoubleSide, depthWrite: false,
      });
      const ward = new T.Mesh(new T.SphereGeometry(0.52 * H, 20, 16), wardMat);
      ward.position.set(0, 0.55 * H, 0);
      ward.visible = false;
      this.scene.add(ward);

      this.scene.add(root);
      const rig = {
        f, H, bulk, root, blob, flashMat, fBody, fHead, ward, wardMat,
        torsoG, headG, ornaments, armF, armB, legF, legB, capeG, scarf, orb,
        mats, geo,
      };
      rig.dispose = () => {
        this.scene.remove(root, blob, fBody, fHead, ward);
        geo.forEach((g) => g.dispose());
        Object.values(mats).forEach((m) => m.dispose());
        flashMat.dispose();
        wardMat.dispose();
      };
      return rig;
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
      const T = window.THREE;
      const rig = this.rigFor(f);
      const p = f.pose;
      const H = rig.H;
      void dt;

      rig.root.position.set(f.x, f.y + p.bob - p.dip * 0.35, 0);
      const baseY = f.facing > 0 ? Math.PI / 2 : -Math.PI / 2;
      const spinning = f.state === "ability" && f.attack && (f.attack.hits || 1) > 1 && f.phase === "active";
      rig.root.rotation.y = baseY + (spinning ? p.rot : 0);
      // knock/dead: the whole body tips back; otherwise upright
      rig.root.rotation.x = spinning ? 0 : (f.state === "dead" || f.state === "knock" ? p.rot : 0);

      const hunch = f.build === "brute" ? 0.2 : f.build === "beast" ? 0.26 : 0;
      rig.torsoG.rotation.x = -(p.torso + hunch);
      rig.torsoG.scale.y = p.breath;
      rig.headG.rotation.x = -p.head;

      const bendF = clamp(0.78 - Math.abs(p.armF) * 0.42, 0.08, 1.05);
      const bendB = clamp(0.62 - Math.abs(p.armB) * 0.42, 0.08, 1.05);
      rig.armF.shG.rotation.x = -p.armF;
      rig.armF.elG.rotation.x = -bendF;
      rig.armB.shG.rotation.x = -p.armB;
      rig.armB.elG.rotation.x = -bendB;

      const bendLF = clamp(0.16 + Math.max(0, -p.legF) * 0.95 + p.dip * 0.014, 0.05, 1.35);
      const bendLB = clamp(0.16 + Math.max(0, -p.legB) * 0.95 + p.dip * 0.014, 0.05, 1.35);
      rig.legF.hipG.rotation.x = -p.legF;
      rig.legF.kneeG.rotation.x = bendLF;
      rig.legB.hipG.rotation.x = -p.legB;
      rig.legB.kneeG.rotation.x = bendLB;

      // cloth
      const run = clamp((f.vx * f.facing) / 340, -1.2, 1.2);
      const flap = Math.sin(f.animT * 6) * 0.1;
      rig.capeG.rotation.x = 0.35 + run * 0.75 + flap * 0.5;
      rig.scarf.rotation.x = 0.5 + run * 0.9 + flap * 0.8;
      rig.scarf.rotation.z = Math.sin(f.animT * 4.5) * 0.12 + run * 0.3;
      if (rig.orb) {
        rig.orb.position.y = -0.12 * H + Math.sin(f.animT * 3.2) * 0.03 * H;
        rig.orb.rotation.y = f.animT * 1.6;
      }
      // ornament pulse (flames/gems breathe)
      for (let i = 0; i < rig.ornaments.length; i += 1) {
        rig.ornaments[i].scale.setScalar(1 + Math.sin(f.animT * 5 + i) * 0.08);
      }

      // blob shadow
      const lift = clamp(1 - f.y / 400, 0.35, 1);
      rig.blob.position.set(f.x, 0.4, 0);
      rig.blob.scale.set(0.42 * H * lift, 0.3 * H * lift, 1);
      rig.blob.material.opacity = 0.42 * lift;

      // hit flash / freeze coat
      const frozen = f.freeze > 0;
      const fo = Math.max(f.flash * 0.75, frozen ? 0.32 : 0);
      rig.flashMat.opacity = fo;
      rig.fBody.visible = fo > 0.02;
      rig.fHead.visible = fo > 0.02;
      rig.flashMat.color.set(frozen ? 0x9fe4ff : 0xffffff);

      // ward bubble
      const hasWard = f.shield > 0;
      rig.ward.visible = hasWard;
      if (hasWard) {
        const pulse = 1 + Math.sin(f.animT * 8) * 0.04;
        rig.ward.scale.setScalar(pulse);
        rig.wardMat.opacity = 0.09 + Math.sin(f.animT * 8) * 0.03;
      }

      // charge glow at the real hand joint
      if (f.state === "ability" && f.phase === "windup" &&
          (f.attack && (f.attack.type === "magic" || f.attack.type === "buff"))) {
        const charge = clamp(f.stateT / Math.max(0.01, f.attack.windup), 0, 1);
        rig.armF.handG.getWorldPosition(this.tmp);
        let sp = this.charge.get(f);
        if (!sp) {
          sp = new T.Sprite(new T.SpriteMaterial({
            map: this.glowTex, color: f.kit.glow, transparent: true, opacity: 0.8,
            blending: T.AdditiveBlending, depthWrite: false,
          }));
          this.scene.add(sp);
          this.charge.set(f, sp);
          this.chargeSprites.push(sp);
        }
        sp.visible = true;
        sp.position.copy(this.tmp);
        const s = (10 + charge * 34) * f.scale;
        sp.scale.set(s, s, 1);
        sp.material.opacity = 0.5 + charge * 0.5;
        if (Math.random() < 0.4) {
          this.particles.spawn(
            this.tmp.x + rand(-8, 8), this.tmp.y + rand(-8, 8), f.kit.color,
            rand(-60, 60), rand(-40, 80), 0.3
          );
        }
      } else if (this.charge.has(f)) {
        this.charge.get(f).visible = false;
      }

      // blade trail while the swing is active
      const swing = (f.state === "attack" || f.state === "ability") && f.phase === "active" &&
        f.attack && f.attack.type !== "magic" && f.attack.type !== "buff";
      if (swing) {
        const a = f.attack;
        const prog = clamp((f.stateT - a.windup) / (a.active || 0.12), 0, 1);
        rig.armF.handG.getWorldPosition(this.tmp);
        const size = (f.build === "brute" ? 1.0 : 0.72) * H;
        let arc = this.trailArc.get(f);
        if (!arc) {
          const m = new T.Mesh(
            new T.RingGeometry(0.5, 0.82, 26, 1, 0, 1.6),
            new T.MeshBasicMaterial({
              color: f.kit.glow, transparent: true, opacity: 0.6, side: T.DoubleSide,
              blending: T.AdditiveBlending, depthWrite: false,
            })
          );
          this.scene.add(m);
          arc = { m };
          this.trailArc.set(f, arc);
          this.trailArcs.push(arc);
        }
        arc.m.visible = true;
        arc.m.position.set(this.tmp.x, this.tmp.y, 18);
        const ang = -p.armF + prog * 1.6;
        arc.m.rotation.z = Math.PI / 2 - ang * f.facing;
        const sc = size * (1.05 - prog * 0.35);
        arc.m.scale.set(sc, sc, 1);
        arc.m.material.opacity = 0.55 * (1 - prog);
      } else if (this.trailArc.has(f)) {
        this.trailArc.get(f).m.visible = false;
      }
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
      this.camera.position.set(this.cam.x + sx, this.cam.y + sy, this.cam.dist);
      this.camera.lookAt(this.cam.x, 58, 0);
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
        if (this.banner.firstChild.textContent !== (win ? "K.O.!" : "DEFEAT")) {
          this.banner.firstChild.textContent = win ? "K.O.!" : "DEFEAT";
          this.banner.lastChild.textContent = win ? "Chapter cleared" : "You wake at camp, fully healed";
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
      this.updateRig(a.player, dt);
      this.updateRig(a.enemy, dt);

      // ambient motes drift
      const pos = this.moteGeo.attributes.position.array;
      const t = a.time;
      for (let i = 0; i < this.moteData.length; i += 1) {
        const m = this.moteData[i];
        pos[i * 3 + 1] += m.vy * (dt || 1 / 60);
        pos[i * 3] += Math.sin(t * 0.6 + m.ph) * 0.3;
        if (pos[i * 3 + 1] > 360) pos[i * 3 + 1] = 0;
      }
      this.moteGeo.attributes.position.needsUpdate = true;

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
            this.fireGhost(gh.x, f.kit.color, FIGHTER_H * f.scale, gh.max);
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
      this.renderer.render(this.scene, this.camera);
    }

    resize(w, h) {
      this.a.w = w;
      this.a.h = h;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      this.renderer.setPixelRatio(dpr);
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
  function bone(ctx, a, b, w0, w1) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath();
    ctx.arc(a.x, a.y, w0, ang + Math.PI / 2, ang - Math.PI / 2);
    ctx.arc(b.x, b.y, w1, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }

  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  /* Build the whole skeleton for the current pose (local units, feet at 0,0). */
  function skeleton(f, H) {
    const p = f.pose;
    const brute = f.build === "brute";
    const beast = f.build === "beast";
    const bulk = brute ? 1.34 : beast ? 1.14 : 1;
    const t = p.torso + (brute ? 0.2 : beast ? 0.26 : 0); // monsters hunch forward
    const up = Math.PI - t;
    const fw = { x: Math.cos(t), y: Math.sin(t) };

    const hip = { x: 0, y: -0.47 * H };
    const chest = jointAt(hip, up, 0.21 * H * p.breath);
    const neck = jointAt(chest, up, 0.06 * H);
    const head = jointAt(neck, Math.PI - t - p.head, 0.105 * H);

    const shF = { x: chest.x + fw.x * 0.05 * H * bulk, y: chest.y + fw.y * 0.05 * H - 0.01 * H };
    const shB = { x: chest.x - fw.x * 0.05 * H * bulk, y: chest.y - fw.y * 0.05 * H - 0.012 * H };
    const hipF = { x: hip.x + fw.x * 0.035 * H, y: hip.y + fw.y * 0.035 * H };
    const hipB = { x: hip.x - fw.x * 0.035 * H, y: hip.y - fw.y * 0.035 * H };

    const arm = (sh, ang, back) => {
      const bend = clamp((back ? 0.62 : 0.78) - Math.abs(ang) * 0.42, 0.08, 1.05);
      const elbow = jointAt(sh, ang, 0.165 * H);
      const hand = jointAt(elbow, ang + bend, 0.155 * H);
      return { sh, elbow, hand, wrist: ang + bend };
    };
    const leg = (hp, ang) => {
      const bend = clamp(0.16 + Math.max(0, -ang) * 0.95 + p.dip * 0.014, 0.05, 1.35);
      const knee = jointAt(hp, ang, 0.215 * H);
      const ankle = jointAt(knee, ang - bend, 0.2 * H);
      return { hip: hp, knee, ankle, ang: ang - bend };
    };

    return {
      bulk, t, fw, hip, chest, neck, head,
      armF: arm(shF, p.armF, false),
      armB: arm(shB, p.armB, true),
      legF: leg(hipF, p.legF),
      legB: leg(hipB, p.legB),
    };
  }

  /* a limb with a cylindrical highlight down its lit side */
  function litBone(ctx, p0, p1, w0, w1, base, hi, tint) {
    ctx.fillStyle = tint || base;
    bone(ctx, p0, p1, w0, w1);
    if (tint) return;
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len, ny = dx / len;
    if (nx < 0) { nx = -nx; ny = -ny; }
    ctx.fillStyle = hi;
    bone(ctx,
      { x: p0.x + nx * w0 * 0.34, y: p0.y + ny * w0 * 0.34 },
      { x: p1.x + nx * w1 * 0.34, y: p1.y + ny * w1 * 0.34 },
      w0 * 0.42, w1 * 0.42);
  }

  function drawWeapon2D(ctx, f, sk, H, tint) {
    const S = skinFor(f.element);
    const acc = f.kit.color;
    const hand = sk.armF.hand;
    const beast = f.build === "beast";
    const brute = f.build === "brute";

    if (beast) {
      ctx.fillStyle = tint || S.steel;
      for (let i = -1; i <= 1; i += 1) {
        const a = sk.armF.wrist + 0.3 + i * 0.34;
        const mid = jointAt(hand, a, 0.07 * H);
        const tip = jointAt(mid, a + 0.5, 0.09 * H);
        bone(ctx, hand, mid, 0.022 * H, 0.014 * H);
        bone(ctx, mid, tip, 0.014 * H, 0.003 * H);
      }
      if (!tint) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = acc;
        bone(ctx, hand, jointAt(hand, sk.armF.wrist + 0.3, 0.14 * H), 0.02 * H, 0.004 * H);
        ctx.restore();
      }
      return;
    }

    const len = (brute ? 0.68 : 0.5) * H;
    const wide = (brute ? 0.055 : 0.036) * H;
    const a = sk.armF.wrist - 1.15;
    const tip = jointAt(hand, a, len);
    const neck = jointAt(hand, a, len * 0.82);
    const butt = jointAt(hand, a + Math.PI, 0.07 * H);
    const guardA = jointAt(hand, a + Math.PI / 2, 0.062 * H);
    const guardB = jointAt(hand, a - Math.PI / 2, 0.062 * H);

    ctx.fillStyle = tint || S.armorLo;
    bone(ctx, butt, hand, 0.02 * H, 0.017 * H); // grip
    ctx.fillStyle = tint || acc;
    ctx.beginPath();
    ctx.arc(butt.x, butt.y, 0.026 * H, 0, Math.PI * 2);
    ctx.fill(); // pommel
    bone(ctx, guardA, guardB, 0.016 * H, 0.016 * H); // crossguard
    // blade: wide body then a point
    ctx.fillStyle = tint || S.steel;
    bone(ctx, hand, neck, wide, wide * 0.8);
    bone(ctx, neck, tip, wide * 0.8, 0.004 * H);
    if (!tint) {
      ctx.fillStyle = S.armorLo;
      bone(ctx, jointAt(hand, a, len * 0.1), neck, wide * 0.2, wide * 0.14); // fuller
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = acc;
      bone(ctx, jointAt(hand, a, len * 0.12), tip, wide * 0.55, 0.004 * H);
      ctx.restore();
    }
  }

  function drawCape2D(ctx, f, sk, H, tint) {
    const S = skinFor(f.element);
    const run = clamp((f.vx * f.facing) / 340, -1.2, 1.2);
    const flap = Math.sin(f.animT * 6) * 0.1;
    const root = { x: sk.chest.x - sk.fw.x * 0.075 * H, y: sk.chest.y - sk.fw.y * 0.075 * H };
    const a0 = -0.3 - run * 0.85 - f.pose.bob * 0.012 + flap * 0.4;
    const a1 = a0 - 0.24 - run * 0.35 + flap;
    const a2 = a1 - 0.2 - run * 0.3 + flap * 1.4;
    const p1 = jointAt(root, a0, 0.2 * H);
    const p2 = jointAt(p1, a1, 0.18 * H);
    const p3 = jointAt(p2, a2, 0.15 * H);
    ctx.fillStyle = tint || S.cloth;
    bone(ctx, root, p1, 0.05 * H, 0.085 * H);
    bone(ctx, p1, p2, 0.085 * H, 0.075 * H);
    bone(ctx, p2, p3, 0.075 * H, 0.03 * H);
    if (!tint) {
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      bone(ctx, p1, p3, 0.03 * H, 0.02 * H); // inner fold
    }
  }

  function drawHead2D(ctx, f, sk, H, tint) {
    const S = skinFor(f.element);
    const acc = f.kit.color;
    const ang = sk.t + f.pose.head;
    const monster = f.build !== "hero";
    ctx.save();
    ctx.translate(sk.head.x, sk.head.y);
    ctx.rotate(-ang);
    const r = 0.095 * H;
    // helmet dome
    ctx.fillStyle = tint || S.armor;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.95, r * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!tint) {
      ctx.fillStyle = S.armorHi;
      ctx.beginPath();
      ctx.ellipse(r * 0.18, -r * 0.3, r * 0.6, r * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // faceplate / muzzle pushed toward the enemy
    ctx.fillStyle = tint || S.armorLo;
    poly(ctx, [[r * 0.2, -r * 0.1], [r * 1.45, r * 0.35], [r * 1.2, r * 0.72], [r * 0.15, r * 0.85]]);
    if (monster) {
      ctx.fillStyle = tint || S.armorHi;
      poly(ctx, [[-r * 0.15, -r * 0.75], [-r * 1.35, -r * 2.15], [-r * 0.75, -r * 2.0], [r * 0.1, -r * 1.0]]);
      poly(ctx, [[r * 0.5, -r * 0.7], [r * 1.15, -r * 2.1], [r * 0.62, -r * 1.95], [r * 0.85, -r * 0.5]]);
    } else {
      ctx.fillStyle = tint || acc;
      poly(ctx, [[-r * 0.6, -r * 0.75], [-r * 1.25, -r * 1.55], [-r * 0.05, -r * 1.15], [r * 0.35, -r * 0.8]]); // crest
      ctx.fillStyle = tint || S.armorHi;
      poly(ctx, [[-r * 0.2, -r * 0.95], [r * 0.85, -r * 0.55], [r * 0.75, -r * 0.2], [-r * 0.2, -r * 0.55]]);
    }
    if (!tint) {
      // glowing eye slit
      ctx.fillStyle = acc;
      ctx.beginPath();
      ctx.ellipse(r * 0.55, r * 0.14, r * 0.34, r * 0.13, 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* Draw the complete 2D fighter. `tint` flattens everything to one colour
     (used for the damage flash and dash after-images). */
  function drawPuppet2D(ctx, f, H, tint) {
    const S = skinFor(f.element);
    const sk = skeleton(f, H);
    const b = sk.bulk;
    const lo = tint || S.armorLo;

    // --- limbs behind the body (darker, no highlight)
    ctx.fillStyle = lo;
    bone(ctx, sk.armB.sh, sk.armB.elbow, 0.05 * H * b, 0.04 * H * b);
    bone(ctx, sk.armB.elbow, sk.armB.hand, 0.04 * H * b, 0.031 * H * b);
    bone(ctx, sk.legB.hip, sk.legB.knee, 0.072 * H * b, 0.052 * H * b);
    bone(ctx, sk.legB.knee, sk.legB.ankle, 0.052 * H * b, 0.038 * H * b);
    bone(ctx, sk.legB.ankle, jointAt(sk.legB.ankle, Math.PI / 2 - 0.1, 0.085 * H), 0.036 * H, 0.026 * H);

    drawCape2D(ctx, f, sk, H, tint);

    // --- front leg with boot
    litBone(ctx, sk.legF.hip, sk.legF.knee, 0.078 * H * b, 0.055 * H * b, S.armor, S.armorHi, tint);
    litBone(ctx, sk.legF.knee, sk.legF.ankle, 0.055 * H * b, 0.04 * H * b, S.armor, S.armorHi, tint);
    ctx.fillStyle = tint || S.armorLo;
    bone(ctx, sk.legF.ankle, jointAt(sk.legF.ankle, Math.PI / 2 - 0.1, 0.095 * H), 0.04 * H, 0.028 * H);
    ctx.fillStyle = tint || S.armorHi;
    bone(ctx, sk.legF.knee, jointAt(sk.legF.knee, sk.legF.ang, 0.022 * H), 0.045 * H * b, 0.036 * H * b); // knee plate

    // --- torso
    litBone(ctx, sk.hip, sk.chest, 0.088 * H * b, 0.108 * H * b, S.armor, S.armorHi, tint);
    ctx.fillStyle = tint || S.armorLo;
    bone(ctx, sk.chest, sk.neck, 0.05 * H, 0.036 * H); // neck
    if (!tint) {
      // chest sigil + belt
      ctx.fillStyle = f.kit.color;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(sk.chest.x + sk.fw.x * 0.025 * H, sk.chest.y + 0.035 * H, 0.022 * H, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = S.armorLo;
      bone(ctx, jointAt(sk.hip, Math.PI / 2 - sk.t, 0.05 * H * b), jointAt(sk.hip, -Math.PI / 2 - sk.t, 0.05 * H * b), 0.02 * H, 0.02 * H); // belt
    }

    drawHead2D(ctx, f, sk, H, tint);

    // --- weapon arm on top so the swing always reads
    litBone(ctx, sk.armF.sh, sk.armF.elbow, 0.053 * H * b, 0.042 * H * b, S.armor, S.armorHi, tint);
    litBone(ctx, sk.armF.elbow, sk.armF.hand, 0.042 * H * b, 0.033 * H * b, S.armor, S.armorHi, tint);
    ctx.fillStyle = tint || S.armorHi;
    ctx.beginPath();
    ctx.arc(sk.armF.sh.x, sk.armF.sh.y - 0.008 * H, 0.056 * H * b, 0, Math.PI * 2);
    ctx.fill(); // pauldron
    if (!tint) {
      ctx.fillStyle = S.armorLo;
      ctx.beginPath();
      ctx.arc(sk.armF.sh.x + 0.014 * H, sk.armF.sh.y + 0.016 * H, 0.042 * H * b, 0, Math.PI * 2);
      ctx.fill();
    }
    drawWeapon2D(ctx, f, sk, H, tint);
    return sk;
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
      if (a.sceneName === name) return;
      a.sceneName = name;
      a.sceneReady = false;
      const img = new Image();
      img.onload = () => {
        a.sceneImg = img;
        a.sceneReady = true;
      };
      img.src = `./art/${name}.jpg`;
    }
    render() {
      this.a.draw2D();
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
      this.sceneReady = false;
      this.w = 640;
      this.h = 360;
      this.dpr = 1;
      this.groundYpx = this.h * 0.88;

      // pick the renderer: 3D when WebGL + Three are available, 2D otherwise
      this.use3D = false;
      if (typeof window.THREE !== "undefined" && window.THREE.WebGLRenderer) {
        try {
          this.r = new Renderer3D(this);
          this.use3D = true;
        } catch (err) {
          this.use3D = false;
        }
      }
      if (!this.use3D) {
        this.ctx = this.canvas.getContext("2d", { alpha: false });
        this.r = new Renderer2D(this);
      }
    }

    setScene(name) {
      this.scene = name;
      this.r.setScene(name);
    }

    setFighters(playerCfg, enemyCfg) {
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
        y: FIGHTER_H * owner.scale * 0.55,
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
      this.slowmo = 0.32; // the last blow lands in slow motion
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
        if (spec.type === "heavy") { this.addShake(spec.shake || 8); SFX.whoosh(); }
      }
    }

    /* ---------------- update ---------------- */
    update(dt) {
      if (this.hitStop > 0) { this.hitStop -= dt; dt *= 0.14; }
      if (this.over && this.slowmo < 1) this.slowmo = approach(this.slowmo, 1, 1.4, dt);
      if (this.over) dt *= this.slowmo;
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

      f.stamina = Math.min(f.maxStamina, f.stamina + (f.busy ? 7 : 18) * dt);

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
        if (f.stateT > 0.24) f.state = "idle";
      } else if (f.state === "knock") {
        if (f.y <= 0 && f.stateT > 0.45) f.state = "idle";
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
      let rate = 13;
      const base = () => {
        g.head = 0; g.torso = 0; g.armF = 0; g.armB = 0; g.legF = 0; g.legB = 0;
        g.bob = 0; g.rot = 0; g.dip = 0; g.breath = 1;
      };
      const a = f.attack || {};
      const phaseT = f.stateT;

      switch (f.state) {
        case "idle": {
          base();
          // breathing: chest expands, shoulders lift, head drifts, weapon sways
          const br = Math.sin(t * 2.0);
          g.breath = 1 + br * 0.026;
          g.bob = br * 2.2;
          g.head = br * 0.045 + Math.sin(t * 0.7) * 0.03;
          g.torso = br * 0.022;
          g.armF = -1.36 + Math.sin(t * 2.0 + 0.6) * 0.07;
          g.armB = 0.05 + Math.sin(t * 2.0 + 1.1) * 0.07;
          g.legF = Math.sin(t * 2.0) * 0.012;
          g.legB = -Math.sin(t * 2.0) * 0.012;
          rate = 6;
          break;
        }
        case "walk": {
          base();
          const dirSign = f.vx * f.facing > 0 ? 1 : -1;
          const w = t * 10.5 * dirSign;
          g.legF = Math.sin(w) * 0.62;
          g.legB = -Math.sin(w) * 0.62;
          g.armF = -1.2 - Math.sin(w) * 0.25;
          g.armB = Math.sin(w) * 0.5;
          g.bob = Math.abs(Math.sin(w)) * 5.5;
          g.torso = 0.05 * dirSign + Math.sin(w * 2) * 0.02;
          g.head = -0.04 * dirSign;
          g.breath = 1 + Math.sin(t * 3.2) * 0.016;
          rate = 15;
          break;
        }
        case "attack": {
          base();
          rate = 30;
          if (f.phase === "windup") {
            g.armF = -1.45; g.armB = 0.5; g.torso = -0.16; g.head = -0.08;
            g.legB = -0.2; g.legF = 0.12; g.dip = 2;
          } else if (f.phase === "active") {
            g.armF = 1.35; g.armB = -0.55; g.torso = 0.3; g.head = 0.14;
            g.legF = 0.55; g.legB = -0.42; g.dip = 4; g.bob = -2;
          } else {
            g.armF = -0.35; g.armB = -0.15; g.torso = 0.12; g.legF = 0.2; g.legB = -0.14;
          }
          break;
        }
        case "ability": {
          base();
          rate = 26;
          const kind = a.type;
          if (kind === "heavy" && (a.hits || 1) > 1) {
            // cyclone: the whole body spins through the swing
            if (f.phase === "windup") { g.torso = -0.3; g.armF = -1.6; g.armB = 1.2; g.dip = 8; }
            else if (f.phase === "active") {
              g.rot = -Math.PI * 2 * ((phaseT - a.windup) / Math.max(0.01, a.active));
              g.armF = 1.5; g.armB = -1.5; g.legF = 0.7; g.legB = -0.7; g.bob = 6;
            } else { g.armF = 0.4; g.legF = 0.2; }
            rate = 34;
          } else if (kind === "heavy") {
            if (f.phase === "windup") {
              g.armF = -2.6; g.armB = -1.2; g.torso = -0.42; g.head = -0.24;
              g.legB = -0.55; g.legF = 0.18; g.dip = 12;
            } else if (f.phase === "active") {
              g.armF = 1.75; g.armB = -0.9; g.torso = 0.52; g.head = 0.3;
              g.legF = 0.85; g.legB = -0.6; g.dip = 16; g.bob = -4;
            } else {
              g.armF = 0.9; g.torso = 0.24; g.legF = 0.4; g.legB = -0.3; g.dip = 9;
            }
          } else if (kind === "magic") {
            if (f.phase === "windup") {
              g.armF = -1.95 + Math.sin(t * 22) * 0.05; g.armB = -1.6;
              g.torso = -0.2; g.head = -0.18; g.dip = 5; g.legB = -0.22;
              g.breath = 1.03;
            } else if (f.phase === "active") {
              g.armF = -0.55; g.armB = -0.35; g.torso = 0.28; g.head = 0.12;
              g.legF = 0.4; g.legB = -0.3; g.dip = 2;
            } else {
              g.armF = -0.2; g.torso = 0.1; g.legF = 0.15;
            }
          } else { // buff / ward
            if (f.phase === "windup") { g.armF = -1.5; g.armB = -1.5; g.torso = -0.12; g.dip = 6; }
            else { g.armF = -1.1; g.armB = -1.1; g.bob = 5; g.breath = 1.05; g.head = -0.16; }
          }
          break;
        }
        case "dash": {
          base();
          g.torso = 0.34; g.head = 0.1; g.armF = -0.9; g.armB = 1.25;
          g.legF = 0.95; g.legB = -0.85; g.dip = 8; g.rot = 0.1;
          rate = 26;
          break;
        }
        case "hurt": {
          base();
          g.torso = -0.34; g.head = -0.42; g.armF = -0.7; g.armB = -0.95;
          g.legB = -0.35; g.legF = 0.18; g.dip = 6;
          rate = 32;
          break;
        }
        case "knock": {
          base();
          g.rot = -0.55 - Math.min(0.7, f.stateT * 1.4);
          g.torso = -0.5; g.head = -0.6; g.armF = -1.5; g.armB = -1.8;
          g.legF = -0.6; g.legB = 0.5;
          rate = 18;
          break;
        }
        case "dead": {
          base();
          g.rot = -1.45; g.torso = -0.28; g.head = -0.5;
          g.armF = -1.2; g.armB = -1.4; g.legF = -0.5; g.legB = 0.35; g.dip = 6;
          rate = 5;
          break;
        }
        case "victory": {
          base();
          g.armF = -2.1 + Math.sin(t * 3.6) * 0.12;
          g.armB = -1.4 + Math.sin(t * 3.6 + 0.5) * 0.1;
          g.bob = Math.abs(Math.sin(t * 3.6)) * 10;
          g.head = -0.12; g.breath = 1 + Math.sin(t * 3.6) * 0.04;
          rate = 9;
          break;
        }
        default:
          base();
      }

      const k = 1 - Math.exp(-rate * dt);
      const p = f.pose;
      for (const key of POSE_KEYS) p[key] = lerp(p[key], g[key], k);
    }

    /* ================================================================ *\
     * drawing (2D fallback path — the 3D renderer owns its own scene)
     * ================================================================ */
    draw() {
      this.r.render();
    }

    draw2D() {
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
      ctx.ellipse(sx, gy, 30 * f.scale * this.cam.zoom * lift, 8 * f.scale * this.cam.zoom * lift, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawFighter(ctx, f) {
      const zoom = this.cam.zoom;
      const [sx, sy] = this.project(f.x, f.y);
      const p = f.pose;
      const H = FIGHTER_H * f.scale * zoom;
      const alpha = f.dead ? clamp(1 - f.stateT * 0.32, 0, 1) : 1;

      // dash after-images: the same puppet, flattened to the element colour
      if (f.ghosts.length) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        f.ghosts.forEach((gh) => {
          const [gx, gy] = this.project(gh.x, f.y);
          ctx.save();
          ctx.globalAlpha = (gh.life / gh.max) * 0.3 * alpha;
          ctx.translate(gx, gy - p.bob * zoom);
          ctx.scale(f.facing, 1);
          drawPuppet2D(ctx, f, H, f.kit.color);
          ctx.restore();
        });
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(sx, sy + p.dip * zoom * 0.35);
      ctx.scale(f.facing, 1);
      if (p.rot) {
        ctx.translate(0, -H * 0.45);
        ctx.rotate(p.rot);
        ctx.translate(0, H * 0.45);
      }
      ctx.translate(0, -p.bob * zoom);

      const sk = drawPuppet2D(ctx, f, H, null);

      // white damage flash / freeze coat, over the exact same silhouette
      if (f.flash > 0.02 || f.freeze > 0) {
        ctx.save();
        ctx.globalAlpha = alpha * Math.max(f.flash * 0.72, f.freeze > 0 ? 0.32 : 0);
        drawPuppet2D(ctx, f, H, f.freeze > 0 ? "#9fe4ff" : "#ffffff");
        ctx.restore();
      }
      ctx.restore();

      // ward bubble
      if (f.shield > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.28 + Math.sin(f.animT * 8) * 0.07;
        ctx.strokeStyle = "#7fd8ff";
        ctx.lineWidth = 3 * zoom;
        ctx.beginPath();
        ctx.ellipse(sx, sy - H * 0.5, H * 0.38, H * 0.58, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (f.empower > 0 && Math.random() < 0.5) this.particles(f, 1, f.kit.color, 0.4);

      // charge gathering in the casting hand — tracked to the real hand joint
      if (f.state === "ability" && f.phase === "windup" &&
          (f.attack?.type === "magic" || f.attack?.type === "buff")) {
        const charge = clamp(f.stateT / Math.max(0.01, f.attack.windup), 0, 1);
        const hx = sx + sk.armF.hand.x * f.facing;
        const hy = sy + sk.armF.hand.y - p.bob * zoom;
        const size = (14 + charge * 42) * zoom * f.scale;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 + charge * 0.45;
        ctx.drawImage(tintedGlow2D(f.kit.glow), hx - size / 2, hy - size / 2, size, size);
        ctx.restore();
        if (Math.random() < 0.45) {
          this.fx.push({
            type: "mote", color: f.kit.color,
            x: f.x + f.facing * 26 * f.scale + rand(-30, 30),
            y: f.y + FIGHTER_H * f.scale * 0.62 + rand(-24, 24),
            vx: -f.facing * rand(40, 140), vy: rand(-40, 60),
            life: 0.28, max: 0.28, size: rand(8, 14),
          });
        }
      }

      // the blade leaves a trail through its actual swing arc
      if ((f.state === "attack" || f.state === "ability") && f.phase === "active" &&
          f.attack && f.attack.type !== "magic" && f.attack.type !== "buff") {
        const prog = clamp((f.stateT - f.attack.windup) / (f.attack.active || 0.12), 0, 1);
        const wrist = sk.armF.wrist - 0.5;
        const tipL = (f.build === "brute" ? 0.78 : 0.58) * H;
        const hx = sk.armF.hand.x, hy = sk.armF.hand.y;
        ctx.save();
        ctx.translate(sx, sy - p.bob * zoom);
        ctx.scale(f.facing, 1);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 * (1 - prog);
        ctx.strokeStyle = f.kit.glow;
        ctx.lineWidth = 7 * zoom * f.scale;
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i <= 6; i += 1) {
          const a = wrist + (i / 6) * 1.5 * (1 - prog);
          const px = hx + Math.sin(a) * tipL;
          const py = hy + Math.cos(a) * tipL;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (f.burn > 0 && Math.random() < 0.3) this.particles(f, 1, "#ff8a3c", 0.5);
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
      ctx.fillStyle = win ? "#ffd479" : "#ff5f6d";
      ctx.fillText(win ? "K.O.!" : "DEFEAT", this.w / 2, this.h / 2);
      ctx.font = "600 14px system-ui";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(win ? "Chapter cleared" : "You wake at camp, fully healed", this.w / 2, this.h / 2 + 30);
      ctx.restore();
    }
  }

  window.ChronicleArena = {
    Arena, KITS, kitFor,
    setMuted: (v) => { Audio2.muted = v; if (!v) Audio2.ready(); },
    unlockAudio: () => Audio2.ready(),
  };
})();
