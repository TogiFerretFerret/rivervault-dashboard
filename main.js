const { Plugin, ItemView } = require("obsidian");
const net = require("net");
const { spawn } = require("child_process");
const VIEW_TYPE = "rivervault-dashboard";

class LyricsManager {
  constructor(onLyricsUpdate) {
    this.onLyricsUpdate = onLyricsUpdate;
    this.socket = null;
    this.lrcsncProcess = null;
    this.reconnectTimer = null;
    this.isSocketAlive = false;
    this.socketBuffer = "";
    this.lrcsncBuffer = "";
  }

  start() {
    this.connectSocket();
  }

  connectSocket() {
    this.cleanupSocket();
    this.cleanupLrcsnc();

    const socketPath = "/tmp/lazyspotify-lyrics.sock";
    
    this.socket = net.createConnection({ path: socketPath });
    
    this.socket.on("connect", () => {
      this.isSocketAlive = true;
      this.socketBuffer = "";
      this.cleanupLrcsnc();
    });

    this.socket.on("data", (data) => {
      this.socketBuffer += data.toString();
      let lines = this.socketBuffer.split("\n");
      this.socketBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          this.handleUpdate(obj);
        } catch (e) {}
      }
    });

    const handleErrorOrClose = () => {
      if (this.isSocketAlive) {
        this.isSocketAlive = false;
        this.startLrcsnc();
      } else if (!this.lrcsncProcess) {
        this.startLrcsnc();
      }
      this.scheduleReconnect();
    };

    this.socket.on("error", handleErrorOrClose);
    this.socket.on("close", handleErrorOrClose);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isSocketAlive) {
        this.connectSocket();
      }
    }, 5000);
  }

  startLrcsnc() {
    this.cleanupLrcsnc();
    if (this.isSocketAlive) return;

    this.lrcsncProcess = spawn("lrcsnc", ["--no-log"]);
    this.lrcsncBuffer = "";

    this.lrcsncProcess.stdout.on("data", (data) => {
      if (this.isSocketAlive) {
        this.cleanupLrcsnc();
        return;
      }
      this.lrcsncBuffer += data.toString();
      let lines = this.lrcsncBuffer.split("\n");
      this.lrcsncBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          this.handleUpdate(obj);
        } catch (e) {}
      }
    });

    this.lrcsncProcess.on("error", () => {});

    this.lrcsncProcess.on("close", () => {
      if (!this.isSocketAlive) {
        setTimeout(() => this.startLrcsnc(), 5000);
      }
    });
  }

  handleUpdate(obj) {
    if (obj.playing === false) {
      this.onLyricsUpdate({ prior: "", current: "", next: "" });
      return;
    }
    const current = obj.line_text || obj.text || "";
    const prior = obj.prior || "";
    const next = obj.next || "";
    this.onLyricsUpdate({ prior, current, next });
  }

  cleanupSocket() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  cleanupLrcsnc() {
    if (this.lrcsncProcess) {
      this.lrcsncProcess.kill();
      this.lrcsncProcess = null;
    }
  }

  destroy() {
    this.cleanupSocket();
    this.cleanupLrcsnc();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

class DashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this._intervals = [];
    this.lyricsManager = null;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Dashboard"; }
  getIcon() { return "layout-dashboard"; }

  async onOpen() {
    const c = this.containerEl.children[1];
    c.empty();
    c.addClass("rv-dashboard");

    const vault = this.app.vault;
    const files = vault.getMarkdownFiles();
    const recent = files.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 6);
    const folders = [...new Set(files.map(f => f.parent?.path).filter(p => p && p !== "/"))];

    c.innerHTML = `<div class="rv-grid">
      <div class="rv-card">
        <div class="rv-card-title">Time</div>
        <div class="rv-clock-time" id="rv-clock">00:00</div>
        <div class="rv-clock-date" id="rv-date"></div>
        <div class="rv-clock-day" id="rv-day"></div>
        <div class="rv-clock-greeting" id="rv-greeting"></div>
      </div>

      <div class="rv-card rv-pomo">
        <div class="rv-card-title">Pomodoro</div>
        <div class="rv-pomo-ring"><div class="rv-pomo-time" id="rv-pomo-time">25:00</div><div class="rv-pomo-mode" id="rv-pomo-mode">Focus</div></div>
        <div class="rv-pomo-tabs">
          <button class="rv-pomo-tab active" data-mode="work">Focus</button>
          <button class="rv-pomo-tab" data-mode="short">Short</button>
          <button class="rv-pomo-tab" data-mode="long">Long</button>
        </div>
        <div class="rv-pomo-config"><span>Focus</span><input id="rv-pomo-min" type="number" value="25" min="1" max="180"><span>min</span></div>
        <div class="rv-pomo-config"><span>Goal</span><input id="rv-pomo-goal" type="number" value="8" min="1" max="24" step="0.25"><span>hr</span></div>
        <div class="rv-pomo-goal-bar"><div class="rv-pomo-goal-fill" id="rv-pomo-goal-fill"></div></div>
        <div class="rv-pomo-goal-meta"><span id="rv-pomo-goal-done">0m / 8h</span><span id="rv-pomo-goal-pct">0%</span></div>
        <div class="rv-pomo-status" id="rv-pomo-status">Ready to focus</div>
        <div class="rv-pomo-controls">
          <button class="rv-pomo-btn primary" id="rv-pomo-start">▶ Start</button>
          <button class="rv-pomo-btn" id="rv-pomo-reset">↻ Reset</button>
          <button class="rv-pomo-btn" id="rv-pomo-skip">⏭</button>
        </div>
      </div>

      <div class="rv-card">
        <div class="rv-card-title">Tasks</div>
        <div class="rv-task-list" id="rv-task-list"></div>
        <input class="rv-task-input" id="rv-task-input" type="text" placeholder="New task…" autocomplete="off">
      </div>

      <div class="rv-card">
        <div class="rv-card-title">System</div>
        <div class="rv-sys-rows">
          <div class="rv-sys-row"><div class="rv-sys-header"><span>CPU</span><span class="rv-sys-val" id="rv-cpu-val">—</span></div><div class="rv-sys-bar"><div class="rv-sys-fill rv-fill-cpu" id="rv-cpu-bar"></div></div></div>
          <div class="rv-sys-row"><div class="rv-sys-header"><span>RAM</span><span class="rv-sys-val" id="rv-ram-val">—</span></div><div class="rv-sys-bar"><div class="rv-sys-fill rv-fill-ram" id="rv-ram-bar"></div></div></div>
          <div class="rv-sys-row"><div class="rv-sys-header"><span>Temp</span><span class="rv-sys-val" id="rv-temp-val">—</span></div><div class="rv-sys-bar"><div class="rv-sys-fill rv-fill-temp" id="rv-temp-bar"></div></div></div>
        </div>
      </div>

      <div class="rv-card rv-lyrics" id="rv-lyrics-card">
        <div class="rv-card-title">Lyrics</div>
        <div class="rv-lyrics-container">
          <div class="rv-lyrics-line prior" id="rv-lyrics-prior"></div>
          <div class="rv-lyrics-line active rv-lyrics-empty" id="rv-lyrics-active">No lyrics playing</div>
          <div class="rv-lyrics-line next" id="rv-lyrics-next"></div>
        </div>
      </div>

      <div class="rv-card rv-vault-stats">
        <div class="rv-card-title">Vault</div>
        <div class="rv-vstats-grid">
          <div class="rv-vstat"><span class="rv-vstat-num">${files.length}</span><span class="rv-vstat-label">notes</span></div>
          <div class="rv-vstat"><span class="rv-vstat-num">${folders.length}</span><span class="rv-vstat-label">folders</span></div>
          <div class="rv-vstat"><span class="rv-vstat-num" id="rv-today-count">0</span><span class="rv-vstat-label">today</span></div>
        </div>
      </div>

      <div class="rv-card rv-folders">
        <div class="rv-card-title">Folders</div>
        <div class="rv-folder-list" id="rv-folder-list"></div>
      </div>

      <div class="rv-card">
        <div class="rv-card-title">Notes</div>
        <textarea class="rv-notes-area" id="rv-notes-area" placeholder="Quick note…" spellcheck="false"></textarea>
      </div>

      <div class="rv-card rv-recent">
        <div class="rv-card-title">Recent Notes</div>
        <div class="rv-recent-list" id="rv-recent-list"></div>
      </div>

      <div class="rv-card">
        <div class="rv-card-title">Actions</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="rv-pomo-btn" id="rv-btn-new" style="width:100%;justify-content:center">📝 New Note</button>
          <button class="rv-pomo-btn" id="rv-btn-search" style="width:100%;justify-content:center">🔍 Search</button>
          <button class="rv-pomo-btn" id="rv-btn-graph" style="width:100%;justify-content:center">🕸 Graph</button>
          <button class="rv-pomo-btn" id="rv-btn-daily" style="width:100%;justify-content:center">📅 Daily Note</button>
        </div>
      </div>
    </div>`;

    const el = (id) => c.querySelector(`#${id}`);

    // Clock
    const updateClock = () => {
      const now = new Date();
      el("rv-clock").textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
      el("rv-date").textContent = now.toLocaleDateString("en-US", { day: "numeric", month: "long" });
      el("rv-day").textContent = now.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
      const h = now.getHours();
      el("rv-greeting").textContent = h < 12 ? "Good morning, River ☀" : h < 17 ? "Good afternoon, River" : "Good evening, River 🌙";
    };
    updateClock();
    this._intervals.push(setInterval(updateClock, 1000));

    // Recent notes
    const rl = el("rv-recent-list");
    for (const f of recent) {
      const item = rl.createEl("div", { cls: "rv-recent-item" });
      item.createEl("span", { text: "📄", cls: "rv-recent-icon" });
      item.createEl("span", { text: f.basename, cls: "rv-recent-name" });
      item.createEl("span", { text: new Date(f.stat.mtime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), cls: "rv-recent-time" });
      item.addEventListener("click", () => this.app.workspace.openLinkText(f.path, "", false));
    }

    // Today count
    const today = new Date();
    const todayCount = files.filter(f => new Date(f.stat.mtime).toDateString() === today.toDateString()).length;
    if (el("rv-today-count")) el("rv-today-count").textContent = todayCount;

    // Folders
    const fl = el("rv-folder-list");
    if (fl) {
      for (const folder of folders.sort().slice(0, 6)) {
        const item = fl.createEl("div", { cls: "rv-recent-item" });
        item.createEl("span", { text: "📁" });
        item.createEl("span", { text: folder, cls: "rv-recent-name" });
        const count = files.filter(f => f.parent?.path === folder).length;
        item.createEl("span", { text: `${count}`, cls: "rv-recent-time" });
      }
    }

    // Buttons
    el("rv-btn-new")?.addEventListener("click", () => this.app.commands.executeCommandById("file-explorer:new-file"));
    el("rv-btn-search")?.addEventListener("click", () => this.app.commands.executeCommandById("global-search:open"));
    el("rv-btn-graph")?.addEventListener("click", () => this.app.commands.executeCommandById("graph:open"));
    el("rv-btn-daily")?.addEventListener("click", () => this.app.commands.executeCommandById("daily-notes"));

    // System stats
    const updateStats = async () => {
      try {
        const r = await fetch("http://localhost:7070/stats");
        const d = await r.json();
        if (el("rv-cpu-val")) el("rv-cpu-val").textContent = `${d.cpu}%`;
        if (el("rv-cpu-bar")) el("rv-cpu-bar").style.width = `${d.cpu}%`;
        if (el("rv-ram-val")) el("rv-ram-val").textContent = `${d.ramUsed} / ${d.ramTotal} GiB`;
        if (el("rv-ram-bar")) el("rv-ram-bar").style.width = `${(d.ramUsed / d.ramTotal) * 100}%`;
        if (d.temp !== null) {
          if (el("rv-temp-val")) el("rv-temp-val").textContent = `${d.temp}°C`;
          if (el("rv-temp-bar")) el("rv-temp-bar").style.width = `${Math.min(d.temp, 100)}%`;
        } else { if (el("rv-temp-val")) el("rv-temp-val").textContent = "N/A"; }
      } catch {}
    };
    updateStats();
    this._intervals.push(setInterval(updateStats, 3000));

    // Tasks (localStorage persisted)
    const TASK_KEY = "rv-dashboard-tasks";
    let tasks = JSON.parse(localStorage.getItem(TASK_KEY) || "[]");
    const renderTasks = () => {
      const tl = el("rv-task-list"); tl.innerHTML = "";
      tasks.forEach((t, i) => {
        const item = tl.createEl("div", { cls: `rv-task-item ${t.done ? "done" : ""}` });
        item.createEl("div", { cls: "rv-task-check" });
        item.createEl("span", { text: t.text, cls: "rv-task-text" });
        item.addEventListener("click", () => { tasks[i].done = !tasks[i].done; localStorage.setItem(TASK_KEY, JSON.stringify(tasks)); renderTasks(); });
      });
    };
    renderTasks();
    el("rv-task-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.value.trim()) {
        tasks.push({ text: e.target.value.trim(), done: false });
        localStorage.setItem(TASK_KEY, JSON.stringify(tasks));
        e.target.value = "";
        renderTasks();
      }
    });

    // Notes (localStorage persisted)
    const NOTES_KEY = "rv-dashboard-notes";
    const notesArea = el("rv-notes-area");
    if (notesArea) {
      notesArea.value = localStorage.getItem(NOTES_KEY) || "";
      notesArea.addEventListener("input", () => localStorage.setItem(NOTES_KEY, notesArea.value));
    }

    // Pomodoro
    let pomoState = { mode: "work", running: false, seconds: 25 * 60, totalFocused: 0 };
    const POMO_DURATIONS = { work: 25, short: 5, long: 15 };
    const updatePomo = () => {
      const min = Math.floor(pomoState.seconds / 60);
      const sec = pomoState.seconds % 60;
      if (el("rv-pomo-time")) el("rv-pomo-time").textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    };
    const pomoTick = () => {
      if (!pomoState.running) return;
      pomoState.seconds--;
      if (pomoState.mode === "work") pomoState.totalFocused++;
      if (pomoState.seconds <= 0) {
        pomoState.running = false;
        if (el("rv-pomo-start")) el("rv-pomo-start").textContent = "▶ Start";
        if (el("rv-pomo-status")) el("rv-pomo-status").textContent = "Session complete!";
        new Notification("Pomodoro", { body: `${pomoState.mode === "work" ? "Focus" : "Break"} session complete!` });
      }
      updatePomo();
      // Update goal
      const goalHrs = parseFloat(el("rv-pomo-goal")?.value || 8);
      const doneMins = Math.floor(pomoState.totalFocused / 60);
      const pct = Math.min(100, (pomoState.totalFocused / (goalHrs * 3600)) * 100);
      if (el("rv-pomo-goal-done")) el("rv-pomo-goal-done").textContent = `${doneMins}m / ${goalHrs}h`;
      if (el("rv-pomo-goal-pct")) el("rv-pomo-goal-pct").textContent = `${Math.round(pct)}%`;
      if (el("rv-pomo-goal-fill")) el("rv-pomo-goal-fill").style.width = `${pct}%`;
    };
    this._intervals.push(setInterval(pomoTick, 1000));
    updatePomo();

    el("rv-pomo-start")?.addEventListener("click", () => {
      pomoState.running = !pomoState.running;
      el("rv-pomo-start").textContent = pomoState.running ? "⏸ Pause" : "▶ Start";
      el("rv-pomo-status").textContent = pomoState.running ? "Focusing..." : "Paused";
    });
    el("rv-pomo-reset")?.addEventListener("click", () => {
      pomoState.running = false; pomoState.seconds = POMO_DURATIONS[pomoState.mode] * 60;
      el("rv-pomo-start").textContent = "▶ Start";
      el("rv-pomo-status").textContent = "Ready to focus";
      updatePomo();
    });
    el("rv-pomo-skip")?.addEventListener("click", () => {
      const modes = ["work", "short", "work", "short", "work", "long"];
      const ci = modes.indexOf(pomoState.mode);
      pomoState.mode = modes[(ci + 1) % modes.length];
      pomoState.seconds = POMO_DURATIONS[pomoState.mode] * 60;
      pomoState.running = false;
      el("rv-pomo-start").textContent = "▶ Start";
      el("rv-pomo-mode").textContent = pomoState.mode === "work" ? "Focus" : pomoState.mode === "short" ? "Short Break" : "Long Break";
      el("rv-pomo-status").textContent = "Ready";
      c.querySelectorAll(".rv-pomo-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === pomoState.mode));
      updatePomo();
    });
    c.querySelectorAll(".rv-pomo-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        pomoState.mode = tab.dataset.mode;
        pomoState.seconds = POMO_DURATIONS[pomoState.mode] * 60;
        pomoState.running = false;
        el("rv-pomo-start").textContent = "▶ Start";
        el("rv-pomo-mode").textContent = pomoState.mode === "work" ? "Focus" : pomoState.mode === "short" ? "Short Break" : "Long Break";
        el("rv-pomo-status").textContent = "Ready";
        c.querySelectorAll(".rv-pomo-tab").forEach(t => t.classList.toggle("active", t === tab));
        updatePomo();
      });
    });
    el("rv-pomo-min")?.addEventListener("change", (e) => {
      POMO_DURATIONS.work = parseInt(e.target.value) || 25;
      if (pomoState.mode === "work" && !pomoState.running) { pomoState.seconds = POMO_DURATIONS.work * 60; updatePomo(); }
    });

    // Lyrics integration
    this.lyricsManager = new LyricsManager(({ prior, current, next }) => {
      const elPrior = el("rv-lyrics-prior");
      const elActive = el("rv-lyrics-active");
      const elNext = el("rv-lyrics-next");
      if (!elActive) return;

      const animateText = (element, newText, isEmptyActive = false) => {
        if (!element) return;
        const oldText = element.textContent;
        if (oldText === newText) return;

        element.classList.add("lyric-updating");
        
        setTimeout(() => {
          element.textContent = newText;
          if (isEmptyActive) {
            if (!newText || newText === "No lyrics playing") {
              element.classList.add("rv-lyrics-empty");
            } else {
              element.classList.remove("rv-lyrics-empty");
            }
          }
          element.classList.remove("lyric-updating");
        }, 150);
      };

      const activeText = current || "No lyrics playing";
      animateText(elPrior, prior);
      animateText(elActive, activeText, true);
      animateText(elNext, next);
    });
    this.lyricsManager.start();
  }

  async onClose() {
    this._intervals.forEach(i => clearInterval(i));
    if (this.lyricsManager) {
      this.lyricsManager.destroy();
    }
  }
}

module.exports = class RiverVaultDashboard extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.addCommand({ id: "open-dashboard", name: "Open Dashboard", callback: () => this.openDashboard() });
    this.addRibbonIcon("layout-dashboard", "Open Dashboard", () => this.openDashboard());
    this.app.workspace.onLayoutReady(() => this.openDashboard());
  }
  async openDashboard() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
};
