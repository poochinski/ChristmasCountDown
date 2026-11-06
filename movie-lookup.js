// Match the release before importing credits or ratings. Both services return partial records.
const CINEMETA = "https://v3-cinemeta.strem.io";
const normalize = text => String(text || "").normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");
const clean = value => typeof value === "string" && value !== "N/A" ? value.trim() : "";

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error("Movie service unavailable");
  return response.json();
}

function choose(rows, title, year) {
  const key = normalize(title);
  const matches = rows.filter(row => row.titles.some(t => normalize(t) === key) &&
    (!year || Number(row.year) === year));
  if (!matches.length) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous", years: [...new Set(matches.map(r => r.year).filter(Boolean))] };
  return { id: matches[0].id };
}

function runtimeMinutes(value) {
  const text = String(value || "");
  const hours = text.match(/(\d+)\s*h/i);
  const minutes = text.match(/(\d+)\s*m/i);
  if (hours || minutes) return Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0);
  return Number(text);
}

async function cinemeta(title, year) {
  const search = await json(CINEMETA + "/catalog/movie/top/search=" + encodeURIComponent(title) + ".json");
  const rows = (search.metas || []).filter(t => /^tt\d+$/.test(t.id)).map(t => ({
    id: t.id, year: parseInt(t.releaseInfo || t.year || t.released, 10), titles: [t.name],
  }));
  const match = choose(rows, title, year);
  if (!match.id) return match;
  const { meta } = await json(CINEMETA + "/meta/movie/" + match.id + ".json");
  const people = (group, category) => {
    if (Array.isArray(group) && group.length) return group;
    return (meta.links || []).filter(link => link.category === category).map(link => link.name);
  };
  const data = { year: parseInt(meta.releaseInfo || meta.year || meta.released, 10),
    director: people(meta.director, "Directors").join(", "), cast: people(meta.cast, "Cast"),
    mpaa: clean(meta.certification), synopsis: meta.description, runtime: runtimeMinutes(meta.runtime),
    genres: meta.genres, posterUrl: meta.poster };
  return { status: "found", data, id: match.id };
}

async function omdb(params, key) {
  const result = await json("https://www.omdbapi.com/?" + new URLSearchParams({ ...params, apikey: key }));
  if (result.Response === "False" && !/not found/i.test(result.Error || "")) throw new Error("OMDb unavailable");
  return result;
}

async function omdbByTitle(title, year, key) {
  const search = await omdb({ s: title, type: "movie", ...(year ? { y: year } : {}) }, key);
  const rows = (search.Search || []).map(t => ({ titles: [t.Title], year: Number(t.Year), id: t.imdbID }));
  return choose(rows, title, year);
}

function omdbFields(t) {
  const split = value => clean(value).split(",").map(s => s.trim()).filter(Boolean);
  const critics = t.Ratings?.find(r => r.Source === "Rotten Tomatoes");
  const pct = /^(\d{1,3})%$/.exec(critics?.Value || "");
  const fields = { year: Number(t.Year), mpaa: clean(t.Rated), director: clean(t.Director),
    cast: split(t.Actors), genres: split(t.Genre), synopsis: clean(t.Plot),
    runtime: parseInt(t.Runtime, 10), posterUrl: clean(t.Poster) };
  if (pct && Number(pct[1]) <= 100) fields.rt = Number(pct[1]);
  return fields;
}

function available(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([k, v]) => {
    if (k === "posterUrl") return /^https:\/\//i.test(v);
    if (typeof v === "number") return Number.isFinite(v) && (k === "rt" || v > 0);
    return Array.isArray(v) ? v.length > 0 : !!v;
  }));
}

async function lookup(title, year, key) {
  let match;
  try { match = await cinemeta(title, year); }
  catch { match = { status: "unavailable" }; }
  if (!key || match.status === "ambiguous") {
    return match.data ? { ...match, data: available(match.data) } : match;
  }
  try {
    if (!match.id) {
      const fallback = await omdbByTitle(title, year, key);
      if (!fallback.id) return fallback;
      match = { ...fallback, status: "found", data: {} };
    }
    const t = await omdb({ i: match.id, plot: "short" }, key);
    if (t.Response === "True") {
      // Prefer the Cinemeta cast and use only OMDb's explicitly sourced critic percentage.
      const data = { ...available(omdbFields(t)), ...available(match.data) };
      return { status: "found", data };
    }
  } catch { /* Keep the Cinemeta fields if ratings are unavailable. */ }
  if (match.data && Object.keys(available(match.data)).length) return { status: "found", data: available(match.data) };
  return { status: "unavailable" };
}

// Coalesce concurrent requests and avoid repeated provider calls for the same release.
const cache = new Map();
function lookupMovie(title, year, key) {
  const id = JSON.stringify([normalize(title), year, !!key]);
  const hit = cache.get(id);
  if (hit && hit.expires > Date.now()) return hit.result;
  const entry = { expires: Date.now() + 1800000 };
  entry.result = lookup(title, year, key).then(value => {
    if (value.status === "unavailable") entry.expires = Date.now() + 15000;
    return value;
  });
  cache.delete(id);
  if (cache.size >= 512) cache.delete(cache.keys().next().value);
  cache.set(id, entry);
  return entry.result;
}

module.exports = { lookupMovie };
