/* ChronicleRift — Rift Arena client.
   Talks to the same authenticated API: GET /api/me, POST /api/actions, POST /api/buy.
   All game truth comes from the server; this file only renders and animates it. */
(() => {
  "use strict";

  const telegram = window.Telegram && window.Telegram.WebApp;
  const $ = (selector) => document.querySelector(selector);

  const els = {
    status: $("#connection-status"),
    chapter: $("#chapter-chip"),
    enemyCard: $("#enemy-card"),
    enemyImg: $("#enemy-art-img"),
    bossTag: $("#boss-tag"),
    enemyName: $("#enemy-name"),
    enemyAttack: $("#enemy-attack b"),
    enemyHpBar: $("#enemy-hp-bar"),
    enemyHpText: $("#enemy-hp-text"),
    exposedChip: $("#exposed-chip"),
    intentCard: $("#intent-card"),
    intentIc: $("#intent-ic"),
    intentName: $("#intent-name"),
    intentAdvice: $("#intent-advice"),
    intentNum: $("#intent-num"),
    burnChip: $("#burn-chip"),
    burnTurns: $("#burn-turns"),
    focusPips: $("#focus-pips"),
    focusNote: $("#focus-note"),
    coach: $("#coach"),
    coachText: $("#coach-text"),
    strikeSub: $("#strike-sub"),
    bannerArt: $("#banner-art"),
    enemyFloats: $("#enemy-float-layer"),
    arena: $("#arena"),
    banner: $("#arena-banner"),
    bannerTitle: $("#banner-title"),
    bannerSub: $("#banner-sub"),
    heroCard: $("#hero-card"),
    heroName: $("#hero-name"),
    heroLevel: $("#hero-level"),
    xpBar: $("#xp-bar"),
    xpCaption: $("#xp-caption"),
    levelCaption: $("#level-caption"),
    heroHpBar: $("#hero-hp-bar"),
    heroHpTrack: $(".bar-hp"),
    heroHpText: $("#hero-hp-text"),
    heroEnergyBar: $("#hero-energy-bar"),
    heroEnergyText: $("#hero-energy-text"),
    heroFloats: $("#hero-float-layer"),
    buffRow: $("#buff-row"),
    walletCoins: $("#wallet-coins"),
    walletPoints: $("#wallet-points"),
    walletGold: $("#wallet-gold"),
    actions: [...document.querySelectorAll("[data-action]")],
    strikeBtn: $('[data-action="strike"]'),
    energyHint: $("#energy-hint"),
    dockHelp: $("#dock-help"),
    helpBtn: $("#help-btn"),
    log: $("#battle-log"),
    questTitle: $("#quest-title"),
    questObjective: $("#quest-objective"),
    inventory: $("#inventory-list"),
    invCount: $("#inv-count"),
    coinBalance: $("#coin-balance"),
    shopList: $("#shop-list"),
    toast: $("#toast"),
    onboard: $("#onboard"),
    onboardImg: $("#onboard-img"),
    onboardKicker: $("#onboard-kicker"),
    onboardTitle: $("#onboard-title"),
    onboardContent: $("#onboard-content"),
    onboardDots: $("#onboard-dots"),
    onboardNext: $("#onboard-next"),
    onboardClose: $("#onboard-close"),
  };

  /* ---------- inline SVG icon library (no emoji in the UI) ---------- */
  const SVG_OPEN = '<svg viewBox="0 0 24 24">';
  const ICONS = {
    sword: SVG_OPEN + '<path d="M14.5 5.5 18 2l4 4-3.5 3.5M16 4l4 4M14.5 5.5 4 16l-1.5 4.5L7 19 17.5 8.5"/></svg>',
    shield: SVG_OPEN + '<path d="M12 3 5 5.8v5.4c0 4.4 2.9 7.6 7 9.8 4.1-2.2 7-5.4 7-9.8V5.8z"/></svg>',
    eye: SVG_OPEN + '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/></svg>',
    flame: SVG_OPEN + '<path d="M12 3c.8 4-3 5.4-3 9a5 5 0 0 0 10 0c0-1.5-.6-2.7-1.4-3.7-.3 1.2-1 2.1-2.1 2.7.7-2.7-.6-6-3.5-8z"/></svg>',
    trophy: SVG_OPEN + '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 5H4a3 3 0 0 0 3 4M17 5h3a3 3 0 0 1-3 4"/></svg>',
    skull: SVG_OPEN + '<path d="M12 3a8 8 0 0 0-8 8c0 2.9 1.6 5.4 4 6.7V21h8v-3.3c2.4-1.3 4-3.8 4-6.7a8 8 0 0 0-8-8z"/><path d="M9 11h.01M15 11h.01M10 17h.01M14 17h.01"/></svg>',
    spark: SVG_OPEN + '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
    check: SVG_OPEN + '<path d="m4.5 12.5 5 5L19.5 7"/></svg>',
    coin: SVG_OPEN + '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.2 9.7c.6-1 1.6-1.4 2.8-1.4 1.5 0 2.7.7 2.7 2 0 2.9-5.4 1.7-5.4 4.4 0 1.3 1.2 2 2.7 2 1.2 0 2.2-.4 2.8-1.4"/></svg>',
    potion: SVG_OPEN + '<path d="M9 3h6M10 3v5l-5 8a4 4 0 0 0 3.5 6h7a4 4 0 0 0 3.5-6l-5-8V3"/><path d="M7.5 13h9"/></svg>',
    bolt: SVG_OPEN + '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13z"/></svg>',
    clover: SVG_OPEN + '<path d="M12 12c-2.5-4.5.5-9 3.5-7s-.5 6.5-3.5 7zm0 0c2.5-4.5-.5-9-3.5-7s.5 6.5 3.5 7zm0 0c4.5-2.5 9 .5 7 3.5s-6.5-.5-7-3.5zm0 0c-4.5-2.5-9 .5-7 3.5s6.5-.5 7-3.5z"/><path d="M12 12v6c0 2 1 3 1 3"/></svg>',
    heart: SVG_OPEN + '<path d="M12 20s-7.5-4.6-9.3-9.2C1.4 7.4 3.6 4.5 6.7 4.5c2 0 3.6 1.1 4.3 2.6.7-1.5 2.3-2.6 4.3-2.6 3.1 0 5.3 2.9 4 6.3C17.5 15.4 12 20 12 20z"/></svg>',
    hammer: SVG_OPEN + '<path d="M3 21l7-7M9.5 13.5 6 10l3-3 3.5 3.5M13 6l5-3 3 3-3 5-3-3z"/></svg>',
    drain: SVG_OPEN + '<path d="M12 3s6 6.4 6 10.2A6 6 0 0 1 6 13.2C6 9.4 12 3 12 3z"/></svg>',
    quake: SVG_OPEN + '<path d="M2 14h4l3-7 3 12 3-9 2 4h5"/></svg>',
    target: SVG_OPEN + '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>',
  };

  const INTENT_ICONS = {
    slash: "sword",
    heavy: "hammer",
    drain: "drain",
    mend: "heart",
    quake: "quake",
  };

  const ENEMY_ART = {
    "Ash Warden": "ash-warden",
    "Rift Stalker": "rift-stalker",
    "Obsidian Herald": "obsidian-herald",
    "Ebon Colossus": "ebon-colossus",
  };

  const SHOP_ICONS = {
    heal: ICONS.potion,
    elixir: ICONS.bolt,
    blade: ICONS.sword,
    ward: ICONS.shield,
    charm: ICONS.clover,
  };

  const LOG_ICONS = {
    strike: ICONS.sword,
    guard: ICONS.shield,
    scout: ICONS.eye,
    rest: ICONS.flame,
    victory: ICONS.trophy,
    enemy: ICONS.skull,
    system: ICONS.spark,
  };

  /* ---------- state ---------- */
  let player = null;
  let busy = false;
  let toastTimer = null;
  let bannerTimer = null;
  let lastEnemyName = null;
  const logEntries = [];

  /* ---------- small helpers ---------- */
  const pct = (value, total) => {
    const num = Number(value) || 0;
    const den = Number(total) || 1;
    return `${Math.max(0, Math.min(100, (num / den) * 100))}%`;
  };

  function setStatus(message, tone) {
    els.status.innerHTML = `<i class="dot"></i>${message}`;
    els.status.classList.toggle("is-error", tone === "error");
    els.status.classList.toggle("is-busy", tone === "busy");
  }

  function showToast(message) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { els.toast.hidden = true; }, 5200);
  }

  function haptic(kind, style) {
    if (!telegram || !telegram.HapticFeedback) return;
    try {
      if (kind === "impact") telegram.HapticFeedback.impactOccurred(style || "medium");
      else telegram.HapticFeedback.notificationOccurred(style || "success");
    } catch (_) { /* unsupported client */ }
  }

  function spawnFloat(layer, text, cls, delay = 0) {
    window.setTimeout(() => {
      const el = document.createElement("div");
      el.className = `float ${cls || ""}`;
      el.textContent = text;
      el.style.left = `${46 + Math.random() * 12}%`;
      layer.append(el);
      window.setTimeout(() => el.remove(), 1350);
    }, delay);
  }

  function shake(element, cls, duration = 480) {
    element.classList.remove(cls);
    void element.offsetWidth; // restart animation
    element.classList.add(cls);
    window.setTimeout(() => element.classList.remove(cls), duration);
  }

  function shardBurst() {
    const burst = document.createElement("div");
    burst.className = "shard-burst";
    for (let i = 0; i < 14; i += 1) {
      const shard = document.createElement("i");
      const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.5;
      const dist = 60 + Math.random() * 90;
      shard.style.setProperty("--sx", `${Math.cos(angle) * dist}px`);
      shard.style.setProperty("--sy", `${Math.sin(angle) * dist - 30}px`);
      shard.style.background = i % 3 === 0 ? "#4ff0d2" : i % 3 === 1 ? "#ffc65c" : "#7c6cff";
      shard.style.animationDelay = `${Math.random() * 0.15}s`;
      burst.append(shard);
    }
    els.enemyCard.append(burst);
    window.setTimeout(() => burst.remove(), 1500);
  }

  function showBanner(title, sub, defeat = false, hold = 2600) {
    window.clearTimeout(bannerTimer);
    els.bannerTitle.textContent = title;
    els.bannerSub.textContent = sub || "";
    els.banner.classList.toggle("is-defeat", defeat);
    els.banner.hidden = false;
    bannerTimer = window.setTimeout(() => { els.banner.hidden = true; }, hold);
  }

  function pushLog(kind, text) {
    logEntries.unshift({ kind, text });
    if (logEntries.length > 6) logEntries.pop();
    renderLog();
  }

  function renderLog() {
    els.log.replaceChildren();
    if (!logEntries.length) {
      const empty = document.createElement("li");
      empty.className = "log-empty";
      empty.textContent = "Your moves and their outcomes will be written here.";
      els.log.append(empty);
      return;
    }
    logEntries.forEach((entry) => {
      const li = document.createElement("li");
      li.className = entry.kind;
      li.innerHTML = LOG_ICONS[entry.kind] || ICONS.spark;
      const span = document.createElement("span");
      span.textContent = entry.text;
      li.append(span);
      els.log.append(li);
    });
  }

  /* ---------- rendering ---------- */
  function swapEnemyArt(name) {
    const key = ENEMY_ART[name];
    if (!key || lastEnemyName === name) {
      lastEnemyName = name;
      return;
    }
    lastEnemyName = name;
    const src = `./art/${key}.jpg`;
    els.enemyImg.classList.add("is-swapping");
    const loader = new Image();
    loader.onload = () => {
      els.enemyImg.src = src;
      els.enemyImg.classList.remove("is-swapping");
    };
    loader.onerror = () => els.enemyImg.classList.remove("is-swapping");
    loader.src = src;
  }

  function renderPlayer(view) {
    player = view;
    const { hero, quest, enemy } = view;
    const battle = view.battle || {};

    els.chapter.textContent = `CH ${quest.chapter}`;
    els.heroName.textContent = hero.name;
    els.heroLevel.textContent = hero.level;
    els.heroHpText.textContent = `${hero.hp} / ${hero.max_hp}`;
    els.heroEnergyText.textContent = `${hero.energy} / ${hero.max_energy}`;
    els.heroHpBar.style.width = pct(hero.hp, hero.max_hp);
    els.heroEnergyBar.style.width = pct(hero.energy, hero.max_energy);
    els.heroHpTrack.classList.toggle("is-low", hero.max_hp > 0 && hero.hp / hero.max_hp <= 0.3);
    els.xpBar.style.width = pct(hero.progress || 0, 1);
    els.xpCaption.textContent = `${hero.xp} XP — ${hero.xp_to_next} to level ${hero.level + 1}`;
    els.levelCaption.textContent = "";

    els.walletCoins.textContent = hero.coins;
    els.walletPoints.textContent = hero.points;
    els.walletGold.textContent = hero.gold;
    els.coinBalance.textContent = hero.coins;

    els.enemyName.textContent = enemy.name;
    els.enemyAttack.textContent = enemy.attack ?? "—";
    els.bossTag.hidden = !enemy.boss;
    els.enemyHpBar.style.width = pct(enemy.hp, enemy.max_hp);
    els.enemyHpText.textContent = `${enemy.hp} / ${enemy.max_hp}`;
    els.exposedChip.hidden = !battle.exposed;
    swapEnemyArt(enemy.name);
    renderIntent(enemy.intent || null);
    renderFocus(hero);

    const burning = Number(battle.burn || 0);
    els.burnChip.hidden = burning <= 0;
    els.burnTurns.textContent = burning;

    const canFinish = Boolean(battle.can_finish);
    els.strikeBtn.classList.toggle("is-finisher", canFinish);
    els.strikeSub.textContent = canFinish
      ? "FINISH IT — this hit can end the fight"
      : "4–8 + LV damage · a perfect roll CRITS ×1.5";
    els.coachText.textContent = coachTip(hero, enemy, battle);

    const buffs = [];
    if (hero.attack_bonus > 0) buffs.push(`<span class="buff">STRIKE +${hero.attack_bonus}</span>`);
    if (hero.ward_bonus > 0) buffs.push(`<span class="buff">WARD +${hero.ward_bonus}</span>`);
    if (hero.luck) buffs.push(`<span class="buff buff-violet">LUCKY SCOUT</span>`);
    if (!buffs.length) buffs.push('<span class="buff buff-muted">No relics yet — earn coins and visit the Marketplace</span>');
    els.buffRow.innerHTML = buffs.join("");

    els.questTitle.textContent = quest.title.startsWith("Chapter")
      ? quest.title
      : `Chapter ${quest.chapter}: ${quest.title}`;
    els.questObjective.textContent = quest.objective;

    const items = view.inventory || [];
    els.invCount.textContent = items.length;
    els.inventory.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "relic relic-empty";
      empty.textContent = "Empty — relics from the Marketplace appear here.";
      els.inventory.append(empty);
    } else {
      items.forEach((name) => {
        const chip = document.createElement("span");
        chip.className = "relic";
        chip.textContent = name;
        els.inventory.append(chip);
      });
    }

    const strikingAllowed = hero.energy > 0;
    els.energyHint.hidden = strikingAllowed;
    els.strikeBtn.classList.toggle("is-unaffordable", !strikingAllowed);

    renderShop(view.shop || [], hero.coins);
  }


  function renderIntent(intent) {
    if (!intent) {
      els.intentCard.hidden = true;
      return;
    }
    els.intentCard.hidden = false;
    els.intentIc.innerHTML = ICONS[INTENT_ICONS[intent.id] || "sword"] || ICONS.sword;
    els.intentName.textContent = intent.name;
    els.intentAdvice.textContent = intent.advice || "";
    if (intent.kind === "heal") {
      els.intentNum.textContent = `+${intent.heal}`;
      els.intentNum.className = "intent-num is-heal";
    } else {
      els.intentNum.textContent = `${intent.damage}`;
      els.intentNum.className = intent.damage >= 8 ? "intent-num is-danger" : "intent-num";
    }
    els.intentCard.classList.toggle("is-danger", intent.damage >= 8);
    els.intentCard.classList.toggle("is-heal", intent.kind === "heal");
  }

  function renderFocus(hero) {
    const max = Number(hero.max_focus || 3);
    const value = Number(hero.focus || 0);
    els.focusPips.replaceChildren();
    for (let i = 0; i < max; i += 1) {
      const pip = document.createElement("i");
      pip.className = i < value ? "pip on" : "pip";
      els.focusPips.append(pip);
    }
    els.focusNote.textContent = value >= max
      ? `Full! Strike now for +${value * 2} bonus damage`
      : value > 0
        ? `+${value * 2} bonus damage on your next Strike`
        : "Guard · Scout · Rest build Focus — Strike spends it";
  }

  /* One always-correct suggestion so nobody stares blankly at four buttons. */
  function coachTip(hero, enemy, battle) {
    const intent = enemy.intent || {};
    const incoming = Number(intent.damage || 0);
    if (hero.hp <= 0) return "Tap any move to wake at camp, fully healed.";
    if (battle.can_finish) return "Strike — this hit can finish the enemy right now.";
    if (intent.kind === "heal") return "Strike — it is about to heal itself, so hurt it first.";
    if (hero.hp <= incoming) return "Guard or Rest — that next hit could drop you.";
    if (incoming >= 8) return `Guard — a ${incoming} damage ${intent.name || "hit"} is coming.`;
    if (hero.energy <= 0) return "Rest or Guard — you need Rift Energy before you can Strike.";
    if (hero.hp / Math.max(1, hero.max_hp) <= 0.4) return "Rest — heal up before trading blows.";
    if (Number(hero.focus || 0) >= Number(hero.max_focus || 3)) return "Strike — your Focus meter is full, cash it in.";
    if (!battle.exposed) return "Scout — expose the enemy (+2 next Strike) and build Focus.";
    return "Strike — the enemy is exposed and your Focus is charged.";
  }

  function renderShop(shop, coins) {
    els.shopList.replaceChildren();
    if (!shop.length) {
      const empty = document.createElement("p");
      empty.className = "market-note";
      empty.textContent = "The Marketplace is empty today.";
      els.shopList.append(empty);
      return;
    }
    shop.forEach((item) => {
      const affordable = coins >= item.cost;
      const card = document.createElement("div");
      card.className = "shop-card";

      const icon = document.createElement("span");
      icon.className = "shop-ic";
      if (item.art) {
        const art = document.createElement("img");
        art.src = `./art/${item.art}.jpg`;
        art.alt = "";
        art.loading = "lazy";
        art.addEventListener("error", () => {
          icon.innerHTML = SHOP_ICONS[item.id] || ICONS.spark;
        });
        icon.classList.add("has-art");
        icon.append(art);
      } else {
        icon.innerHTML = SHOP_ICONS[item.id] || ICONS.spark;
      }

      const info = document.createElement("div");
      info.className = "shop-info";
      const kind = item.kind === "upgrade" ? "PERMANENT RELIC" : "CONSUMABLE";
      info.innerHTML = `<span class="shop-kind">${kind}</span>`;
      const title = document.createElement("strong");
      title.textContent = item.name;
      const desc = document.createElement("small");
      desc.textContent = item.desc;
      info.append(title, desc);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "shop-buy";
      button.disabled = !affordable || busy;
      button.innerHTML = `${item.cost} ${ICONS.coin}`;
      button.setAttribute("aria-label", `Buy ${item.name} for ${item.cost} coins`);
      button.addEventListener("click", () => buyItem(item.id));

      card.append(icon, info, button);
      els.shopList.append(card);
    });
  }

  /* ---------- networking ---------- */
  async function request(path, options = {}) {
    const initData = telegram && telegram.initData;
    if (!initData) {
      throw new Error("Open ChronicleRift from its Telegram bot to authenticate your hero.");
    }
    const response = await fetch(path, {
      ...options,
      headers: { "X-Telegram-Init-Data": initData, ...(options.headers || {}) },
      credentials: "same-origin",
    });
    let data = null;
    try { data = await response.json(); } catch (_) { /* error body optional */ }
    if (!response.ok) throw new Error((data && data.detail) || "The rift could not answer that request.");
    return data;
  }

  /* ---------- battle turn flow ---------- */
  function setBusy(next, pendingAction) {
    busy = next;
    document.body.classList.toggle("is-resolving", next);
    els.actions.forEach((button) => {
      button.disabled = next;
      button.classList.toggle("is-pending", next && button.dataset.action === pendingAction);
    });
    if (player) renderShop(player.shop || [], player.hero.coins);
  }

  function animateTurn(turn, view) {
    const fx = turn.effects || {};
    const arena = els.arena;

    // Hero-side gains first (they read instantly).
    if (fx.healed > 0) spawnFloat(els.heroFloats, `+${fx.healed} HP`, "heal");
    if (fx.insight > 0) spawnFloat(els.heroFloats, `+${fx.insight} XP`, "xp", 90);
    if (fx.energy_delta > 0) spawnFloat(els.heroFloats, `+${fx.energy_delta} EN`, "energy", 160);
    if (fx.ward > 0) spawnFloat(els.heroFloats, `WARD ${fx.ward}`, "energy", 120);

    // Enemy-side impact.
    if (fx.damage > 0) {
      shake(els.enemyCard, "is-hit");
      shake(arena, "is-shaking");
      spawnFloat(els.enemyFloats, fx.crit ? `CRIT -${fx.damage}` : `-${fx.damage}`, fx.crit ? "crit" : "dmg");
      haptic("impact", fx.crit ? "heavy" : "medium");
    }
    if (fx.reflect > 0) spawnFloat(els.enemyFloats, `REFLECT -${fx.reflect}`, "reflect", 220);
    if (fx.burn_damage > 0) spawnFloat(els.enemyFloats, `BURN -${fx.burn_damage}`, "burn", 60);
    if (fx.burn_applied > 0) spawnFloat(els.enemyFloats, "BURNING!", "burn", 260);
    if (fx.focus_spent > 0) spawnFloat(els.heroFloats, `FOCUS x${fx.focus_spent}`, "level", 40);
    if (fx.focus_gained > 0) spawnFloat(els.heroFloats, "+1 FOCUS", "energy", 200);
    if (fx.blocked > 0) spawnFloat(els.heroFloats, `BLOCKED ${fx.blocked}`, "energy", 260);
    if (fx.energy_drained > 0) spawnFloat(els.heroFloats, `-${fx.energy_drained} EN`, "hurt", 300);
    if (fx.enemy_healed > 0) spawnFloat(els.enemyFloats, `+${fx.enemy_healed} HP`, "heal", 240);
    if (fx.enemy_damage > 0) {
      shake(els.heroCard, "is-hit");
      spawnFloat(els.heroFloats, `-${fx.enemy_damage} HP`, "hurt", 320);
    }

    if (fx.victory) {
      shardBurst();
      setScene("victory");
      shake(els.enemyCard, "is-defeated", 1600);
      const parts = [];
      if (fx.gold_gained) parts.push(`+${fx.gold_gained} gold`);
      if (fx.coins_gained) parts.push(`+${fx.coins_gained} coins`);
      if (fx.points_gained) parts.push(`+${fx.points_gained} points`);
      showBanner("VICTORY", `Chapter ${view.quest.chapter} opens · ${parts.join(" · ")}`);
      spawnFloat(els.heroFloats, `+${fx.coins_gained} COINS`, "level", 380);
      if (fx.leveled_up) spawnFloat(els.heroFloats, "LEVEL UP!", "level", 640);
      pushLog("victory", turn.summary);
      haptic("notify", "success");
    } else if (fx.defeated) {
      setScene("camp");
      showBanner("DOWN BUT SAFE", "The Chronicle keeps all progress — wake at camp, fully healed.", true);
      pushLog("enemy", turn.summary);
      haptic("notify", "warning");
    } else if (fx.revived) {
      setScene("camp");
      showToast("You wake at camp, fully healed. The fight continues.");
      pushLog("system", turn.summary);
    } else {
      setScene(turn.action === "rest" ? "camp" : "realm");
      pushLog(turn.action || "system", turn.summary);
    }
  }

  let currentScene = null;
  function setScene(name) {
    if (currentScene === name) return;
    currentScene = name;
    els.arena.style.setProperty("--scene", `url("./art/${name === "victory" ? "victory" : name === "camp" ? "camp" : "realm"}.jpg")`);
    if (name === "victory") window.setTimeout(() => { if (currentScene === "victory") setScene("realm"); }, 2600);
  }

  async function resolveAction(action) {
    if (busy) return;
    if (action === "strike" && player && player.hero.energy <= 0) {
      showToast("Strike needs 1 Rift Energy. Guard, Scout, or Rest to refill it.");
      shake(els.strikeBtn, "is-hit", 320);
      haptic("notify", "error");
      return;
    }
    setBusy(true, action);
    haptic("impact", "medium");
    setStatus("Resolving…", "busy");
    try {
      const data = await request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      renderPlayer(data.player);
      animateTurn(data.turn, data.player);
      setStatus("Verified", "ok");
    } catch (error) {
      setStatus("Reconnect needed", "error");
      showToast(error instanceof Error ? error.message : "The rift briefly lost its signal.");
      pushLog("system", "The rift briefly lost its signal — try that move again.");
      haptic("notify", "error");
    } finally {
      setBusy(false);
    }
  }

  async function buyItem(itemId) {
    if (busy) return;
    setBusy(true);
    haptic("impact", "soft");
    setStatus("Purchasing…", "busy");
    try {
      const data = await request("/api/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId }),
      });
      renderPlayer(data.player);
      if (data.turn && data.turn.success) {
        showToast(data.turn.summary);
        pushLog("system", data.turn.summary);
        spawnFloat(els.heroFloats, "RELIC CLAIMED", "level");
        haptic("notify", "success");
      } else {
        showToast((data.turn && data.turn.summary) || "That purchase could not be completed.");
      }
      setStatus("Verified", "ok");
    } catch (error) {
      setStatus("Reconnect needed", "error");
      showToast(error instanceof Error ? error.message : "The Marketplace briefly lost its signal.");
      haptic("notify", "error");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- how-to-play onboarding ---------- */
  const SLIDES = [
    {
      kicker: "HOW TO PLAY · 1 OF 4",
      img: "./art/intro-arena.jpg",
      title: "What is ChronicleRift?",
      html: `<p>It is a <b>turn-based fantasy RPG inside Telegram</b>. You are a Riftwalker. One monster guards each chapter — <b>empty its HP bar</b> and the chapter is yours.</p>
        <ul class="onboard-list">
          <li>${ICONS.sword}<span><b>You tap ONE move per turn.</b> Then the enemy answers. That is the entire game.</span></li>
          <li>${ICONS.coin}<span><b>Every win pays Gold, Coins and Points</b>, and a stronger monster steps up.</span></li>
          <li>${ICONS.check}<span><b>You can never lose progress.</b> At 0 HP you just wake at camp, fully healed.</span></li>
        </ul>`,
      cta: "The four moves",
    },
    {
      kicker: "HOW TO PLAY · 2 OF 4",
      img: "./art/intro-moves.jpg",
      title: "Your four moves",
      html: `<div class="move-rows">
          <div class="move-row strike"><span class="action-ic">${ICONS.sword}</span><div><b>Strike — costs 1 Energy</b><span class="line">Roll 4–8 + Level + gear + Focus. A perfect roll is a <b>CRITICAL ×1.5</b> that sets the enemy on fire.</span></div></div>
          <div class="move-row guard"><span class="action-ic">${ICONS.shield}</span><div><b>Guard — free, +1 Energy</b><span class="line">Blocks 2–5 of the incoming hit. A perfect ward <b>reflects 2 damage</b>.</span></div></div>
          <div class="move-row scout"><span class="action-ic">${ICONS.eye}</span><div><b>Scout — free, +1 Energy</b><span class="line">+1–3 XP and <b>EXPOSES</b> the enemy: your next Strike deals +2.</span></div></div>
          <div class="move-row rest"><span class="action-ic">${ICONS.flame}</span><div><b>Rest — free, +2 Energy</b><span class="line">Recovers 4–7 HP beside the ember shrine.</span></div></div>
        </div>
        <p>Only Strike costs Energy. The other three are free and refill it — that is the rhythm of every fight.</p>`,
      cta: "Read the enemy",
    },
    {
      kicker: "HOW TO PLAY · 3 OF 4",
      img: "./art/ash-warden.jpg",
      title: "Read the enemy, build Focus",
      html: `<p>The enemy <b>always shows its next move</b> in the purple <b>NEXT ENEMY MOVE</b> card — and it always does exactly that. No guessing.</p>
        <ul class="onboard-list">
          <li>${ICONS.hammer}<span><b>Heavy Blow / Rift Quake</b> — a big number. <b>Guard</b> this turn.</span></li>
          <li>${ICONS.heart}<span><b>Mend</b> — it is about to heal itself. <b>Strike</b> immediately.</span></li>
          <li>${ICONS.drain}<span><b>Rift Drain</b> — it steals 1 Energy. Rest or Guard to stay armed.</span></li>
          <li>${ICONS.target}<span><b>FOCUS is your combo meter.</b> Guard, Scout and Rest each add 1 (max 3); your next Strike spends it all for <b>+2 damage per point</b>.</span></li>
        </ul>
        <p class="onboard-tip">The classic combo: <b>Scout → Guard → Strike</b>. Exposed +2, two Focus +4, all in one swing.</p>`,
      cta: "Coins & relics",
    },
    {
      kicker: "HOW TO PLAY · 4 OF 4",
      img: "./art/intro-market.jpg",
      title: "Spend your coins, chase the bosses",
      html: `<ul class="onboard-list">
          <li>${ICONS.potion}<span><b>Potions are instant:</b> Healing Draught (+15 HP) and Rift Elixir (+3 Energy).</span></li>
          <li>${ICONS.sword}<span><b>Relics are permanent:</b> Rift Steel (+2 Strike), Aegis Sigil (+2 Ward), Luck Charm (+1 Scout insight).</span></li>
          <li>${ICONS.skull}<span><b>Every 5th chapter is a boss.</b> The Ebon Colossus hits harder and pays <b>double</b>.</span></li>
          <li>${ICONS.spark}<span><b>Stuck?</b> The <b>Tip</b> line above the buttons always tells you the smart move.</span></li>
        </ul>
        <p>Everything is saved server-side — keep playing here or from the bot with /play.</p>`,
      cta: "Enter the Rift",
    },
  ];

  let slideIndex = 0;

  function renderSlide() {
    const slide = SLIDES[slideIndex];
    els.onboardKicker.textContent = slide.kicker;
    els.onboardTitle.textContent = slide.title;
    els.onboardContent.innerHTML = slide.html;
    if (!els.onboardImg.src.endsWith(slide.img)) els.onboardImg.src = slide.img;
    els.onboardDots.replaceChildren();
    SLIDES.forEach((_, i) => {
      const dot = document.createElement("i");
      dot.classList.toggle("on", i === slideIndex);
      els.onboardDots.append(dot);
    });
    els.onboardNext.textContent = slide.cta;
  }

  function openOnboard(index = 0) {
    slideIndex = index;
    renderSlide();
    els.onboard.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeOnboard() {
    els.onboard.hidden = true;
    document.body.style.overflow = "";
    try { localStorage.setItem("cr_tutorial_v2", "seen"); } catch (_) { /* private mode */ }
  }

  function nextSlide() {
    if (slideIndex < SLIDES.length - 1) {
      slideIndex += 1;
      renderSlide();
      haptic("impact", "light");
    } else {
      closeOnboard();
      haptic("notify", "success");
    }
  }

  /* ---------- boot ---------- */
  async function loadPlayer() {
    setStatus("Verifying…", "busy");
    const data = await request("/api/me");
    renderPlayer(data.player);
    setStatus("Verified", "ok");
    pushLog("system", `Chapter ${data.player.quest.chapter} — ${data.player.enemy.name} blocks the path.`);
  }

  async function boot() {
    els.actions.forEach((button) => {
      button.addEventListener("click", () => resolveAction(button.dataset.action));
    });
    els.helpBtn.addEventListener("click", () => openOnboard(0));
    els.dockHelp.addEventListener("click", () => openOnboard(1));
    els.onboardClose.addEventListener("click", closeOnboard);
    els.onboardNext.addEventListener("click", nextSlide);
    els.onboard.addEventListener("click", (event) => {
      if (event.target.hasAttribute("data-close")) closeOnboard();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.onboard.hidden) closeOnboard();
    });

    if (!telegram) {
      setStatus("Open in Telegram", "error");
      showToast("Open ChronicleRift from its Telegram bot to command your hero.");
      els.actions.forEach((button) => { button.disabled = true; });
      openOnboard(0);
      return;
    }
    telegram.ready();
    telegram.expand();

    try {
      await loadPlayer();
      let seen = null;
      try { seen = localStorage.getItem("cr_tutorial_v2"); } catch (_) { /* private mode */ }
      if (!seen) openOnboard(0);
    } catch (error) {
      setStatus("Authentication failed", "error");
      showToast(error instanceof Error ? error.message : "Unable to authenticate this Mini App session.");
      els.actions.forEach((button) => { button.disabled = true; });
    }
  }

  void boot();
})();
