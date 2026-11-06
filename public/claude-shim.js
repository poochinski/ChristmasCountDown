// Connects the countdown page to this app's own server.
// The page was first built as a Claude artifact; this file provides the same small
// `window.claude.use(...)` interface it expects (db, user, sample, assets), backed by /api.
(function () {
  const KEY = "xmas-admin-password";
  const getPw = () => { try { return localStorage.getItem(KEY) || ""; } catch (_) { return ""; } };
  const setPw = v => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (_) {} };
  const authHeaders = extra => { const h = Object.assign({}, extra || {}); const pw = getPw(); if (pw) h["x-admin-password"] = pw; return h; };
  const errFor = status => ({ code: status === 401 ? "invalid_argument" : status === 429 ? "rate_limited" : status === 413 ? "too_large" : status === 415 ? "unsupported_type" : "unavailable" });

  /* ---------- whoami ---------- */
  const whoP = fetch("/api/whoami", { headers: authHeaders(), cache: "no-store" })
    .then(r => r.ok ? r.json() : { owner: false, canFill: false, ownerConfigured: false })
    .catch(() => ({ owner: false, canFill: false, ownerConfigured: false }));

  /* ---------- shared state with polling ---------- */
  let state = {}, loaded = false, pending = 0;
  const subs = {};
  const snap = col => ({ docs: Object.entries(state[col] || {}).map(([id, v]) => ({ id, exists: true, data: () => v })) });
  const notify = col => (subs[col] || []).forEach(s => { try { s.fn(snap(col)); } catch (e) { console.error(e); } });
  async function refresh() {
    if (pending > 0) return;
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw errFor(r.status);
      const next = await r.json();
      if (pending > 0) return;
      state = next; loaded = true;
      Object.keys(subs).forEach(notify);
    } catch (e) {
      Object.values(subs).flat().forEach(s => s.err && s.err(e));
    }
  }
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

  async function write(method, col, id, body, apply) {
    pending++;
    try {
      const r = await fetch("/api/" + col + "/" + encodeURIComponent(id), {
        method,
        headers: authHeaders(body ? { "content-type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw errFor(r.status);
      apply();
      notify(col);
    } finally { pending--; }
  }

  const db = {
    collection(col) {
      const api = {
        limit() { return api; },
        onSnapshot(fn, err) {
          (subs[col] = subs[col] || []).push({ fn, err });
          if (loaded) setTimeout(() => fn(snap(col)), 0); else refresh();
          return () => { subs[col] = (subs[col] || []).filter(s => s.fn !== fn); };
        },
        doc(id) {
          return {
            set: v => write("PUT", col, id, v, () => { (state[col] = state[col] || {})[id] = v; }),
            update: v => write("PATCH", col, id, v, () => { state[col] = state[col] || {}; state[col][id] = Object.assign({}, state[col][id] || {}, v); }),
            delete: () => write("DELETE", col, id, null, () => { if (state[col]) delete state[col][id]; }),
          };
        },
      };
      return api;
    },
    // Visitors' own lists stay in their browser on this site.
    doc() { return { get: async () => ({ exists: false, data: () => undefined }), set: async () => { throw { code: "not_granted" }; } }; },
  };

  /* ---------- capabilities ---------- */
  async function use(name) {
    const who = await whoP;
    if (name === "db") return db;
    if (name === "user") return {
      isOwner: async () => !!who.owner,
      canEdit: async () => !!who.owner,
      can: async () => null,
      id: async () => null,
      me: async () => ({ id: null, name: "", email: null, isOwner: !!who.owner, canEdit: !!who.owner, avatarUrl: "", color: "#888" }),
    };
    if (name === "sample") {
      if (!who.canFill) return null;
      const sample = async input => { const v = await sample.json(typeof input === "string" ? input : JSON.stringify(input)); return { text: JSON.stringify(v), truncated: false }; };
      sample.json = async prompt => {
        const r = await fetch("/api/fill", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ prompt }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw { code: j.code || errFor(r.status).code, message: j.error || "" };
        return j.value;
      };
      return sample;
    }
    if (name === "assets") {
      if (!who.owner) return null;
      return {
        upload: async file => {
          const r = await fetch("/api/posters", { method: "POST", headers: authHeaders({ "content-type": file.type || "application/octet-stream" }), body: file });
          if (!r.ok) throw errFor(r.status);
          return r.json();
        },
        delete: async id => { const r = await fetch("/api/posters/" + encodeURIComponent(id), { method: "DELETE", headers: authHeaders() }); if (!r.ok) throw errFor(r.status); },
      };
    }
    return null;
  }
  window.claude = { use };

  /* ---------- owner sign-in ---------- */
  document.addEventListener("DOMContentLoaded", async () => {
    const box = document.getElementById("ownerBox");
    if (!box) return;
    const who = await whoP;
    box.textContent = "";
    if (who.owner) {
      const p = document.createElement("p"); p.className = "fine";
      p.append("Signed in as the list's owner. ");
      const out = document.createElement("button"); out.type = "button"; out.className = "linkish"; out.textContent = "Sign out";
      out.addEventListener("click", () => { setPw(""); location.reload(); });
      p.append(out); box.append(p);
      return;
    }
    if (!who.ownerConfigured) return;
    const det = document.createElement("details");
    const sum = document.createElement("summary"); sum.textContent = "Owner sign-in"; sum.className = "fine";
    const form = document.createElement("form"); form.className = "owner-form";
    const input = document.createElement("input"); input.type = "password"; input.className = "input"; input.id = "ownerPw"; input.placeholder = "Password"; input.autocomplete = "current-password"; input.setAttribute("aria-label", "Owner password");
    const btn = document.createElement("button"); btn.type = "submit"; btn.className = "btn small"; btn.textContent = "Sign in";
    const msg = document.createElement("p"); msg.className = "fine"; msg.setAttribute("role", "status");
    form.append(input, btn);
    det.append(sum, form, msg);
    box.append(det);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const pw = input.value;
      const r = await fetch("/api/whoami", { headers: { "x-admin-password": pw }, cache: "no-store" }).then(x => x.json()).catch(() => ({}));
      if (r.owner) { setPw(pw); location.reload(); }
      else msg.textContent = "That password didn't work.";
    });
  });
})();
