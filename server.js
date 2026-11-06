// Christmas Movie Countdown server.
// Serves the page, stores the owner's list (movies, watched, ratings, seen) and poster images,
// and optionally fills in movie details with Claude.
// Storage: Postgres when DATABASE_URL is set (Railway), otherwise a local data.json file.

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const COLLECTIONS = new Set(["movies", "watched", "ratings", "seen"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_POSTER_BYTES = 8 * 1024 * 1024;

/* ---------------- storage ---------------- */
function makeFileStore(file) {
  let data = { docs: {}, posters: {} };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  data.docs = data.docs || {}; data.posters = data.posters || {};
  const save = () => fs.writeFileSync(file, JSON.stringify(data));
  return {
    kind: "file",
    async init() {},
    async count() { return Object.values(data.docs).reduce((n, c) => n + Object.keys(c).length, 0); },
    async all() { return JSON.parse(JSON.stringify(data.docs)); },
    async set(col, id, doc) { (data.docs[col] ||= {})[id] = doc; save(); },
    async merge(col, id, patch) { const cur = (data.docs[col] ||= {})[id] || {}; data.docs[col][id] = { ...cur, ...patch }; save(); return data.docs[col][id]; },
    async del(col, id) { if (data.docs[col]) delete data.docs[col][id]; save(); },
    async putPoster(id, mime, buf) { data.posters[id] = { mime, b64: buf.toString("base64") }; save(); },
    async getPoster(id) { const p = data.posters[id]; return p ? { mime: p.mime, buf: Buffer.from(p.b64, "base64") } : null; },
    async delPoster(id) { delete data.posters[id]; save(); },
  };
}
function makePgStore(url) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|railway\.internal/.test(url) ? false : { rejectUnauthorized: false } });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (collection, id))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS posters (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL)`);
    },
    async count() { const r = await pool.query("SELECT count(*)::int AS n FROM docs"); return r.rows[0].n; },
    async all() {
      const r = await pool.query("SELECT collection, id, data FROM docs");
      const out = {};
      for (const row of r.rows) (out[row.collection] ||= {})[row.id] = row.data;
      return out;
    },
    async set(col, id, doc) { await pool.query(`INSERT INTO docs (collection, id, data) VALUES ($1,$2,$3) ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [col, id, doc]); },
    async merge(col, id, patch) {
      const r = await pool.query(`INSERT INTO docs (collection, id, data) VALUES ($1,$2,$3) ON CONFLICT (collection, id) DO UPDATE SET data = docs.data || EXCLUDED.data, updated_at = now() RETURNING data`, [col, id, patch]);
      return r.rows[0].data;
    },
    async del(col, id) { await pool.query("DELETE FROM docs WHERE collection = $1 AND id = $2", [col, id]); },
    async putPoster(id, mime, buf) { await pool.query("INSERT INTO posters (id, mime, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data", [id, mime, buf]); },
    async getPoster(id) { const r = await pool.query("SELECT mime, data FROM posters WHERE id = $1", [id]); return r.rows[0] ? { mime: r.rows[0].mime, buf: r.rows[0].data } : null; },
    async delPoster(id) { await pool.query("DELETE FROM posters WHERE id = $1", [id]); },
  };
}
const store = process.env.DATABASE_URL ? makePgStore(process.env.DATABASE_URL) : makeFileStore(path.join(__dirname, "data.json"));

async function seedIfEmpty() {
  if ((await store.count()) > 0) return;
  const file = path.join(__dirname, "seed.json");
  if (!fs.existsSync(file)) return;
  const seed = JSON.parse(fs.readFileSync(file, "utf8"));
  let n = 0;
  for (const [col, docs] of Object.entries(seed)) {
    if (!COLLECTIONS.has(col)) continue;
    for (const [id, doc] of Object.entries(docs)) { await store.set(col, id, doc); n++; }
  }
  console.log(`Seeded ${n} records from seed.json`);
}

