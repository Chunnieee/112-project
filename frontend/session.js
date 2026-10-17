/*
 * SafeFlow 前端登入狀態
 * 狀態存在 localStorage：
 *   sf.onboarded  → 是否看過功能介紹
 *   sf.session    → { type: "user", token, user } 或 { type: "guest" }
 *   sf.appearance → "auto"（跟著系統）| "light" | "dark"
 */
(function () {
  const ONBOARDED_KEY = "sf.onboarded";
  const SESSION_KEY = "sf.session";
  const WELCOME_PAGE = "welcome.html";
  const HOME_PAGE = "index.html";

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* 私密模式等情況忽略 */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  /* 外觀：auto 跟著系統的深淺色設定；設定 <html data-theme> 讓 CSS 色彩變數切換 */
  const APPEARANCE_KEY = "sf.appearance";
  const APPEARANCES = { auto: "跟著系統", light: "淺色", dark: "深色" };
  const darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const getAppearance = () => (APPEARANCES[store.get(APPEARANCE_KEY)] ? store.get(APPEARANCE_KEY) : "auto");
  const isDark = () => { const a = getAppearance(); return a === "dark" || (a === "auto" && !!darkMQ?.matches); };
  function applyAppearance() {
    const a = getAppearance(), root = document.documentElement;
    if (a === "auto") delete root.dataset.theme; else root.dataset.theme = a;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDark() ? "#0F1412" : "#ECEDE8";
    window.dispatchEvent(new CustomEvent("sf-themechange", { detail: { appearance: a, dark: isDark() } }));
  }
  applyAppearance();
  darkMQ?.addEventListener?.("change", () => { if (getAppearance() === "auto") applyAppearance(); });

  const apiBase = () => (location.protocol === "file:" ? "http://localhost:3000" : "");

  async function api(path, { method = "GET", body, token } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(apiBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error("無法連線到伺服器，請確認後端已啟動"), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "發生錯誤，請稍後再試"), { status: res.status });
    return data;
  }

  const Session = {
    HOME_PAGE,
    WELCOME_PAGE,
    hasOnboarded: () => store.get(ONBOARDED_KEY) === "1",
    markOnboarded: () => store.set(ONBOARDED_KEY, "1"),
    resetOnboarding: () => store.remove(ONBOARDED_KEY),

    APPEARANCES,
    appearance: getAppearance,
    isDark,
    setAppearance(a) { if (APPEARANCES[a]) { store.set(APPEARANCE_KEY, a); applyAppearance(); } },
    /* 依序切換：跟著系統 → 淺色 → 深色 */
    cycleAppearance() { const order = ["auto", "light", "dark"]; this.setAppearance(order[(order.indexOf(getAppearance()) + 1) % 3]); return getAppearance(); },

    get() {
      try { return JSON.parse(store.get(SESSION_KEY) || "null"); } catch { return null; }
    },
    isGuest() { return this.get()?.type === "guest"; },
    displayName() {
      const s = this.get();
      if (!s) return "";
      return s.type === "guest" ? "訪客" : (s.user?.displayName || s.user?.email || "使用者");
    },

    setGuest() { store.set(SESSION_KEY, JSON.stringify({ type: "guest", since: Date.now() })); },
    setUser(token, user) { store.set(SESSION_KEY, JSON.stringify({ type: "user", token, user })); },
    clear() { store.remove(SESSION_KEY); },

    async login(email, password) {
      const data = await api("/api/auth/login", { method: "POST", body: { email, password } });
      this.setUser(data.token, data.user);
      return data.user;
    },
    async register(displayName, email, password) {
      const data = await api("/api/auth/register", { method: "POST", body: { displayName, email, password } });
      this.setUser(data.token, data.user);
      return data.user;
    },
    async logout() {
      const s = this.get();
      if (s?.type === "user" && s.token) {
        await api("/api/auth/logout", { method: "POST", token: s.token }).catch(() => {});
      }
      this.clear();
      location.replace(WELCOME_PAGE + "#auth");
    },

    /* 首頁使用：沒有登入也不是訪客 → 回到引導頁；有 token 則背景確認是否仍有效 */
    guard() {
      const s = this.get();
      if (!s) {
        location.replace(WELCOME_PAGE);
        return false;
      }
      if (s.type === "user" && s.token) {
        api("/api/auth/me", { token: s.token })
          .then((data) => this.setUser(s.token, data.user))
          .catch((err) => {
            if (err.status === 401) { this.clear(); location.replace(WELCOME_PAGE + "#auth"); }
          });
      }
      return true;
    },
  };

  window.SafeFlowSession = Session;
})();
