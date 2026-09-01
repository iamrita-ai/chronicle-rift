/* ChronicleRift — Arena
 * A real-time 2.5D side-view fighting engine.
 *
 * Nothing here is a static image: both fighters are articulated, procedurally
 * animated game objects (skeleton + weapon + cape) simulated in a world with
 * depth, velocity, hitboxes, hurtboxes, projectiles, knockback and hitstop.
 * Damage is only ever applied when an active hitbox physically overlaps a
 * hurtbox — never because an animation played.
 */
(() => {
  "use strict";

  /* ================================================================== *
   * constants
   * ================================================================== */
  const ARENA_HALF = 620; // world units from centre to wall
  const DEPTH = 78; // +/- depth (the 2.5D lane)
  const GRAVITY = 1500;
  const FIGHTER_H = 150;
  const HURT_W = 54;
  const HURT_D = 40;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const approach = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

  /* ================================================================== *
   * element kits — every character's fighting style
   * ================================================================== */
  const KITS = {
    fire: {
      color: "#ff8a3c",
      glow: "#ffd479",
      basic: { name: "Ember Slash", mul: 1.0, range: 96, knock: 120, type: "slash", stamina: 9 },
      abilities: [
        {
          id: "a1", name: "Molten Cleave", icon: "icon-fire-1", cd: 6, stamina: 26, type: "heavy",
          mul: 2.35, range: 118, knock: 460, lift: 210, windup: 0.34, active: 0.14, recover: 0.4,
          shake: 16, desc: "Overhead cleave, huge knockback",
        },
        {
          id: "a2", name: "Cinder Wave", icon: "icon-fire-2", cd: 8, stamina: 22, type: "magic",
          mul: 1.55, speed: 520, burn: 4, windup: 0.28, recover: 0.34, shake: 8,
          desc: "Fire projectile that sets Burning",
        },
        {
          id: "a3", name: "Ember Dash", icon: "icon-fire-3", cd: 7, stamina: 18, type: "dash",
          mul: 1.15, dashSpeed: 900, dashTime: 0.26, iframes: 0.3, burn: 2, knock: 180,
          desc: "Blaze through the enemy, immune while dashing",
        },
      ],
    },
    ice: {
      color: "#7fd8ff",
      glow: "#dff4ff",
      basic: { name: "Rime Jab", mul: 0.92, range: 92, knock: 100, type: "slash", stamina: 8 },
      abilities: [
        {
          id: "a1", name: "Glacier Smash", icon: "icon-ice-1", cd: 6.5, stamina: 28, type: "heavy",
          mul: 2.5, range: 112, knock: 420, lift: 170, windup: 0.4, active: 0.14, recover: 0.44,
          shake: 18, slow: 2.5, desc: "Ground-shattering smash that slows",
        },
        {
          id: "a2", name: "Deep Freeze", icon: "icon-ice-2", cd: 10, stamina: 24, type: "magic",
          mul: 1.25, speed: 430, freeze: 1.4, windup: 0.32, recover: 0.36, shake: 6,
          desc: "Freezes the enemy solid",
        },
        {
          id: "a3", name: "Frost Barrier", icon: "icon-ice-3", cd: 12, stamina: 20, type: "buff",
          shield: 0.55, buffTime: 5, windup: 0.24, recover: 0.3,
          desc: "Halves incoming damage for 5s",
        },
      ],
    },
    wind: {
      color: "#8ef0a8",
      glow: "#dcffe8",
      basic: { name: "Twin Slice", mul: 0.85, range: 90, knock: 90, type: "slash", stamina: 7, hits: 2 },
      abilities: [
        {
          id: "a1", name: "Cyclone Kick", icon: "icon-wind-1", cd: 5.5, stamina: 24, type: "heavy",
          mul: 0.95, hits: 3, range: 104, knock: 260, lift: 120, windup: 0.22, active: 0.34,
          recover: 0.3, shake: 10, desc: "Spinning three-hit whirl",
        },
        {
          id: "a2", name: "Gale Flurry", icon: "icon-wind-2", cd: 7.5, stamina: 21, type: "magic",
          mul: 0.75, volley: 3, speed: 700, windup: 0.2, recover: 0.3, shake: 5,
          desc: "Three razor gusts",
        },
        {
          id: "a3", name: "Blink", icon: "icon-wind-3", cd: 6, stamina: 14, type: "blink",
          iframes: 0.35, hasteTime: 4, haste: 1.5, desc: "Teleport behind the enemy, +50% speed",
        },
      ],
    },
    arcane: {
      color: "#b48bff",
      glow: "#e8dcff",
      basic: { name: "Rune Bolt", mul: 1.05, range: 100, knock: 110, type: "slash", stamina: 9 },
      abilities: [
        {
          id: "a1", name: "Sigil Burst", icon: "icon-fire-1", cd: 7, stamina: 27, type: "heavy",
          mul: 2.15, range: 130, knock: 380, lift: 190, windup: 0.36, active: 0.16, recover: 0.42,
          shake: 15, aoe: true, desc: "Detonates a sigil around you",
        },
        {
          id: "a2", name: "Mind Siphon", icon: "icon-ice-2", cd: 8.5, stamina: 23, type: "magic",
          mul: 1.6, speed: 470, lifesteal: 0.5, pierceDef: true, windup: 0.3, recover: 0.36,
          shake: 7, desc: "Unblockable bolt, heals 50%",
        },
        {
          id: "a3", name: "Rune Ward", icon: "icon-ice-3", cd: 11, stamina: 18, type: "buff",
          shield: 0.62, buffTime: 4.5, regen: 22, windup: 0.24, recover: 0.28,
          desc: "Ward + fast stamina regen",
        },
      ],
    },
    shadow: {
      color: "#ff6ac1",
      glow: "#ffd6f0",
      basic: { name: "Reap", mul: 1.1, range: 104, knock: 120, type: "slash", stamina: 10 },
      abilities: [
        {
          id: "a1", name: "Grave Arc", icon: "icon-fire-1", cd: 6.5, stamina: 29, type: "heavy",
          mul: 2.45, range: 134, knock: 430, lift: 180, windup: 0.36, active: 0.16, recover: 0.42,
          shake: 17, desc: "Wide reaping arc",
        },
        {
          id: "a2", name: "Soul Harvest", icon: "icon-fire-2", cd: 9, stamina: 25, type: "magic",
          mul: 1.7, speed: 460, lifesteal: 0.4, slow: 2, windup: 0.32, recover: 0.36, shake: 9,
          desc: "Drains life and slows",
        },
        {
          id: "a3", name: "Shadowstep", icon: "icon-wind-3", cd: 8, stamina: 16, type: "blink",
          iframes: 0.45, empower: 1.9, empowerTime: 5,
          desc: "Vanish, reappear behind, next hit empowered",
        },
      ],
    },
  };

  const kitFor = (element) => KITS[element] || KITS.fire;

  /* ================================================================== *
   * audio (tiny WebAudio kit, no files)
   * ================================================================== */
  let actx = null;
  let muted = false;
  function blip(freq, type, dur, gain, slide = 0, delay = 0) {
    if (muted) return;
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
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch (_) {
      /* ignore */
    }
  }
  function noise(dur, gain) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const len = Math.floor(actx.sampleRate * dur);
      const buf = actx.createBuffer(1, len, actx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
      const src = actx.createBufferSource();
      const g = actx.createGain();
      g.gain.value = gain;
      src.buffer = buf;
      src.connect(g).connect(actx.destination);
      src.start();
    } catch (_) {
      /* ignore */
    }
  }
  const SFX = {
    swing: () => blip(520, "triangle", 0.08, 0.05, -260),
    hit: () => {
      noise(0.12, 0.14);
      blip(180, "square", 0.09, 0.1, -90);
    },
    heavy: () => {
      noise(0.22, 0.2);
      blip(90, "sawtooth", 0.26, 0.16, -40);
    },
    cast: () => blip(400, "sine", 0.26, 0.09, 520),
    boom: () => {
      noise(0.3, 0.22);
      blip(70, "sine", 0.34, 0.16);
    },
    dash: () => blip(760, "sawtooth", 0.16, 0.06, -520),
    block: () => blip(300, "sine", 0.16, 0.08, 160),
    ko: () => [420, 320, 220].forEach((f, i) => blip(f, "sawtooth", 0.3, 0.11, -60, i * 0.13)),
    win: () => [523, 659, 784, 1046].forEach((f, i) => blip(f, "triangle", 0.24, 0.1, 0, i * 0.1)),
  };

  /* ================================================================== *
   * fighter
   * ================================================================== */
  class Fighter {
    constructor(cfg) {
      this.name = cfg.name;
      this.element = cfg.element;
      this.kit = kitFor(cfg.element);
      this.color = cfg.color || this.kit.color;
      this.glow = this.kit.glow;
      this.isPlayer = !!cfg.isPlayer;
      this.build = cfg.build || "hero"; // hero | brute
      this.stats = cfg.stats;
      this.maxHp = cfg.stats.hp;
      this.hp = cfg.stats.hp;
      this.maxStamina = 100;
      this.stamina = 100;
      this.x = cfg.x;
      this.z = 0;
      this.y = 0;
      this.vx = 0;
      this.vz = 0;
      this.vy = 0;
      this.facing = cfg.facing;
      this.state = "idle";
      this.stateT = 0;
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
      this.winner = false;
      this.trail = [];
      this.flash = 0;
      this.combo = 0;
      this.comboT = 0;
      // articulated pose (radians unless noted)
      this.pose = {
        lean: 0, crouch: 0, bob: 0, head: 0,
        armF: 0.5, armB: -0.6, foreF: 0.4, foreB: 0.5,
        legF: 0.2, legB: -0.2, kneeF: 0.1, kneeB: 0.1,
        weapon: -0.6, spin: 0, cape: 0,
      };
      this.target = { ...this.pose };
      this.animT = 0;
    }

    get speed() {
      let s = this.stats.speed * this.hasteMul;
      if (this.freeze > 0) return 0;
      if (this.slow > 0) s *= 0.55;
      if (this.state === "attack" || this.state === "ability") s *= 0.25;
      return s;
    }

    get busy() {
      return this.state === "attack" || this.state === "ability" || this.state === "dash" ||
        this.state === "hurt" || this.state === "knock" || this.dead;
    }

    hurtbox() {
      const w = this.build === "brute" ? HURT_W * 1.25 : HURT_W;
      const h = FIGHTER_H * (this.build === "brute" ? 1.16 : 1);
      return { x: this.x - w / 2, w, z: this.z - HURT_D / 2, d: HURT_D, y0: this.y, y1: this.y + h };
    }
  }

  /* ================================================================== *
   * the world
   * ================================================================== */
  class Arena {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.ctx = this.canvas.getContext("2d");
      this.onEnd = opts.onEnd || (() => {});
      this.onHud = opts.onHud || (() => {});
      this.icons = {};
      this.hits = [];
      this.shots = [];
      this.fx = [];
      this.numbers = [];
      this.shake = 0;
      this.shakeT = 0;
      this.hitStop = 0;
      this.time = 0;
      this.over = false;
      this.running = false;
      this.input = { dx: 0, dz: 0, attack: false, abilities: [false, false, false] };
      this.cam = { x: 0, zoom: 1, targetZoom: 1 };
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this._resize = this.resize.bind(this);
      window.addEventListener("resize", this._resize);
      this.resize();
    }

    setFighters(playerCfg, enemyCfg) {
      this.player = new Fighter({ ...playerCfg, x: -230, facing: 1, isPlayer: true });
      this.enemy = new Fighter({ ...enemyCfg, x: 230, facing: -1, isPlayer: false });
      this.ai = { think: 0, mode: "approach", modeT: 0, reaction: 0.12 };
      this.over = false;
      this.time = 0;
      this.fx.length = 0;
      this.hits.length = 0;
      this.shots.length = 0;
      this.numbers.length = 0;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(320, rect.width);
      this.h = Math.max(220, rect.height);
      this.canvas.width = Math.floor(this.w * this.dpr);
      this.canvas.height = Math.floor(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      const loop = (now) => {
        if (!this.running) return;
        const dt = Math.min(0.042, (now - this.last) / 1000);
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

    destroy() {
      this.stop();
      window.removeEventListener("resize", this._resize);
    }

    /* ---------------- projection ---------------- */
    depthScale(z) {
      return 1 + z / 900;
    }
    groundY(z) {
      return this.h * 0.78 + z * 0.42;
    }
    project(x, y, z) {
      const zoom = this.cam.zoom;
      const sx = this.w / 2 + (x - this.cam.x) * zoom + this.shakeX;
      const sy = this.groundY(z) * 1 - y * zoom * this.depthScale(z) + this.shakeY;
      return [sx, sy];
    }

    /* ---------------- combat maths ---------------- */
    computeDamage(att, def, spec, mulOverride) {
      const mul = (mulOverride !== undefined ? mulOverride : spec.mul || 1) * att.empowerMul;
      let base = att.stats.damage * mul;
      base *= 0.9 + Math.random() * 0.2;
      const crit = Math.random() < att.stats.crit;
      if (crit) base *= 1.75;
      let dmg = base;
      if (!spec.pierceDef) {
        const red = def.stats.defense / (def.stats.defense + 70);
        dmg *= 1 - red;
        if (def.shield > 0) dmg *= 1 - def.shield;
      }
      return { dmg: Math.max(1, Math.round(dmg)), crit };
    }

    spawnHit(owner, spec, opts = {}) {
      const reach = opts.range !== undefined ? opts.range : spec.range || owner.stats.range;
      this.hits.push({
        owner,
        spec,
        x: owner.x + owner.facing * (reach / 2 + 14),
        z: owner.z,
        w: reach,
        d: HURT_D + 34,
        y0: owner.y - 10,
        y1: owner.y + FIGHTER_H + 10,
        life: opts.life || 0.12,
        knock: opts.knock !== undefined ? opts.knock : spec.knock || 120,
        lift: opts.lift !== undefined ? opts.lift : spec.lift || 0,
        mul: opts.mul,
        kind: opts.kind || spec.type || "slash",
        hitSet: new Set(),
      });
    }

    spawnShot(owner, spec, angle = 0) {
      this.shots.push({
        owner,
        spec,
        x: owner.x + owner.facing * 52,
        z: owner.z,
        y: 62,
        vx: owner.facing * (spec.speed || 500),
        vz: 0,
        life: 2.2,
        trail: [],
        kind: "magic",
      });
      SFX.cast();
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

      // status
      if (spec.burn) {
        def.burn = Math.max(def.burn, spec.burn);
        def.burnTick = 0;
      }
      if (spec.freeze) def.freeze = Math.max(def.freeze, spec.freeze);
      if (spec.slow) def.slow = Math.max(def.slow, spec.slow);
      if (spec.lifesteal) {
        const heal = Math.round(dmg * spec.lifesteal);
        att.hp = Math.min(att.maxHp, att.hp + heal);
        this.number(att, `+${heal}`, "#8ef0a8", false);
        this.particles(att, 12, "#8ef0a8", "mote");
      }

      // physics reaction
      const dir = Math.sign(def.x - att.x) || att.facing;
      const knock = box.knock * (def.build === "brute" ? 0.62 : 1);
      def.vx += dir * knock;
      if (box.lift) {
        def.vy = box.lift;
        def.y = Math.max(def.y, 1);
      }
      def.state = box.lift > 120 || knock > 300 ? "knock" : "hurt";
      def.stateT = 0;
      def.attack = null;

      // presentation
      this.number(def, `${dmg}`, crit ? "#ffd479" : "#ff7a86", crit);
      this.impact(def, box.kind, crit, att);
      const power = clamp((box.knock + dmg * 6) / 460, 0.25, 1.6);
      this.addShake(power * (crit ? 15 : 10));
      this.hitStop = Math.max(this.hitStop, crit ? 0.1 : 0.055 + power * 0.03);
      if (box.kind === "heavy") SFX.heavy();
      else if (box.kind === "magic") SFX.boom();
      else SFX.hit();
      if (def.hp <= 0) this.knockout(def);
    }

    knockout(f) {
      f.dead = true;
      f.state = "dead";
      f.stateT = 0;
      f.vx += (f.x < 0 ? -1 : 1) * 120;
      f.vy = 220;
      this.addShake(20);
      this.hitStop = 0.18;
      SFX.ko();
      const winner = f === this.player ? this.enemy : this.player;
      winner.winner = true;
      winner.state = "victory";
      winner.stateT = 0;
      this.over = true;
      this.endT = 0;
      setTimeout(() => SFX.win(), 700);
    }

    /* ---------------- effects ---------------- */
    number(f, text, color, crit) {
      this.numbers.push({
        x: f.x + rand(-16, 16), y: f.y + FIGHTER_H * 0.75, z: f.z,
        vy: 92, life: 1, text, color, crit,
      });
    }
    particles(f, count, color, type, spread = 1) {
      for (let i = 0; i < count; i += 1) {
        this.fx.push({
          type, color,
          x: f.x + rand(-18, 18) * spread,
          y: f.y + FIGHTER_H * rand(0.3, 0.8),
          z: f.z + rand(-14, 14),
          vx: rand(-220, 220) * spread,
          vy: rand(40, 320),
          vz: rand(-60, 60),
          life: rand(0.32, 0.8),
          max: 0.8,
          size: rand(2, 5.5),
          rot: rand(0, 6.28),
        });
      }
    }
    impact(def, kind, crit, att) {
      const color = att.kit.color;
      this.fx.push({
        type: "ring", color, x: def.x, y: def.y + FIGHTER_H * 0.55, z: def.z,
        life: 0.34, max: 0.34, size: kind === "heavy" ? 16 : 10,
        grow: kind === "heavy" ? 190 : 120,
      });
      this.fx.push({
        type: "flashburst", color: crit ? "#ffffff" : color,
        x: def.x, y: def.y + FIGHTER_H * 0.55, z: def.z, life: 0.2, max: 0.2, size: crit ? 46 : 32,
      });
      if (kind === "slash") {
        this.fx.push({
          type: "slash", color: "#ffffff", x: def.x, y: def.y + FIGHTER_H * 0.55, z: def.z,
          life: 0.18, max: 0.18, size: 60, rot: rand(-0.9, -0.3) * att.facing,
        });
        this.particles(def, 10, "#ffe9a8", "spark");
      } else if (kind === "heavy") {
        this.particles(def, 22, color, "spark", 1.5);
        this.particles(def, 10, "#ffffff", "shard", 1.2);
      } else {
        this.particles(def, 20, color, "mote", 1.3);
        this.fx.push({
          type: "ring", color: att.kit.glow, x: def.x, y: def.y + FIGHTER_H * 0.5, z: def.z,
          life: 0.42, max: 0.42, size: 12, grow: 230,
        });
      }
    }
    addShake(v) {
      this.shake = Math.min(26, this.shake + v);
    }

    /* ---------------- actions ---------------- */
    canAct(f) {
      return !f.dead && !this.over && f.freeze <= 0 &&
        f.state !== "attack" && f.state !== "ability" && f.state !== "dash" &&
        f.state !== "hurt" && f.state !== "knock";
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
        windup: 0.14 / f.stats.atkSpeed,
        active: 0.1 / f.stats.atkSpeed,
        recover: 0.2 / f.stats.atkSpeed,
        range: f.stats.range,
      };
      f.trail.length = 0;
      SFX.swing();
      return true;
    }

    doAbility(f, index) {
      const spec = f.kit.abilities[index];
      if (!spec || !this.canAct(f) || f.cooldowns[index] > 0 || f.stamina < spec.stamina) return false;
      f.stamina -= spec.stamina;
      f.cooldowns[index] = spec.cd;
      f.abilityIndex = index;
      f.attack = { ...spec, windup: spec.windup || 0.25, active: spec.active || 0.14, recover: spec.recover || 0.32 };
      f.hitsDone = 0;
      f.trail.length = 0;
      f.phase = "windup";
      f.stateT = 0;

      if (spec.type === "dash") {
        f.state = "dash";
        f.iframes = spec.iframes;
        f.vx = f.facing * spec.dashSpeed;
        f.dashLeft = spec.dashTime;
        SFX.dash();
        for (let i = 0; i < 14; i += 1) this.particles(f, 1, f.kit.color, "mote", 0.6);
      } else if (spec.type === "blink") {
        const foe = f === this.player ? this.enemy : this.player;
        this.particles(f, 18, f.kit.color, "mote", 1.4);
        this.fx.push({ type: "ring", color: f.kit.color, x: f.x, y: f.y + 60, z: f.z, life: 0.3, max: 0.3, size: 10, grow: 160 });
        f.x = clamp(foe.x - foe.facing * 86, -ARENA_HALF, ARENA_HALF);
        f.z = foe.z;
        f.facing = Math.sign(foe.x - f.x) || f.facing;
        f.iframes = spec.iframes;
        if (spec.hasteTime) { f.haste = spec.hasteTime; f.hasteMul = spec.haste; }
        if (spec.empower) { f.empower = spec.empowerTime; f.empowerMul = spec.empower; }
        this.particles(f, 18, f.kit.color, "mote", 1.4);
        f.state = "idle";
        f.attack = null;
        SFX.dash();
      } else {
        f.state = "ability";
        SFX.cast();
      }
      return true;
    }

    fireAttack(f) {
      const spec = f.attack;
      if (!spec) return;
      if (spec.type === "magic") {
        const volley = spec.volley || 1;
        for (let i = 0; i < volley; i += 1) {
          setTimeout(() => {
            if (!this.running || f.dead) return;
            this.spawnShot(f, spec);
          }, i * 110);
        }
      } else if (spec.type === "buff") {
        f.shield = spec.shield;
        f.shieldTime = spec.buffTime;
        if (spec.regen) f.stamina = Math.min(f.maxStamina, f.stamina + spec.regen);
        this.fx.push({ type: "ring", color: f.kit.color, x: f.x, y: f.y + 60, z: f.z, life: 0.5, max: 0.5, size: 14, grow: 150 });
        this.particles(f, 20, f.kit.glow, "mote", 1.2);
        SFX.block();
      } else {
        const hits = spec.hits || 1;
        this.spawnHit(f, spec, {
          life: (spec.active || 0.12) / (hits > 1 ? hits : 1),
          kind: spec.type === "heavy" ? "heavy" : "slash",
          range: spec.range,
        });
        if (spec.type === "heavy") this.addShake(spec.shake || 8);
      }
    }

    /* ---------------- per-frame ---------------- */
    update(dt) {
      if (this.hitStop > 0) {
        this.hitStop -= dt;
        dt *= 0.12;
      }
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
        this.input.dz = 0;
      }

      [p, e].forEach((f) => this.stepFighter(f, dt));
      this.separate(p, e);
      this.stepHits(dt);
      this.stepShots(dt);
      this.stepFx(dt);
      this.stepCamera(dt);

      if (this.over && this.endT > 2.1 && !this.ended) {
        this.ended = true;
        this.onEnd(p.dead ? "lose" : "win", Math.round(p.hp));
      }
      this.onHud(this);
    }

    controlPlayer(f, dt) {
      if (f.dead || f.freeze > 0) return;
      const acc = 2600;
      const sp = this.speed(f);
      const wish = { x: this.input.dx * sp, z: this.input.dz * sp * 0.62 };
      if (!f.busy) {
        f.vx = approach(f.vx, wish.x, acc / 260, dt);
        f.vz = approach(f.vz, wish.z, acc / 260, dt);
      }
      if (this.input.attack) {
        this.input.attack = false;
        this.faceFoe(f);
        this.doBasic(f);
      }
      this.input.abilities.forEach((pressed, i) => {
        if (pressed) {
          this.input.abilities[i] = false;
          this.faceFoe(f);
          this.doAbility(f, i);
        }
      });
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
      if (f.dead || f.freeze > 0) {
        f.vx = approach(f.vx, 0, 8, dt);
        return;
      }
      this.ai.think -= dt;
      const dx = foe.x - f.x;
      const dz = foe.z - f.z;
      const dist = Math.abs(dx);
      const sp = this.speed(f);
      f.facing = Math.sign(dx) || f.facing;

      if (this.ai.think <= 0) {
        this.ai.think = rand(0.14, 0.3);
        const hpRatio = f.hp / f.maxHp;
        const r = Math.random();
        if (f.stamina < 22 && dist < 190) this.ai.mode = "retreat";
        else if (hpRatio < 0.28 && r < 0.3) this.ai.mode = "retreat";
        else if (dist > f.stats.range + 40) this.ai.mode = "approach";
        else if (r < 0.16) this.ai.mode = "strafe";
        else this.ai.mode = "fight";
      }

      let wishX = 0;
      let wishZ = clamp(dz, -1, 1) * 0.5;
      if (this.ai.mode === "approach") wishX = Math.sign(dx);
      else if (this.ai.mode === "retreat") wishX = -Math.sign(dx);
      else if (this.ai.mode === "strafe") wishZ = Math.sin(this.time * 2.4) * 1;

      if (!f.busy) {
        f.vx = approach(f.vx, wishX * sp, 9, dt);
        f.vz = approach(f.vz, wishZ * sp * 0.6, 9, dt);
      }

      if (this.ai.mode === "fight" && this.canAct(f) && Math.abs(dz) < 44) {
        // abilities first when they land, otherwise basics
        for (let i = 0; i < 3; i += 1) {
          const spec = f.kit.abilities[i];
          const usable = f.cooldowns[i] <= 0 && f.stamina >= spec.stamina;
          const inRange = spec.type === "magic" || spec.type === "buff" || spec.type === "blink"
            ? true
            : dist < (spec.range || f.stats.range) + 30;
          if (usable && inRange && Math.random() < 0.55) {
            this.doAbility(f, i);
            return;
          }
        }
        if (dist < f.stats.range + 18 && Math.random() < 0.75) this.doBasic(f);
      }
      // magic users keep their distance and snipe
      if (this.canAct(f) && dist > 260 && Math.random() < 0.02) {
        const i = f.kit.abilities.findIndex((s, idx) => s.type === "magic" && f.cooldowns[idx] <= 0);
        if (i >= 0) this.doAbility(f, i);
      }
    }

    stepFighter(f, dt) {
      f.stateT += dt;
      f.animT += dt;
      f.flash = Math.max(0, f.flash - dt * 5);
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

      // burn damage over time
      if (f.burn > 0 && !f.dead) {
        f.burn -= dt;
        f.burnTick -= dt;
        if (f.burnTick <= 0) {
          f.burnTick = 0.5;
          const dmg = Math.max(1, Math.round(f.maxHp * 0.011));
          f.hp = Math.max(0, f.hp - dmg);
          this.number(f, `${dmg}`, "#ff8a3c", false);
          this.particles(f, 4, "#ff8a3c", "mote", 0.6);
          if (f.hp <= 0) this.knockout(f);
        }
      }

      // stamina regen
      const regenRate = f.state === "idle" || f.state === "walk" ? 17 : 7;
      f.stamina = Math.min(f.maxStamina, f.stamina + regenRate * dt);

      // state machine
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
              this.spawnHit(f, a, { life: ac / hits * 0.9, kind: a.type === "heavy" ? "heavy" : "slash", range: a.range });
              f.hitsDone += 1;
              SFX.swing();
            }
            if (f.stateT >= wu + ac) f.phase = "recover";
          } else if (f.phase === "recover" && f.stateT >= wu + ac + a.recover) {
            f.state = "idle";
            f.attack = null;
            f.trail.length = 0;
          }
        } else {
          f.state = "idle";
        }
      } else if (f.state === "dash") {
        f.dashLeft -= dt;
        // dashing body is itself a hitbox
        if (f.attack && f.dashLeft > 0) {
          this.spawnHit(f, f.attack, { life: 0.05, kind: "heavy", range: 70, knock: f.attack.knock });
        }
        if (f.dashLeft <= 0) {
          f.state = "idle";
          f.attack = null;
          f.vx *= 0.25;
        }
      } else if (f.state === "hurt") {
        if (f.stateT > 0.26) f.state = "idle";
      } else if (f.state === "knock") {
        if (f.y <= 0 && f.stateT > 0.5) f.state = "idle";
      } else if (f.state === "dead") {
        f.vx = approach(f.vx, 0, 4, dt);
      } else {
        f.state = Math.abs(f.vx) + Math.abs(f.vz) > 26 ? "walk" : "idle";
      }

      // integrate
      f.x += f.vx * dt;
      f.z += f.vz * dt;
      f.y += f.vy * dt;
      if (f.y > 0) f.vy -= GRAVITY * dt;
      if (f.y < 0) {
        f.y = 0;
        if (f.vy < -60 && !f.dead) {
          this.particles(f, 8, "#9fb0ff", "spark", 0.6);
          this.addShake(4);
        }
        f.vy = 0;
      }
      const friction = f.state === "knock" || f.state === "dash" ? 1.6 : 9;
      if (f.busy || Math.abs(this.input.dx) < 0.05 || f !== this.player) {
        f.vx = approach(f.vx, 0, friction, dt);
      }
      if (f.busy || Math.abs(this.input.dz) < 0.05 || f !== this.player) {
        f.vz = approach(f.vz, 0, friction, dt);
      }
      f.x = clamp(f.x, -ARENA_HALF, ARENA_HALF);
      f.z = clamp(f.z, -DEPTH, DEPTH);

      if (!f.dead && !this.over) this.faceFoe(f);
      this.poseFighter(f, dt);
    }

    /* bodies physically collide — they cannot pass through each other */
    separate(a, b) {
      const minX = 62;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (Math.abs(dz) > 46) return;
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
        // hitboxes travel with their owner so they stay glued to the swing
        box.x = box.owner.x + box.owner.facing * (box.w / 2 + 14);
        box.z = box.owner.z;
        const targets = [this.player, this.enemy].filter((t) => t !== box.owner && !t.dead);
        targets.forEach((t) => {
          if (box.hitSet.has(t)) return;
          const hb = t.hurtbox();
          const bx0 = box.x - box.w / 2;
          const bx1 = box.x + box.w / 2;
          const bz0 = box.z - box.d / 2;
          const bz1 = box.z + box.d / 2;
          const overlap =
            bx1 > hb.x && bx0 < hb.x + hb.w &&
            bz1 > hb.z && bz0 < hb.z + hb.d &&
            box.y1 > hb.y0 && box.y0 < hb.y1;
          if (overlap) {
            box.hitSet.add(t);
            this.applyHit(box.owner, t, box);
          }
        });
        if (box.life <= 0) this.hits.splice(i, 1);
      }
    }

    stepShots(dt) {
      for (let i = this.shots.length - 1; i >= 0; i -= 1) {
        const s = this.shots[i];
        s.life -= dt;
        s.x += s.vx * dt;
        s.z += s.vz * dt;
        s.trail.push([s.x, s.y, s.z]);
        if (s.trail.length > 14) s.trail.shift();
        const target = s.owner === this.player ? this.enemy : this.player;
        const hb = target.hurtbox();
        const hit =
          !target.dead &&
          s.x > hb.x - 12 && s.x < hb.x + hb.w + 12 &&
          s.z > hb.z - 26 && s.z < hb.z + hb.d + 26 &&
          s.y > hb.y0 - 20 && s.y < hb.y1;
        if (hit) {
          this.applyHit(s.owner, target, {
            spec: s.spec, knock: 180, lift: 0, kind: "magic", mul: s.spec.mul,
          });
          this.explode(s);
          this.shots.splice(i, 1);
          continue;
        }
        if (Math.abs(s.x) > ARENA_HALF + 40 || s.life <= 0) {
          this.explode(s);
          this.shots.splice(i, 1);
        }
      }
    }

    explode(s) {
      const color = s.owner.kit.color;
      this.fx.push({ type: "ring", color, x: s.x, y: s.y, z: s.z, life: 0.4, max: 0.4, size: 10, grow: 240 });
      this.fx.push({ type: "flashburst", color: s.owner.kit.glow, x: s.x, y: s.y, z: s.z, life: 0.24, max: 0.24, size: 40 });
      for (let i = 0; i < 18; i += 1) {
        this.fx.push({
          type: "mote", color, x: s.x, y: s.y, z: s.z,
          vx: rand(-260, 260), vy: rand(-60, 300), vz: rand(-80, 80),
          life: rand(0.3, 0.7), max: 0.7, size: rand(2, 5),
        });
      }
    }

    stepFx(dt) {
      for (let i = this.fx.length - 1; i >= 0; i -= 1) {
        const p = this.fx[i];
        p.life -= dt;
        if (p.vx !== undefined) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += (p.vz || 0) * dt;
          p.vy -= 900 * dt;
          if (p.y < 0) { p.y = 0; p.vy *= -0.35; p.vx *= 0.7; }
        }
        if (p.grow) p.size += p.grow * dt;
        if (p.life <= 0) this.fx.splice(i, 1);
      }
      for (let i = this.numbers.length - 1; i >= 0; i -= 1) {
        const n = this.numbers[i];
        n.life -= dt;
        n.y += n.vy * dt;
        n.vy -= 90 * dt;
        if (n.life <= 0) this.numbers.splice(i, 1);
      }
      this.shake = Math.max(0, this.shake - dt * 46);
      const s = this.shake;
      this.shakeX = rand(-s, s);
      this.shakeY = rand(-s, s) * 0.6;
    }

    stepCamera(dt) {
      const p = this.player;
      const e = this.enemy;
      const mid = (p.x + e.x) / 2;
      const dist = Math.abs(p.x - e.x);
      const fit = (this.w - 150) / Math.max(240, dist + 260);
      this.cam.targetZoom = clamp(fit, 0.62, 1.32);
      this.cam.zoom = approach(this.cam.zoom, this.cam.targetZoom, 4, dt);
      const halfView = this.w / 2 / this.cam.zoom;
      const limit = Math.max(0, ARENA_HALF + 60 - halfView);
      this.cam.x = approach(this.cam.x, clamp(mid, -limit, limit), 6, dt);
    }

    /* ================================================================ *
     * poses — a small procedural animation system
     * ================================================================ */
    poseFighter(f, dt) {
      const t = f.animT;
      const tgt = f.target;
      const moving = Math.abs(f.vx) + Math.abs(f.vz) > 26;
      const back = f.vx * f.facing < -20;
      let rate = 13;

      const reset = () => {
        tgt.lean = 0; tgt.crouch = 0; tgt.head = 0; tgt.spin = 0;
        tgt.armF = 0.5; tgt.armB = -0.5; tgt.foreF = 0.5; tgt.foreB = 0.5;
        tgt.legF = 0.16; tgt.legB = -0.16; tgt.kneeF = 0.08; tgt.kneeB = 0.08;
        tgt.weapon = -0.7; tgt.cape = 0; tgt.bob = 0;
      };

      switch (f.state) {
        case "idle": {
          reset();
          tgt.bob = Math.sin(t * 3.1) * 3.2;
          tgt.armF = 0.42 + Math.sin(t * 3.1) * 0.07;
          tgt.armB = -0.5 + Math.sin(t * 3.1 + 1) * 0.07;
          tgt.weapon = -0.6 + Math.sin(t * 2.2) * 0.09;
          tgt.head = Math.sin(t * 1.7) * 0.05;
          tgt.cape = Math.sin(t * 1.9) * 0.14;
          rate = 8;
          break;
        }
        case "walk": {
          reset();
          const w = t * (back ? 8 : 11);
          tgt.legF = Math.sin(w) * 0.62;
          tgt.legB = -Math.sin(w) * 0.62;
          tgt.kneeF = Math.max(0, Math.sin(w + 0.7)) * 0.6;
          tgt.kneeB = Math.max(0, -Math.sin(w + 0.7)) * 0.6;
          tgt.armF = -Math.sin(w) * 0.5 + 0.2;
          tgt.armB = Math.sin(w) * 0.5 - 0.3;
          tgt.bob = Math.abs(Math.sin(w)) * 5;
          tgt.lean = back ? -0.1 : 0.13;
          tgt.cape = -0.3 * Math.sign(f.vx * f.facing || 1);
          tgt.weapon = -0.8;
          rate = 15;
          break;
        }
        case "attack":
        case "ability": {
          const a = f.attack || { windup: 0.2, active: 0.1, recover: 0.2 };
          const total = a.windup + a.active + a.recover;
          const prog = clamp(f.stateT / total, 0, 1);
          reset();
          rate = 26;
          if (a.type === "magic" || a.type === "buff") {
            if (f.phase === "windup") {
              tgt.armF = -1.9; tgt.foreF = -0.7; tgt.armB = -1.5;
              tgt.crouch = 5; tgt.lean = -0.14; tgt.head = -0.16;
            } else {
              tgt.armF = -0.65; tgt.foreF = 0.4; tgt.armB = -0.9;
              tgt.lean = 0.22;
            }
            tgt.weapon = -1.5;
          } else if (a.type === "heavy") {
            if (f.phase === "windup") {
              tgt.armF = -2.5; tgt.foreF = -1.1; tgt.weapon = -2.4;
              tgt.lean = -0.3; tgt.crouch = 8; tgt.legB = -0.5;
            } else if (f.phase === "active") {
              tgt.armF = 1.55; tgt.foreF = 0.25; tgt.weapon = 1.5;
              tgt.lean = 0.44; tgt.crouch = 14; tgt.legF = 0.7;
            } else {
              tgt.armF = 1.0; tgt.weapon = 0.9; tgt.lean = 0.25; tgt.crouch = 8;
            }
            if (a.hits > 1) tgt.spin = prog * Math.PI * 2 * (a.hits - 1);
          } else {
            if (f.phase === "windup") {
              tgt.armF = -1.35; tgt.foreF = -0.55; tgt.weapon = -1.6; tgt.lean = -0.16;
            } else if (f.phase === "active") {
              tgt.armF = 1.25; tgt.foreF = 0.1; tgt.weapon = 1.15; tgt.lean = 0.3; tgt.legF = 0.48;
            } else {
              tgt.armF = 0.6; tgt.weapon = 0.2; tgt.lean = 0.12;
            }
          }
          break;
        }
        case "dash": {
          reset();
          tgt.lean = 0.55; tgt.crouch = 16; tgt.armF = -1.0; tgt.armB = 1.1;
          tgt.legF = 0.9; tgt.legB = -0.8; tgt.weapon = 0.4; tgt.cape = -0.8;
          rate = 24;
          break;
        }
        case "hurt": {
          reset();
          tgt.lean = -0.42; tgt.head = -0.3; tgt.armF = -0.9; tgt.armB = -1.2;
          tgt.crouch = 10; tgt.legB = -0.4;
          rate = 30;
          break;
        }
        case "knock": {
          reset();
          tgt.lean = -1.0; tgt.head = -0.5; tgt.armF = -1.6; tgt.armB = -1.9;
          tgt.legF = -0.7; tgt.legB = 0.5; tgt.crouch = 6; tgt.cape = 1;
          rate = 20;
          break;
        }
        case "dead": {
          reset();
          tgt.lean = -1.45; tgt.crouch = 62; tgt.head = -0.6;
          tgt.armF = -2.2; tgt.armB = -2.4; tgt.legF = -1.1; tgt.legB = 0.9;
          tgt.weapon = -2.6;
          rate = 7;
          break;
        }
        case "victory": {
          reset();
          tgt.armF = -2.2 + Math.sin(t * 4) * 0.14;
          tgt.foreF = -0.5;
          tgt.weapon = -2.4;
          tgt.bob = Math.abs(Math.sin(t * 4)) * 9;
          tgt.lean = -0.1;
          rate = 9;
          break;
        }
        default:
          reset();
      }

      const k = 1 - Math.exp(-rate * dt);
      Object.keys(tgt).forEach((key) => {
        f.pose[key] = lerp(f.pose[key], tgt[key], k);
      });
    }

    /* ================================================================ *
     * rendering
     * ================================================================ */
    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      this.drawBackground(ctx);
      const order = [this.player, this.enemy].sort((a, b) => a.z - b.z);
      this.drawGroundFx(ctx);
      order.forEach((f) => this.drawFighter(ctx, f));
      this.drawShots(ctx);
      this.drawAirFx(ctx);
      this.drawNumbers(ctx);
      this.drawNameplates(ctx);
      if (this.over) this.drawEndBanner(ctx);
    }

    drawBackground(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, "#0b0f2b");
      g.addColorStop(0.55, "#151a44");
      g.addColorStop(1, "#05060f");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);

      // element auras behind each fighter
      [this.player, this.enemy].forEach((f) => {
        if (!f) return;
        const [sx] = this.project(f.x, 0, f.z);
        const r = ctx.createRadialGradient(sx, this.h * 0.6, 10, sx, this.h * 0.6, 260);
        r.addColorStop(0, `${f.kit.color}33`);
        r.addColorStop(1, "transparent");
        ctx.fillStyle = r;
        ctx.fillRect(0, 0, this.w, this.h);
      });

      // parallax pillars
      ctx.save();
      for (let i = -4; i <= 4; i += 1) {
        const wx = i * 240;
        const [sx] = this.project(wx, 0, -DEPTH * 2);
        const top = this.h * 0.12;
        const bottom = this.groundY(-DEPTH * 2);
        const w = 46 * this.cam.zoom;
        const grad = ctx.createLinearGradient(0, top, 0, bottom);
        grad.addColorStop(0, "rgba(120,132,255,0.05)");
        grad.addColorStop(1, "rgba(80,92,220,0.20)");
        ctx.fillStyle = grad;
        ctx.fillRect(sx - w / 2, top, w, bottom - top);
        ctx.fillStyle = "rgba(150,160,255,0.10)";
        ctx.fillRect(sx - w / 2, top, w, 8);
      }
      ctx.restore();

      // floor slab with depth lines
      const backY = this.groundY(-DEPTH);
      const frontY = this.groundY(DEPTH);
      const [bx0] = this.project(-ARENA_HALF - 40, 0, -DEPTH);
      const [bx1] = this.project(ARENA_HALF + 40, 0, -DEPTH);
      const [fx0] = this.project(-ARENA_HALF - 70, 0, DEPTH);
      const [fx1] = this.project(ARENA_HALF + 70, 0, DEPTH);
      const fg = ctx.createLinearGradient(0, backY, 0, frontY + 60);
      fg.addColorStop(0, "#1b2050");
      fg.addColorStop(0.4, "#141838");
      fg.addColorStop(1, "#090b1c");
      ctx.beginPath();
      ctx.moveTo(bx0, backY);
      ctx.lineTo(bx1, backY);
      ctx.lineTo(fx1, frontY + 80);
      ctx.lineTo(fx0, frontY + 80);
      ctx.closePath();
      ctx.fillStyle = fg;
      ctx.fill();

      ctx.strokeStyle = "rgba(140,155,255,0.14)";
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i += 1) {
        const wx = i * 120;
        const [ax, ay] = this.project(wx, 0, -DEPTH);
        const [bx, by] = this.project(wx, 0, DEPTH);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by + 80);
        ctx.stroke();
      }
      for (let d = -DEPTH; d <= DEPTH; d += 39) {
        const [ax, ay] = this.project(-ARENA_HALF - 40, 0, d);
        const [bx, by] = this.project(ARENA_HALF + 40, 0, d);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(180,190,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx0, backY);
      ctx.lineTo(bx1, backY);
      ctx.stroke();
    }

    drawGroundFx(ctx) {
      this.fx.forEach((p) => {
        if (p.type !== "ring") return;
        const [sx, sy] = this.project(p.x, p.y, p.z);
        const a = clamp(p.life / p.max, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3 * a + 1;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.ellipse(sx, sy, p.size * this.cam.zoom, p.size * 0.42 * this.cam.zoom, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
    }

    limb(ctx, x0, y0, angle, len, width, color, bend = 0, bendLen = 0) {
      const x1 = x0 + Math.sin(angle) * len;
      const y1 = y0 + Math.cos(angle) * len;
      ctx.lineCap = "round";
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (bendLen) {
        const a2 = angle + bend;
        const x2 = x1 + Math.sin(a2) * bendLen;
        const y2 = y1 + Math.cos(a2) * bendLen;
        ctx.lineWidth = width * 0.85;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        return [x2, y2];
      }
      return [x1, y1];
    }

    drawFighter(ctx, f) {
      const p = f.pose;
      const zoom = this.cam.zoom * this.depthScale(f.z);
      const [sx, sy] = this.project(f.x, f.y, f.z);
      const s = zoom * (f.build === "brute" ? 1.16 : 1);
      const dir = f.facing;

      // shadow
      ctx.save();
      const shadowScale = clamp(1 - f.y / 420, 0.35, 1);
      ctx.globalAlpha = 0.45 * shadowScale;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(sx, this.groundY(f.z) + this.shakeY, 34 * s * shadowScale, 10 * s * shadowScale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(dir * s, s);
      ctx.rotate(-p.lean * 0.5 + p.spin * 0);
      ctx.translate(0, p.crouch * -1 + p.bob * -1);

      const body = f.dead ? "#3b4066" : f.flash > 0.35 ? "#ffffff" : "#252a4d";
      const trim = f.flash > 0.35 ? "#ffffff" : f.kit.color;
      const skin = f.flash > 0.35 ? "#ffffff" : "#c9d0ff";
      const hipY = -76;
      const shoulderY = -122;

      // aura when buffed / empowered
      if (f.shield > 0 || f.empower > 0 || f.haste > 0) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = f.shield > 0 ? "#7fd8ff" : f.kit.color;
        ctx.lineWidth = 2.4;
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.ellipse(0, -70, 44 + Math.sin(this.time * 6) * 3, 82, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // cape
      ctx.save();
      ctx.globalAlpha = 0.9;
      const capeSwing = p.cape * 26 - 8;
      const grad = ctx.createLinearGradient(0, shoulderY, 0, hipY + 34);
      grad.addColorStop(0, f.kit.color);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(-6, shoulderY + 4);
      ctx.quadraticCurveTo(-30 + capeSwing, hipY - 6, -20 + capeSwing * 1.6, hipY + 40);
      ctx.lineTo(4 + capeSwing * 0.8, hipY + 34);
      ctx.quadraticCurveTo(6, hipY - 20, 8, shoulderY + 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // back leg + back arm (behind torso)
      this.limb(ctx, -3, hipY, Math.PI + p.legB, 40, 13 * (f.build === "brute" ? 1.15 : 1), "#1b2044", p.kneeB, 36);
      this.limb(ctx, -4, shoulderY + 8, Math.PI + p.armB, 34, 11, "#1b2044", p.foreB, 30);

      // torso
      ctx.fillStyle = body;
      ctx.strokeStyle = trim;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-16, hipY + 4);
      ctx.lineTo(-19, shoulderY + 6);
      ctx.quadraticCurveTo(0, shoulderY - 8, 19, shoulderY + 6);
      ctx.lineTo(16, hipY + 4);
      ctx.quadraticCurveTo(0, hipY + 14, -16, hipY + 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // chest sigil
      ctx.fillStyle = trim;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 20);
      ctx.lineTo(9, shoulderY + 33);
      ctx.lineTo(0, shoulderY + 46);
      ctx.lineTo(-9, shoulderY + 33);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // front leg
      this.limb(ctx, 3, hipY, Math.PI + p.legF, 42, 14 * (f.build === "brute" ? 1.15 : 1), "#2a3059", p.kneeF, 38);

      // head
      ctx.save();
      ctx.translate(0, shoulderY - 2);
      ctx.rotate(p.head);
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(2, -14, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = trim;
      ctx.beginPath();
      if (f.build === "brute") {
        ctx.moveTo(-12, -20);
        ctx.lineTo(16, -26);
        ctx.lineTo(18, -12);
        ctx.lineTo(-12, -8);
      } else {
        ctx.moveTo(-12, -18);
        ctx.lineTo(14, -22);
        ctx.lineTo(16, -14);
        ctx.lineTo(-12, -12);
      }
      ctx.closePath();
      ctx.fill();
      // glowing eye
      ctx.fillStyle = f.kit.glow;
      ctx.shadowColor = f.kit.glow;
      ctx.shadowBlur = 10;
      ctx.fillRect(6, -17, 7, 3);
      ctx.restore();

      // front arm + weapon
      const [handX, handY] = this.limb(ctx, 4, shoulderY + 8, Math.PI + p.armF, 34, 12, "#2a3059", p.foreF, 30);
      const wAngle = Math.PI + p.weapon;
      const wLen = f.build === "brute" ? 92 : 78;
      const tipX = handX + Math.sin(wAngle) * wLen;
      const tipY = handY + Math.cos(wAngle) * wLen;

      // weapon trail while swinging
      if (f.state === "attack" || f.state === "ability" || f.state === "dash") {
        f.trail.push([tipX, tipY]);
        if (f.trail.length > 9) f.trail.shift();
      } else if (f.trail.length) {
        f.trail.shift();
      }
      if (f.trail.length > 2) {
        ctx.save();
        ctx.strokeStyle = f.kit.glow;
        ctx.shadowColor = f.kit.color;
        ctx.shadowBlur = 18;
        ctx.lineCap = "round";
        for (let i = 1; i < f.trail.length; i += 1) {
          ctx.globalAlpha = (i / f.trail.length) * 0.7;
          ctx.lineWidth = 10 * (i / f.trail.length);
          ctx.beginPath();
          ctx.moveTo(f.trail[i - 1][0], f.trail[i - 1][1]);
          ctx.lineTo(f.trail[i][0], f.trail[i][1]);
          ctx.stroke();
        }
        ctx.restore();
      }

      // the weapon itself
      ctx.save();
      ctx.strokeStyle = f.kit.glow;
      ctx.shadowColor = f.kit.color;
      ctx.shadowBlur = 14;
      ctx.lineWidth = f.build === "brute" ? 8 : 6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(handX, handY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.strokeStyle = "#0b0d20";
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(handX - Math.sin(wAngle) * 8, handY - Math.cos(wAngle) * 8);
      ctx.lineTo(handX + Math.sin(wAngle) * 6, handY + Math.cos(wAngle) * 6);
      ctx.stroke();
      ctx.restore();

      // frozen / burning overlays
      if (f.freeze > 0) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = "#7fd8ff";
        ctx.fillRect(-30, -168, 60, 176);
        ctx.restore();
      }
      ctx.restore();

      if (f.burn > 0) {
        for (let i = 0; i < 2; i += 1) {
          if (Math.random() < 0.4) this.particles(f, 1, "#ff8a3c", "mote", 0.5);
        }
      }
      if (f.iframes > 0) {
        // ghost afterimage while dashing / blinking
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = f.kit.color;
        ctx.beginPath();
        ctx.ellipse(sx - dir * 22, sy - 70 * s, 20 * s, 60 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    drawShots(ctx) {
      this.shots.forEach((s) => {
        const color = s.owner.kit.color;
        const glow = s.owner.kit.glow;
        ctx.save();
        for (let i = 1; i < s.trail.length; i += 1) {
          const [tx, ty, tz] = s.trail[i];
          const [px, py] = this.project(tx, ty, tz);
          ctx.globalAlpha = (i / s.trail.length) * 0.55;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, (i / s.trail.length) * 11 * this.cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        const [sx, sy] = this.project(s.x, s.y, s.z);
        ctx.globalAlpha = 1;
        ctx.shadowColor = color;
        ctx.shadowBlur = 26;
        const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, 17 * this.cam.zoom);
        g.addColorStop(0, "#ffffff");
        g.addColorStop(0.35, glow);
        g.addColorStop(1, `${color}00`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, 17 * this.cam.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }

    drawAirFx(ctx) {
      this.fx.forEach((p) => {
        if (p.type === "ring") return;
        const [sx, sy] = this.project(p.x, p.y, p.z);
        const a = clamp(p.life / p.max, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        if (p.type === "flashburst") {
          const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, p.size * this.cam.zoom);
          g.addColorStop(0, "#ffffff");
          g.addColorStop(0.4, p.color);
          g.addColorStop(1, "transparent");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sx, sy, p.size * this.cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.type === "slash") {
          ctx.translate(sx, sy);
          ctx.rotate(p.rot);
          ctx.strokeStyle = p.color;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 18;
          ctx.lineWidth = 6 * a;
          ctx.beginPath();
          ctx.arc(0, 0, p.size * this.cam.zoom, -0.9, 0.9);
          ctx.stroke();
        } else if (p.type === "shard") {
          ctx.translate(sx, sy);
          ctx.rotate((p.rot || 0) + p.life * 8);
          ctx.fillStyle = p.color;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 10;
          ctx.fillRect(-p.size, -p.size * 2.2, p.size * 2, p.size * 4.4);
        } else {
          ctx.fillStyle = p.color;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(sx, sy, p.size * a * this.cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
    }

    drawNumbers(ctx) {
      this.numbers.forEach((n) => {
        const [sx, sy] = this.project(n.x, n.y, n.z);
        const a = clamp(n.life, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.font = `900 ${(n.crit ? 34 : 24) * this.cam.zoom}px "SF Pro Display", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(n.text, sx, sy);
        ctx.fillStyle = n.color;
        ctx.fillText(n.text, sx, sy);
        if (n.crit) {
          ctx.font = `800 ${12 * this.cam.zoom}px system-ui`;
          ctx.fillStyle = "#ffd479";
          ctx.fillText("CRITICAL", sx, sy + 16 * this.cam.zoom);
        }
        ctx.restore();
      });
    }

    drawNameplates(ctx) {
      [this.player, this.enemy].forEach((f) => {
        if (!f || f.dead) return;
        const [sx] = this.project(f.x, 0, f.z);
        const sy = this.project(f.x, FIGHTER_H + 34, f.z)[1];
        ctx.save();
        ctx.font = `700 ${10.5 * this.cam.zoom}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.fillText(f.isPlayer ? "YOU" : f.name.toUpperCase(), sx, sy);
        if (f.combo > 1) {
          ctx.fillStyle = "#ffd479";
          ctx.font = `900 ${13 * this.cam.zoom}px system-ui`;
          ctx.fillText(`${f.combo} HIT`, sx, sy - 15 * this.cam.zoom);
        }
        ctx.restore();
      });
    }

    drawEndBanner(ctx) {
      const win = !this.player.dead;
      const a = clamp(this.endT / 0.4, 0, 1);
      ctx.save();
      ctx.globalAlpha = a * 0.55;
      ctx.fillStyle = "#04050e";
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.font = `900 ${Math.min(64, this.w * 0.14)}px "SF Pro Display", system-ui, sans-serif`;
      ctx.fillStyle = win ? "#ffd479" : "#ff5f6d";
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 30;
      ctx.fillText(win ? "K.O.!" : "DEFEAT", this.w / 2, this.h / 2);
      ctx.shadowBlur = 0;
      ctx.font = "600 14px system-ui";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(win ? "Chapter cleared" : "You wake at camp, fully healed", this.w / 2, this.h / 2 + 30);
      ctx.restore();
    }
  }

  window.ChronicleArena = { Arena, KITS, kitFor, setMuted: (v) => { muted = v; } };
})();
