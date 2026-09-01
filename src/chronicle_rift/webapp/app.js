(() => {
  "use strict";

  const telegram = window.Telegram && window.Telegram.WebApp;
  const controls = [...document.querySelectorAll("[data-action]")];
  const status = document.querySelector("#connection-status");
  const toast = document.querySelector("#toast");
  let toastTimer;
  let busy = false;

  function setText(selector, value) {
    const elements = document.querySelectorAll(`[data-bind="${selector}"]`);
    const text = String(value ?? "—");
    elements.forEach((element) => { element.textContent = text; });
  }

  function percentage(value, total) {
    const numerator = Number(value) || 0;
    const denominator = Number(total) || 1;
    return `${Math.max(0, Math.min(100, (numerator / denominator) * 100))}%`;
  }

  function setMeter(id, value, total) {
    const bar = document.querySelector(id);
    if (bar) bar.style.width = percentage(value, total);
  }

  function displayStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 4800);
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    controls.forEach((button) => { button.disabled = nextBusy; });
    document.body.classList.toggle("is-resolving", nextBusy);
  }

  function applyTheme() {
    if (!telegram || !telegram.themeParams) return;
    const theme = telegram.themeParams;
    const root = document.documentElement.style;
    const names = ["bg_color", "secondary_bg_color", "text_color", "hint_color", "button_color", "button_text_color"];
    names.forEach((name) => {
      if (theme[name]) root.setProperty(`--tg-theme-${name.replaceAll("_", "-")}`, theme[name]);
    });
  }

  function renderPlayer(player) {
    const { hero, quest, enemy, inventory, narrative } = player;
    setText("hero-name", hero.name);
    setText("hero-level", hero.level);
    setText("hero-xp", hero.xp);
    setText("hero-gold", hero.gold);
    setText("hero-gold2", hero.gold);
    setText("hero-coins", hero.coins);
    setText("hero-points", hero.points);
    setText("hero-hp", `${hero.hp} / ${hero.max_hp}`);
    setText("hero-energy", `${hero.energy} / ${hero.max_energy}`);
    setText("progress-caption", `${hero.xp} / ${hero.xp_to_next} XP`);
    setText("quest-title", `Chapter ${quest.chapter}: ${quest.title}`);
    setText("quest-objective", quest.objective);
    setText("enemy-art", enemy.art);
    setText("enemy-name", enemy.name);
    setText("enemy-hp", `${enemy.hp} / ${enemy.max_hp}`);
    setText("narrative", narrative);
    setMeter("#hero-hp-bar", hero.hp, hero.max_hp);
    setMeter("#hero-energy-bar", hero.energy, hero.max_energy);
    setMeter("#enemy-hp-bar", enemy.hp, enemy.max_hp);
    const progressBar = document.querySelector("#level-progress-bar");
    if (progressBar) progressBar.style.width = percentage(hero.progress || 0, 1);

    const list = document.querySelector("#inventory-list");
    list.replaceChildren();
    (inventory || []).forEach((item) => {
      const element = document.createElement("li");
      element.textContent = item;
      list.append(element);
    });
    if (!list.children.length) {
      const element = document.createElement("li");
      element.textContent = "No relics found";
      list.append(element);
    }

    renderShop(player.shop, hero.coins);
  }

  function renderShop(shop, coins) {
    const container = document.querySelector("#shop-list");
    if (!container) return;
    container.replaceChildren();
    if (!shop || !shop.length) {
      const element = document.createElement("p");
      element.className = "muted";
      element.textContent = "The Marketplace is empty today.";
      container.append(element);
      return;
    }
    shop.forEach((item) => {
      const affordable = coins >= item.cost;
      const card = document.createElement("div");
      card.className = "shop-card";

      const info = document.createElement("div");
      info.className = "shop-info";
      const title = document.createElement("strong");
      title.textContent = `${item.emoji} ${item.name}`;
      const price = document.createElement("span");
      price.className = "shop-price";
      price.textContent = `${item.cost} 🪙`;
      const desc = document.createElement("small");
      desc.textContent = item.desc;
      info.append(title, price, desc);

      const button = document.createElement("button");
      button.type = "button";
      button.className = `shop-buy ${affordable ? "affordable" : "locked"}`;
      button.textContent = affordable ? "Buy" : "Locked";
      button.disabled = !affordable;
      button.dataset.item = item.id;
      button.addEventListener("click", () => buyItem(item.id));

      card.append(info, button);
      container.append(card);
    });
  }

  async function buyItem(itemId) {
    if (busy) return;
    setBusy(true);
    try {
      if (telegram && telegram.HapticFeedback) telegram.HapticFeedback.impactOccurred("soft");
      displayStatus("Purchasing…");
      const data = await request("/api/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId }),
      });
      renderPlayer(data.player);
      displayStatus("Verified ◈");
      showToast(data.turn ? data.turn.summary : "Purchase complete.");
      if (telegram && telegram.HapticFeedback) {
        telegram.HapticFeedback.notificationOccurred("success");
      }
    } catch (error) {
      displayStatus("Reconnect needed", true);
      showToast(error instanceof Error ? error.message : "The Marketplace briefly lost its signal.");
      if (telegram && telegram.HapticFeedback) telegram.HapticFeedback.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  function initDataHeaders() {
    // Only signed initData is sent. initDataUnsafe is intentionally never used.
    return { "X-Telegram-Init-Data": telegram && telegram.initData ? telegram.initData : "" };
  }

  async function request(path, options = {}) {
    const initData = telegram && telegram.initData;
    if (!initData) throw new Error("Open ChronicleRift from its Telegram bot to authenticate your hero.");
    const response = await fetch(path, {
      ...options,
      headers: { ...initDataHeaders(), ...(options.headers || {}) },
      credentials: "same-origin",
    });
    let data = null;
    try { data = await response.json(); } catch (_) { /* API error body is optional. */ }
    if (!response.ok) throw new Error((data && data.detail) || "The rift could not answer that request.");
    return data;
  }

  async function loadPlayer() {
    displayStatus("Verifying…");
    const data = await request("/api/me");
    renderPlayer(data.player);
    displayStatus("Verified ◈");
  }

  async function resolveAction(action) {
    if (busy) return;
    setBusy(true);
    try {
      if (telegram && telegram.HapticFeedback) telegram.HapticFeedback.impactOccurred("medium");
      displayStatus("Resolving…");
      const data = await request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      renderPlayer(data.player);
      displayStatus("Verified ◈");
      if (telegram && telegram.HapticFeedback) {
        telegram.HapticFeedback.notificationOccurred(data.turn.victory ? "success" : "success");
      }
    } catch (error) {
      displayStatus("Reconnect needed", true);
      showToast(error instanceof Error ? error.message : "The rift briefly lost its signal.");
      if (telegram && telegram.HapticFeedback) telegram.HapticFeedback.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  async function boot() {
    applyTheme();
    if (!telegram) {
      displayStatus("Open in Telegram", true);
      showToast("This tactical board must be opened from the ChronicleRift bot in Telegram.");
      controls.forEach((button) => { button.disabled = true; });
      return;
    }
    telegram.ready();
    telegram.expand();
    try {
      await loadPlayer();
    } catch (error) {
      displayStatus("Authentication failed", true);
      showToast(error instanceof Error ? error.message : "Unable to authenticate this Mini App session.");
      controls.forEach((button) => { button.disabled = true; });
    }
  }

  controls.forEach((button) => {
    button.addEventListener("click", () => resolveAction(button.dataset.action));
  });
  void boot();
})();