/* ---------------- auth ---------------- */
function isOwner(req) {
  if (!ADMIN_PASSWORD) return false;
  const given = Buffer.from(String(req.get("x-admin-password") || ""));
  const want = Buffer.from(ADMIN_PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
function requireOwner(req, res, next) {
  if (isOwner(req)) return next();
  res.status(401).json({ error: "Only the list's owner can make changes. Sign in first." });
}
function checkPath(req, res, next) {
  const { collection, id } = req.params;
  if (!COLLECTIONS.has(collection) || !ID_RE.test(id)) return res.status(400).json({ error: "Unknown collection or bad id." });
  next();
}
function cleanDoc(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const s = JSON.stringify(body);
  return s.length > 20000 ? null : body;
}

/* ---------------- app ---------------- */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.get("/api/whoami", (req, res) => res.json({ owner: isOwner(req), canFill: isOwner(req) && !!ANTHROPIC_API_KEY, ownerConfigured: !!ADMIN_PASSWORD }));

app.get("/api/state", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json(await store.all()); } catch (e) { next(e); }
});

app.put("/api/:collection/:id", requireOwner, checkPath, async (req, res, next) => {
  try {
    const doc = cleanDoc(req.body);
    if (!doc) return res.status(400).json({ error: "Bad document." });
    await store.set(req.params.collection, req.params.id, doc);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.patch("/api/:collection/:id", requireOwner, checkPath, async (req, res, next) => {
  try {
    const doc = cleanDoc(req.body);
    if (!doc) return res.status(400).json({ error: "Bad document." });
    res.json({ ok: true, data: await store.merge(req.params.collection, req.params.id, doc) });
  } catch (e) { next(e); }
});
app.delete("/api/:collection/:id", requireOwner, checkPath, async (req, res, next) => {
  try { await store.del(req.params.collection, req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// Posters you upload yourself (owner only). Served at /_blob/<id>.
app.post("/api/posters", requireOwner, express.raw({ type: "image/*", limit: MAX_POSTER_BYTES }), async (req, res, next) => {
  try {
    const mime = String(req.get("content-type") || "").split(";")[0];
    if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(mime) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(415).json({ error: "Upload a PNG, JPEG, WebP, GIF or AVIF image." });
    const id = crypto.randomBytes(16).toString("hex");
    await store.putPoster(id, mime, req.body);
    res.json({ id, url: "/_blob/" + id, sizeBytes: req.body.length, contentType: mime });
  } catch (e) { next(e); }
});
app.delete("/api/posters/:id", requireOwner, async (req, res, next) => {
  try { if (/^[a-f0-9]{32}$/.test(req.params.id)) await store.delPoster(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});
app.get("/_blob/:id", async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.sendStatus(404);
    const p = await store.getPoster(req.params.id);
    if (!p) return res.sendStatus(404);
    res.set({ "Content-Type": p.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.send(p.buf);
  } catch (e) { next(e); }
});

// "Fill in details with Claude" (owner only, needs ANTHROPIC_API_KEY).
app.post("/api/fill", requireOwner, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ code: "sampling_disabled", error: "ANTHROPIC_API_KEY isn't set." });
  const prompt = String((req.body && req.body.prompt) || "").slice(0, 4000);
  if (!prompt) return res.status(400).json({ error: "Missing prompt." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt + "\n\nReply with the JSON object only, no other text." }] }),
    });
    if (r.status === 429) return res.status(429).json({ code: "rate_limited" });
    if (!r.ok) return res.status(502).json({ code: "upstream", error: "Claude request failed (" + r.status + ")." });
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    let value = null;
    try { value = m ? JSON.parse(m[0]) : null; } catch (_) { value = null; }
    res.json({ text, value });
  } catch (e) {
    res.status(502).json({ code: "upstream", error: "Couldn't reach Claude." });
  }
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: "5m" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong on the server." }); });

(async () => {
  await store.init();
  await seedIfEmpty();
  app.listen(PORT, () => console.log(`Christmas Movie Countdown on port ${PORT} (${store.kind} storage${ADMIN_PASSWORD ? "" : ", ADMIN_PASSWORD not set: read-only"})`));
})().catch(e => { console.error(e); process.exit(1); });
