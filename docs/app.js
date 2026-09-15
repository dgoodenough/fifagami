"use strict";

/* FIFAGami — Scorigami-style heatmap of international football fixtures.
   Vanilla JS + Canvas. Loads pre-built JSON from data/ and renders an N×N grid where each
   cell is a pair of national teams, coloured by how many times they have met.

   Five views share one state object: the grid itself, plus four list views that answer the
   questions the grid can only hint at (what's scheduled, what happened exactly once, who is
   closest to meeting, and how any two teams connect). Everything the user picks lives in the
   URL, so any view can be linked to. */

const YEAR_MIN = 1872;               // Scotland v England, the first international
const BAND = 13;                     // px confederation colour strip at outer edge
const MIN_CELL = 1;                  // px: small enough that 211 columns fit a phone
const CONFEDS = ["AFC", "CAF", "CONCACAF", "CONMEBOL", "OFC", "UEFA"];
const VIEWS = ["grid", "fixtures", "oneoffs", "misses", "path"];
const TAP_LEGIBLE = 18;              // px cell size a tap zooms to when cells are too small
const MOBILE_Q = "(max-width: 720px)";

let MARGIN = 116;                    // px reserved for labels + confederation band

const S = {
  members: [],                       // current FIFA members
  defunct: { members: [], pairs_men: [], pairs_women: [] },
  byId: new Map(),
  confedOrder: [],
  pairs: { men: new Map(), women: new Map() },
  maxCount: { men: 1, women: 1 },
  matches: { men: null, women: null },   // per-meeting detail, lazy-loaded on first click
  upcoming: { men: new Map(), women: new Map() }, // scheduled first meetings (key -> [date, tourn])
  yearsByPair: { men: null, women: null }, // key -> sorted meeting years (slim years_*.json)
  undated: { men: {}, women: {} },   // key -> meetings whose source row has no usable date
  debut: { men: new Map(), women: new Map() },  // team id -> year of its first ever match
  everPlayed: { men: new Set(), women: new Set() },
  meta: {},
  // view options
  view: "grid",
  gender: "men",
  sort: "confed",                    // "confed" | "rank" | "matches" | "alpha"
  showConfeds: new Set(),
  manual: new Set(),
  includeDefunct: false,
  highlightNever: true,              // the empties are the subject; the ramp is the follow-up
  showUpcoming: false,               // highlight upcoming first meetings in yellow
  today: "",                         // client's current date (YYYY-MM-DD), set on load
  year: null,                        // scrubber: show grid as of this year (null = present)
  maxYear: 2026,
  playing: false,                    // timeline autoplay
  path: { a: null, b: null },        // degrees-of-separation endpoints
  // ordered ids currently displayed
  order: [],
  metByYear: null,                   // prefix sums: how many pairs had met by each year
  // viewport: on-screen cell size (px) + pan offset
  cell: 20, tx: 0, ty: 0,
  hover: null,                       // {r, c} under the mouse
  focus: null,                       // {r, c} under keyboard focus
  // Mid-fold the page has already moved to the new dataset, but the frames still in flight
  // are painted as the split square. These are that override, and nothing else reads them.
  paintMode: null,                   // which archive(s) colour the cells
  paintScale: null,                  // which mode's ramp scale the colours are read against
  folding: false,
};

const canvas = document.getElementById("grid");
const mainCtx = canvas.getContext("2d");
/* Every paint goes through this one binding. The fold has to draw the same grid in three
   datasets at once, so paintTo() aims it at an offscreen canvas for the length of one
   synchronous draw and then puts it back. */
let ctx = mainCtx;
const tooltip = document.getElementById("tooltip");
const canvasWrap = document.getElementById("canvas-wrap");
const live = document.getElementById("live");
let DPR = window.devicePixelRatio || 1;
// Per-day cache-buster: data refreshes daily, so re-fetch fresh once a day (cached within the day).
const VBUST = "?d=" + new Date().toISOString().slice(0, 10);
const mqMobile = window.matchMedia(MOBILE_Q);
// Must stay in step with the rail media query in style.css.
const RAIL_Q = "(min-width: 1000px) and (min-aspect-ratio: 7/5)";
const mqRail = window.matchMedia(RAIL_Q);
const mqReduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------- small helpers ---------- */

// Every innerHTML in this file interpolates names that came from third-party feeds
// (martj42, FotMob, ESPN). None of it is attacker-controlled today, but it is not ours
// either, and it lands in the DOM daily without a human reading the diff.
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const $ = id => document.getElementById(id);
const pl = (k, word) => (k === 1 ? word : word + "s");
const num = n => n.toLocaleString();

function announce(msg) { if (live) live.textContent = msg; }

/* ---------- theme ---------- */
// getCss memoises, so every theme change has to clear it or the canvas keeps painting
// yesterday's palette.
let _css = {};
function getCss(v) {
  return _css[v] || (_css[v] = getComputedStyle(document.documentElement)
    .getPropertyValue(v).trim());
}
function clearCssCache() { _css = {}; RAMP = null; }

function preferredTheme() {
  try {
    const saved = localStorage.getItem("ntg-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* private mode / storage blocked */ }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(theme, persist = true) {
  // The class goes on <html> as well as <body>: the canvas reads its palette with
  // getComputedStyle(document.documentElement), and custom properties set on <body> do not
  // cascade upwards to it. On <body> alone the page would turn light and the grid would
  // keep painting itself in the dark palette.
  const light = theme === "light";
  document.documentElement.classList.toggle("ledger-light", light);
  document.body.classList.toggle("ledger-light", light);
  clearCssCache();
  const btn = $("theme");
  if (btn) {
    btn.innerHTML = theme === "light" ? "&#9790;" : "&#9788;";
    btn.setAttribute("aria-label",
      theme === "light" ? "Switch to the dark theme" : "Switch to the light theme");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getCss("--chrome"));
  if (persist) { try { localStorage.setItem("ntg-theme", theme); } catch { /* ignore */ } }
}
const currentTheme = () =>
  document.documentElement.classList.contains("ledger-light") ? "light" : "dark";

/* ---------- colour ---------- */
// The ramp and the confederation palette live in style.css so the stylesheet, the canvas
// and render_hero.py all read the same numbers. Parsed once per theme.
let RAMP = null;
function ramp() {
  if (!RAMP) {
    RAMP = [0, 30, 55, 80, 100].map(stop => [stop / 100, hexToRgb(getCss(`--ramp-${stop}`))]);
  }
  return RAMP;
}
function hexToRgb(hex) {
  const h = (hex || "#000").trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16) || 0,
          parseInt(full.slice(2, 4), 16) || 0,
          parseInt(full.slice(4, 6), 16) || 0];
}
const confedColor = cf => getCss(`--confed-${String(cf).toLowerCase()}`) || "#888";

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function rampColor(t) {
  const R = ramp();
  for (let i = 1; i < R.length; i++) {
    if (t <= R[i][0]) {
      const [t0, c0] = R[i - 1], [t1, c1] = R[i];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${lerp(c0[0], c1[0], f)},${lerp(c0[1], c1[1], f)},${lerp(c0[2], c1[2], f)})`;
    }
  }
  const last = R[R.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}
/* The top of the meetings ramp.

   On its own, each archive is normalised to its own busiest fixture, so the women's grid
   uses the full range. In the split square the two halves are read against each other, so
   they share one scale: the women's half comes out genuinely paler, which is the point. */
function rampMax(gender = S.gender) {
  const mode = S.paintScale || S.gender;
  return mode === "both" ? Math.max(S.maxCount.men, S.maxCount.women)
                         : S.maxCount[dataGender(gender)];
}
function cellColor(count, gender = S.gender) {
  const never = S.highlightNever ? getCss("--never-hi") : getCss("--never");
  if (!count) return never;
  const t = Math.log1p(count) / Math.log1p(rampMax(gender));
  if (S.highlightNever) {            // de-emphasise played cells to spotlight the empties
    const [r0, g0, b0] = hexToRgb(getCss("--paper-2"));
    const [r1, g1, b1] = hexToRgb(getCss("--ink-3"));
    return `rgb(${lerp(r0, r1, t)},${lerp(g0, g1, t)},${lerp(b0, b1, t)})`;
  }
  return rampColor(t);
}

/* Does this platform actually draw country flags?

   Segoe UI Emoji has never contained regional-indicator pair glyphs, so on Windows every
   flag in the app renders as the two letters of the country's ISO code in boxes. The test
   is colour: a drawn flag is hundreds of coloured pixels, while boxed letters, a lone
   regional indicator and a tofu box all measure exactly zero. Width heuristics are
   flakier, since they depend on the fallback font's advance widths. */
let _flagsOk = null;
function flagsRender() {
  if (_flagsOk !== null) return _flagsOk;
  _flagsOk = true;                       // a probe that cannot run must not strip good flags
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return _flagsOk;
    g.fillStyle = "#fff"; g.fillRect(0, 0, 24, 24);
    g.fillStyle = "#000"; g.font = "20px sans-serif"; g.textBaseline = "top";
    g.fillText("\u{1F1E7}\u{1F1F7}", 0, 0);            // Brazil, green/yellow/blue
    const d = g.getImageData(0, 0, 24, 24).data;
    let coloured = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gr = d[i + 1], b = d[i + 2];
      if (Math.max(r, gr, b) - Math.min(r, gr, b) > 40) coloured++;
    }
    _flagsOk = coloured > 20;
  } catch {
    /* a tainted or unavailable canvas leaves the optimistic default in place */
  }
  return _flagsOk;
}

/* ---------- data loading ---------- */
async function load() {
  const [members, mMen, mWomen, defunct, upcoming] = await Promise.all([
    fetch("data/members.json" + VBUST).then(r => r.json()),
    fetch("data/matrix_men.json" + VBUST).then(r => r.json()),
    fetch("data/matrix_women.json" + VBUST).then(r => r.json()),
    fetch("data/defunct.json" + VBUST).then(r => r.json()),
    fetch("data/upcoming.json" + VBUST).then(r => r.json()).catch(() => ({ men: [], women: [] })),
  ]);

  S.members = members.members;
  S.confedOrder = members.confederation_order;
  S.meta = {
    generated: members.generated,
    dataThrough: members.data_through || {},
    rankingMen: members.ranking_men,
    rankingWomen: members.ranking_women,
  };
  S.defunct = defunct;
  for (const m of S.members) S.byId.set(m.id, m);
  for (const m of defunct.members) S.byId.set(m.id, m);

  // Windows ships no country flag emoji, so a flag there is two boxed letters. Drop them
  // rather than print the boxes; every label already has a no-flag path, because Kosovo
  // and Northern Ireland have no flag emoji on any platform.
  if (!flagsRender()) for (const m of S.byId.values()) m.flag = "";

  S.pairs.men = buildPairMap(mMen.pairs, defunct.pairs_men);
  S.pairs.women = buildPairMap(mWomen.pairs, defunct.pairs_women);
  S.maxCount.men = mMen.max_count;
  S.maxCount.women = mWomen.max_count;
  S.showConfeds = new Set(S.confedOrder);

  // Per-team debut year and "has this team ever played anyone", so the grid can tell the
  // three kinds of empty apart: never met, hadn't debuted yet, and never played at all.
  for (const [g, mx] of [["men", mMen], ["women", mWomen]]) {
    for (const src of [mx.pairs, defunct[`pairs_${g}`] || []]) {
      for (const [i, j, , fy] of src) {
        S.everPlayed[g].add(i);
        S.everPlayed[g].add(j);
        const y = fy == null ? YEAR_MIN : fy;
        for (const id of [i, j]) {
          const prev = S.debut[g].get(id);
          if (prev == null || y < prev) S.debut[g].set(id, y);
        }
      }
    }
  }

  for (const g of ["men", "women"]) {
    for (const [i, j, date, tourn] of (upcoming[g] || [])) {
      S.upcoming[g].set(`${i},${j}`, [date, tourn]);
    }
  }
  const d = new Date();   // the machine's current date drives which fixtures are still upcoming
  S.today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // latest played year across both archives drives the scrubber's right end.
  let maxY = 1900;
  for (const mx of [mMen, mWomen]) for (const p of mx.pairs) if (p[4] > maxY) maxY = p[4];
  S.maxYear = maxY;
  S.year = maxY;

  $("loading").remove();
  readUrl();                          // a shared link wins over every default
  buildControls();
  drawLegend();
  applyView(S.view, { focus: false, push: false });
  recompute(true);
}

function buildPairMap(pairs, defunctPairs) {
  // Keyed by "lo,hi" strings (matching matches_*.json). A numeric i*K+j key would collide
  // because defunct ids start at 100000 (e.g. member 1 × defunct 100007 == member 2 × 7).
  const map = new Map();
  for (const [i, j, c, fy, ly] of pairs) map.set(`${i},${j}`, [c, fy, ly]);
  for (const [i, j, c, fy, ly] of defunctPairs) map.set(`${i},${j}`, [c, fy, ly]);
  return map;
}

const isCombined = () => S.gender === "both";
const dataGender = g => (g === "both" ? "men" : g);
// What the canvas is painting. Normally the chosen dataset; mid-fold, the split square.
const gridMode = () => S.paintMode || S.gender;
/* The split square. Every pairing appeared twice in a symmetric matrix, so half of the
   grid was only ever a mirror of the other half. Above the diagonal is now the men's
   record and below it the women's, and the mirror is spent on the second game instead. */
const halfGender = (r, c) => (c > r ? "men" : c < r ? "women" : null);
function pairKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }
function present() { return S.year == null || S.year >= S.maxYear; }

function lookup(a, b, gender = S.gender) {
  if (a === b) return null;
  return S.pairs[dataGender(gender)].get(pairKey(a, b)) || null;
}

/* Has this pair met, as of the scrubber year?

   This reads only the first-meeting year already in matrix_*.json, so the grid, the
   headline and the combined-view categories never wait on a download. Only the exact
   "N meetings by year Y" in a tooltip needs the per-pair year list. */
function metAsOf(a, b, gender = S.gender) {
  if (a === b) return false;
  const p = S.pairs[dataGender(gender)].get(pairKey(a, b));
  if (!p) return false;
  if (present() || p[1] == null) return true;   // undatable meetings count as always-met
  return p[1] <= S.year;
}

// Exact number of meetings as of the scrubber year. Falls back to the all-time total
// until years_*.json has arrived (the grid is already correct either way).
function countAsOf(a, b, gender = S.gender) {
  if (a === b) return 0;
  const g = dataGender(gender);
  const k = pairKey(a, b);
  const p = S.pairs[g].get(k);
  if (!p) return 0;
  if (present()) return p[0];
  const ys = S.yearsByPair[g];
  if (!ys) return metAsOf(a, b, gender) ? p[0] : 0;
  const arr = ys.get(k);
  if (!arr) return 0;
  let lo = 0, hi = arr.length;                          // count years <= S.year (arr sorted asc)
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= S.year) lo = m + 1; else hi = m; }
  return lo;
}
// True once the exact per-year counts are available for the active dataset.
function countsExact() {
  return present() || (isCombined()
    ? !!(S.yearsByPair.men && S.yearsByPair.women)
    : !!S.yearsByPair[dataGender(S.gender)]);
}

/* A scheduled first meeting belongs to one archive, which is why combined mode used to
   have none to show. In the split square every cell is single-archive again, so the caller
   says which one it is asking about. */
function upcomingInfo(a, b, gender = S.gender) {
  return gender === "both" ? null : S.upcoming[gender].get(pairKey(a, b)) || null;
}
// A scheduled first meeting still in the future (or today) per the client's clock.
function isUpcoming(a, b, gender = S.gender) {
  const u = upcomingInfo(a, b, gender);
  return !!u && u[0] >= S.today;
}

// Has this team played anyone at all in the active archive? An entire empty row is a
// different fact from "these two have never met", and the site says so.
function hasAnyMatches(id, gender = S.gender) {
  return gender === "both"
    ? (S.everPlayed.men.has(id) || S.everPlayed.women.has(id))
    : S.everPlayed[gender].has(id);
}
// Year of a team's first ever match, or null if it has never played.
function debutYear(id, gender = S.gender) {
  if (gender !== "both") return S.debut[gender].get(id) ?? null;
  const a = S.debut.men.get(id), b = S.debut.women.get(id);
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}
function notYetDebuted(id, gender = S.gender) {
  if (present()) return false;
  const y = debutYear(id, gender);
  return y == null ? false : y > S.year;
}

/* The slim per-pair meeting years. Only tooltips and the detail card need this, so it is
   fetched in the background on the first scrub and the grid never blocks on it. */
async function ensureYears(gender) {
  const g = dataGender(gender);
  if (S.yearsByPair[g]) return;
  const data = await fetch(`data/years_${g}.json` + VBUST).then(r => r.json());
  const map = new Map();
  for (const k in data.pairs) {                 // stored delta-encoded; expand to absolute
    const enc = data.pairs[k];
    const years = new Array(enc.length);
    let run = enc[0];
    years[0] = run;
    for (let i = 1; i < enc.length; i++) { run += enc[i]; years[i] = run; }
    map.set(k, years);
  }
  S.yearsByPair[g] = map;
  S.undated[g] = data.undated || {};
}
function ensureYearsForView() {
  return isCombined()
    ? Promise.all([ensureYears("men"), ensureYears("women")])
    : ensureYears(S.gender);
}

/* ---------- ordering ---------- */
function rankOf(m) {
  if (isCombined()) {                            // best (lowest) of the two ranks
    return Math.min(m.mens_rank == null ? Infinity : m.mens_rank,
                    m.womens_rank == null ? Infinity : m.womens_rank);
  }
  const r = S.gender === "men" ? m.mens_rank : m.womens_rank;
  return r == null ? Infinity : r;
}

// Which datasets a pair has met in, as of the scrubber year. Bitmask 1 = men, 2 = women,
// so 3 = both, 0 = neither. The split square says this with geometry; the single-team card,
// which is a list and has no diagonal to work with, still says it with colour.
function metCategory(a, b) {
  return (metAsOf(a, b, "men") ? 1 : 0) | (metAsOf(a, b, "women") ? 2 : 0);
}

/* ---------- what's on screen ---------- */
function activePool() {
  let base = S.members.slice();
  if (S.includeDefunct) base = base.concat(S.defunct.members);
  return base;
}

/* The teams the panel's filters currently admit.

   This is the rule the grid has always used to build S.order. The list views were reading
   activePool() directly, so a confederation filter that was plainly ticked in the panel
   reached exactly one of the five views — filter to OFC and "Near misses" still opened on
   Russia v Bosnia. One definition, consulted by everything. */
function scopeMembers() {
  const base = activePool();
  return S.manual.size
    ? base.filter(m => S.manual.has(m.id))
    : base.filter(m => S.showConfeds.has(m.confed));
}
// True when the panel is narrowing what a view may show (drives the "filtered" notes).
const isFiltered = () =>
  S.manual.size > 0 || S.showConfeds.size < S.confedOrder.length;
// Everything a derived view depends on. Cache keys and re-render triggers hang off this.
function scopeKey() {
  return [S.gender, S.includeDefunct ? "d" : "", present() ? "now" : S.year,
          [...S.showConfeds].sort().join("|"), [...S.manual].sort().join("|")].join("~");
}
// Two separate clauses, because some sentences already name the year and doubling up reads
// as a bug ("had played exactly once by 1950 (as of 1950)"). Callers compose what they need.
const scopeNote = () => (isFiltered() ? " (in the current filter)" : "");
const asOfNote = () => (present() ? "" : ` as of ${S.year}`);

function recompute(fit) {
  if (S.folding) endFold();
  closeDetail();
  closePeek();

  // One team manually selected -> show that team's fixtures ranked most-to-least played,
  // instead of a useless 1x1 grid. Two or more -> fall back to a normal sub-grid.
  if (S.manual.size === 1 && S.view === "grid") {
    renderTeamFocus([...S.manual][0]);
    canvasWrap.classList.add("focus");
    writeUrl();
    return;
  }
  $("teamfocus").hidden = true;
  canvasWrap.classList.remove("focus");

  const base = activePool();
  const active = scopeMembers();

  // For the "total matches" sort, tally each active team's meetings against the whole pool
  // (everyone, not just the visible subset), honouring the time scrubber.
  let totals = null;
  if (S.sort === "matches") {
    totals = new Map();
    const genders = isCombined() ? ["men", "women"] : [S.gender];
    for (const m of active) {
      let t = 0;
      for (const o of base) if (o.id !== m.id) for (const g of genders) t += countAsOf(m.id, o.id, g);
      totals.set(m.id, t);
    }
  }

  active.sort((a, b) => {
    if (S.sort === "alpha") return a.name.localeCompare(b.name);
    if (S.sort === "matches") {
      const ta = totals.get(a.id), tb = totals.get(b.id);
      if (ta !== tb) return tb - ta;                 // most matches first
      return a.name.localeCompare(b.name);
    }
    if (S.sort === "rank") {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    }
    // confederation, then FIFA rank, then name
    const ca = S.confedOrder.indexOf(a.confed), cb = S.confedOrder.indexOf(b.confed);
    if (ca !== cb) return ca - cb;
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  S.order = active.map(m => m.id);
  if (S.focus && S.focus.r >= S.order.length) S.focus = null;
  buildYearIndex();
  if (fit) fitView(); else clampPan();
  updateStats();
  updateLegend();
  draw();
  refreshListView();
  writeUrl();
}

/* Re-render whichever list view is open.

   The panel's filters used to reach only the grid, because recompute() ended at draw().
   Anything that changes what a view may show — a confederation ticked, a team picked, the
   defunct layer, the dataset, the scrubbed year — has to land here too. */
function refreshListView() {
  switch (S.view) {
    case "fixtures": renderFixtures(); break;
    case "oneoffs": renderOneOffs(); break;
    case "misses": renderMisses(); break;
    case "path": renderPath(); break;
    default: return;
  }
  updateHeadline();
}

/* Prefix sums of "how many of the on-screen pairs had met by year Y".

   The headline used to walk all 22,155 pairs on every frame of a timeline drag. The first
   meeting year of every pair is already in matrix_*.json, so one O(n²) pass per view change
   buys an O(1) lookup per scrub frame — and the whole scrubber stops being the expensive
   thing on the page. */
function buildYearIndex() {
  const n = S.order.length;
  const span = S.maxYear - YEAR_MIN + 2;
  const men = new Int32Array(span), women = new Int32Array(span), both = new Int32Array(span);
  const slot = y => Math.max(0, Math.min(span - 1, (y == null ? YEAR_MIN : y) - YEAR_MIN));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = S.order[i], b = S.order[j], k = pairKey(a, b);
      const pm = S.pairs.men.get(k), pw = S.pairs.women.get(k);
      if (pm) men[slot(pm[1])]++;
      if (pw) women[slot(pw[1])]++;
      if (pm && pw) both[slot(Math.max(pm[1] ?? YEAR_MIN, pw[1] ?? YEAR_MIN))]++;
    }
  }
  for (let i = 1; i < span; i++) { men[i] += men[i - 1]; women[i] += women[i - 1]; both[i] += both[i - 1]; }
  S.metByYear = { men, women, both, span, total: n * (n - 1) / 2 };
}
// How many on-screen pairs had met by the scrubber year, per dataset.
function metCounts() {
  const idx = S.metByYear;
  if (!idx) return { men: 0, women: 0, both: 0, total: 0 };
  const at = present() ? idx.span - 1
    : Math.max(0, Math.min(idx.span - 1, S.year - YEAR_MIN));
  return { men: idx.men[at], women: idx.women[at], both: idx.both[at], total: idx.total };
}

/* ---------- viewport ---------- */
function gridArea() { return { w: canvas.clientWidth - MARGIN, h: canvas.clientHeight - MARGIN }; }

/* How much gutter the labels need at this cell size.

   Below 5px no label is drawn at all, so reserving 116px of margin there was pure waste —
   and on a phone it was the reason "Fit" produced a grid wider than the screen it was
   fitting into. The gutter now grows with the cells it has to caption. */
function marginFor(cell) {
  const cap = Math.max(44, Math.min(116, canvas.clientWidth * 0.2));
  if (cell < 5) return BAND + 6;
  return Math.round(Math.min(cap, BAND + 6 + (cell - 5) * 9));
}

function fitView() {
  const n = S.order.length || 1;
  // The margin depends on the cell size and the cell size depends on the margin, so
  // iterate to a fixed point (converges in two or three passes).
  let cell = S.cell;
  for (let i = 0; i < 5; i++) {
    MARGIN = marginFor(cell);
    const { w, h } = gridArea();
    const next = Math.max(MIN_CELL, Math.min(w / n, h / n));
    if (Math.abs(next - cell) < 0.02) { cell = next; break; }
    cell = next;
  }
  S.cell = cell;
  MARGIN = marginFor(cell);
  const { w, h } = gridArea();
  S.tx = Math.max(0, (w - S.cell * n) / 2);
  S.ty = Math.max(0, (h - S.cell * n) / 2);
}

function clampPan() {
  MARGIN = marginFor(S.cell);
  const n = S.order.length;
  const { w, h } = gridArea();
  const gw = S.cell * n, gh = S.cell * n;
  if (gw <= w) S.tx = (w - gw) / 2; else S.tx = Math.min(0, Math.max(w - gw, S.tx));
  if (gh <= h) S.ty = (h - gh) / 2; else S.ty = Math.min(0, Math.max(h - gh, S.ty));
}

/* ---------- rendering ---------- */
function resize() {
  if (S.folding) endFold();
  DPR = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * DPR);
  canvas.height = Math.floor(canvas.clientHeight * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  MARGIN = marginFor(S.cell);
}

function draw() {
  if (S.view !== "grid") return;
  // Keep the backing store matched to the element's CSS size. If the layout shifts after the
  // last resize() — e.g. the headline grows when data loads, or a scrollbar appears — the
  // canvas ends up shorter than its backing store and the uncleared strip shows stale pixels
  // ("artifacts at the bottom") that persist across redraws/zooms. Re-sync if mismatched.
  const dpr = window.devicePixelRatio || 1;
  if (ctx === mainCtx &&
      (canvas.width !== Math.floor(canvas.clientWidth * dpr) ||
       canvas.height !== Math.floor(canvas.clientHeight * dpr))) {
    resize();
  }
  const n = S.order.length;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getCss("--bg");
  ctx.fillRect(0, 0, W, H);
  if (!n) return;

  const cell = S.cell;
  const ox = MARGIN + S.tx, oy = MARGIN + S.ty;     // grid origin on screen
  const { w: gw, h: gh } = gridArea();

  const c0 = Math.max(0, Math.floor((MARGIN - ox) / cell));
  const c1 = Math.min(n, Math.ceil((W - ox) / cell));
  const r0 = Math.max(0, Math.floor((MARGIN - oy) / cell));
  const r1 = Math.min(n, Math.ceil((H - oy) / cell));

  // cells
  ctx.save();
  ctx.beginPath();
  ctx.rect(MARGIN, MARGIN, gw, gh);
  ctx.clip();
  const diag = getCss("--diag");
  const upcomingCol = getCss("--upcoming");
  const nodataCol = getCss("--nodata");
  const predebutCol = getCss("--predebut");
  const atPresent = present();
  const mode = gridMode();
  const split = mode === "both";
  const span = Math.ceil(cell) + (cell > 7 ? 0 : 1);
  /* Precompute the per-team facts so the inner loop stays a lookup, not a function call.
     The split square asks them of two archives, not one: a team that has never played a
     women's international is silent in the lower half and perfectly ordinary in the
     upper. One array per archive, covering every row and column on screen. */
  const archives = split ? ["men", "women"] : [dataGender(mode)];
  const silent = {}, predebut = {};
  const lo = Math.min(r0, c0), hi = Math.max(r1, c1);
  for (const g of archives) {
    const sil = silent[g] = [], pre = predebut[g] = [];
    for (let i = lo; i < hi; i++) {
      sil[i] = !hasAnyMatches(S.order[i], g);
      pre[i] = notYetDebuted(S.order[i], g);
    }
  }
  for (let r = r0; r < r1; r++) {
    const a = S.order[r];
    const y = oy + r * cell;
    for (let c = c0; c < c1; c++) {
      const b = S.order[c];
      let col;
      if (a === b) {
        col = diag;
      } else {
        const g = split ? halfGender(r, c) : mode;
        const sil = silent[g], pre = predebut[g];
        if (metAsOf(a, b, g)) {
          col = cellColor(countAsOf(a, b, g), g);
        } else if (S.showUpcoming && atPresent && isUpcoming(a, b, g)) {
          col = upcomingCol;
        } else if (sil[r] || sil[c]) {
          // Not "these two have never met" — one of them has never played anyone at all.
          col = nodataCol;
        } else if (pre[r] || pre[c]) {
          col = predebutCol;                  // hadn't debuted yet at the scrubbed year
        } else {
          col = cellColor(0, g);
        }
      }
      ctx.fillStyle = col;
      ctx.fillRect(Math.floor(ox + c * cell), Math.floor(y), span, span);
    }
  }
  /* The marks belong to the split square as a destination, not to the frames a fold
     passes through. Drawing them only when Both is the chosen dataset means a fold lands
     on exactly what the canvas settles to, with no label left over to pop; on the way in
     they appear under the frame the switch is still holding over the first moments. */
  if (split && isCombined()) drawFoldLine(n, ox, oy, cell);
  // outline the grid extent so paper-white "never" cells read as part of the grid
  ctx.strokeStyle = getCss("--grid-strong");
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + .5, oy + .5, n * cell - 1, n * cell - 1);
  // hover crosshair — the live canvas only; a flap should not fold a crosshair with it
  const cross = ctx === mainCtx ? (S.hover || S.focus) : null;
  if (cross) {
    ctx.fillStyle = getCss("--crosshair");
    ctx.fillRect(MARGIN, oy + cross.r * cell, gw, cell);
    ctx.fillRect(ox + cross.c * cell, MARGIN, cell, gh);
  }
  // keyboard focus gets a hard outline as well — a wash is not a focus indicator
  if (S.focus && ctx === mainCtx) {
    ctx.strokeStyle = getCss("--pos");
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + S.focus.c * cell - 1, oy + S.focus.r * cell - 1,
                   Math.max(4, cell + 2), Math.max(4, cell + 2));
  }
  ctx.restore();

  /* Where the labels and confederation strips live.

     They belong in the margin when the grid is bigger than the viewport and being panned,
     but glued to the grid's own edge when a fitted grid is centred with space around it —
     otherwise the strips float off on their own at the far left of the canvas. Taking the
     max of the two gives the pinned behaviour while panning and the glued behaviour while
     fitted, with no special case. */
  const gutterX = Math.max(MARGIN, Math.min(ox, MARGIN + gw));
  const gutterY = Math.max(MARGIN, Math.min(oy, MARGIN + gh));

  if (S.sort === "confed") drawSeparators(n, ox, oy, cell, gw, gh);
  drawLabels(n, ox, oy, cell, r0, r1, c0, c1, gutterX, gutterY);
  drawBands(ox, oy, cell, gutterX, gutterY);

  // mask the margin corners cleanly
  ctx.fillStyle = getCss("--bg");
  ctx.fillRect(0, 0, gutterX, gutterY);
}

function confedRuns() {
  // contiguous [start, end, confed] runs over S.order
  const runs = [];
  for (let i = 0; i < S.order.length; i++) {
    const cf = S.byId.get(S.order[i]).confed;
    const last = runs[runs.length - 1];
    if (last && last.confed === cf) last.end = i;
    else runs.push({ start: i, end: i, confed: cf });
  }
  return runs;
}

function drawSeparators(n, ox, oy, cell, gw, gh) {
  ctx.strokeStyle = getCss("--line");
  ctx.lineWidth = 1;
  // Clamped to the grid's own extent so the rules never run on past its edges.
  const x0 = Math.max(MARGIN, ox), x1 = Math.min(MARGIN + gw, ox + n * cell);
  const y0 = Math.max(MARGIN, oy), y1 = Math.min(MARGIN + gh, oy + n * cell);
  for (const run of confedRuns()) {
    if (run.start === 0) continue;
    const x = ox + run.start * cell, y = oy + run.start * cell;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + .5, y0); ctx.lineTo(Math.round(x) + .5, y1);
    ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5);
    ctx.stroke();
  }
}

/* The fold line, and which game lies on which side of it.

   Once the two halves carry different archives the square stops being self-explanatory:
   the same pairing is above the diagonal in the men's record and below it in the women's,
   and nothing on the canvas says so. The diagonal gets a hard rule and each half gets its
   name — sized to the grid, haloed so it survives both a red field and a pale one, and
   faint enough to read as a watermark rather than a label. */
function drawFoldLine(n, ox, oy, cell) {
  const L = n * cell;
  ctx.save();
  ctx.strokeStyle = getCss("--grid-strong");
  ctx.lineWidth = Math.max(1, Math.min(3, cell * .3));
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox + L, oy + L);
  ctx.stroke();

  if (L >= 190) {
    const size = Math.max(12, Math.min(58, L / 15));
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, size / 4);
    ctx.strokeStyle = getCss("--bg");
    ctx.fillStyle = getCss("--ink");
    ctx.globalAlpha = .62;
    for (const [text, fx, fy] of [["MEN'S", .7, .28], ["WOMEN'S", .3, .72]]) {
      const x = ox + L * fx, y = oy + L * fy;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
}

// Flags are drawn only when the cells are big enough to have earned the space. Canvas
// emoji rendering is solid on macOS/iOS/Android/Linux; Windows falls back to the letter
// pair, which is why the three-letter FIFA code stays the primary label everywhere.
function shortLabel(m, cell) {
  const flag = cell >= 20 && m.flag ? m.flag + " " : "";
  if (cell >= 46) return flag + m.name;
  if (m.code) return flag + m.code;
  return flag + (m.name.length > 6 ? m.name.slice(0, 6) : m.name);
}

function drawLabels(n, ox, oy, cell, r0, r1, c0, c1, gutterX, gutterY) {
  if (cell < 5) return;
  // Thin the labels so their on-screen spacing stays legible (>= ~14px) at any zoom —
  // otherwise codes pile on top of each other into gibberish at low zoom.
  const step = Math.max(1, Math.round(14 / cell));
  const fs = Math.min(13, Math.max(8, cell - 3));
  ctx.font = `${fs}px -apple-system, "Segoe UI", sans-serif`;

  // Keep labels clear of the confederation colour band (the outer BAND-px strip).
  const edge = gutterX - BAND - 4;         // inner edge of the row band
  const edgeTop = gutterY - BAND - 4;      // inner edge of the column band
  const maxLen = Math.max(12, MARGIN - BAND - 8);
  const ink = getCss("--ink"), dim = getCss("--ink-dim"), silent = getCss("--nodata-line");
  const labelColor = m => m.defunct ? dim : (hasAnyMatches(m.id) ? ink : silent);

  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let r = r0; r < r1; r++) {
    if (r % step) continue;
    const m = S.byId.get(S.order[r]);
    ctx.fillStyle = labelColor(m);
    ctx.fillText(shortLabel(m, cell), edge, oy + r * cell + cell / 2, maxLen);
  }
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let c = c0; c < c1; c++) {
    if (c % step) continue;
    const m = S.byId.get(S.order[c]);
    const x = ox + c * cell + cell / 2;
    ctx.save();
    ctx.translate(x, edgeTop); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = labelColor(m);
    ctx.fillText(shortLabel(m, cell), 0, 0, maxLen);
    ctx.restore();
  }
}

function drawBands(ox, oy, cell, gutterX, gutterY) {
  const { w: gw, h: gh } = gridArea();
  const right = MARGIN + gw, bottom = MARGIN + gh;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "700 10px -apple-system, sans-serif";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const bandInk = getCss("--band-strip-ink");
  for (const run of confedRuns()) {
    const col = confedColor(run.confed);
    const a = run.start * cell, len = (run.end - run.start + 1) * cell;
    ctx.fillStyle = col;
    ctx.fillRect(ox + a, gutterY - BAND, len, BAND);          // top strip
    ctx.fillRect(gutterX - BAND, oy + a, BAND, len);          // left strip
    // Label, stuck to the visible portion of the run (only when there's room).
    const visW = Math.min(ox + a + len, right) - Math.max(ox + a, MARGIN);
    const visH = Math.min(oy + a + len, bottom) - Math.max(oy + a, MARGIN);
    ctx.fillStyle = bandInk;
    if (visW > 26) {
      const cx = clamp(ox + a + len / 2, MARGIN + 12, right - 12);
      ctx.fillText(run.confed, cx, gutterY - BAND / 2 - .5);
    }
    if (visH > 26) {
      const cy = clamp(oy + a + len / 2, MARGIN + 12, bottom - 12);
      ctx.save();
      ctx.translate(gutterX - BAND / 2, cy); ctx.rotate(-Math.PI / 2);
      ctx.fillText(run.confed, 0, .5);
      ctx.restore();
    }
  }
}

function drawLegend() {
  const lc = $("legend-canvas");
  const g = lc.getContext("2d");
  const w = lc.width, h = lc.height;
  for (let x = 0; x < w; x++) {
    g.fillStyle = rampColor(x / (w - 1));
    g.fillRect(x, 0, 1, h);
  }
}

// Tick marks under the ramp. It is log-scaled from 1 to ~183, so without gradations there
// is no way to tell a five-meeting green from a fifty-meeting one.
function drawLegendTicks() {
  const host = $("legend-ticks");
  if (!host) return;
  const max = rampMax(S.gender);
  const stops = [1, 3, 10, 30, 100, 300, 1000].filter(v => v < max).concat([max]);
  const denom = Math.log1p(max);
  host.innerHTML = stops.map(v => {
    const pct = 100 * Math.log1p(v) / denom;
    const nudge = pct < 6 ? "left:0;transform:none" : pct > 94 ? "right:0;left:auto;transform:none"
      : `left:${pct.toFixed(2)}%`;
    return `<span class="tick" style="${nudge}">${v}</span>`;
  }).join("");
}

/* The split square is read on the same ramp as a single dataset — the two halves share one
   scale, which is the whole reason they can be compared across the diagonal — so the ramp
   and its keys stay put, and Both adds a key for which game is on which side. */
function updateLegend() {
  // The never swatch has two appearances, because the cells do: paper when the grid is
  // coloured by meetings, red when the empties are flooded. CSS reads this flag.
  document.body.dataset.never = S.highlightNever ? "1" : "0";
  const split = $("legend-split");
  if (split) split.hidden = !isCombined();
  const lm = $("legend-max");
  if (lm) lm.textContent = `1 → ${rampMax(S.gender)}`;
  drawLegend();
  drawLegendTicks();
}

/* ---------- the fold ----------

   The square was always symmetric, so half of it only ever mirrored the other half. Now
   that the mirror is spent on the women's game, each dataset is the *same* split square
   with one half folded back over the other: the men's grid is the split square with the
   men's record folded down across the women's half, the women's grid is its opposite, and
   *Both* is the square with both flaps folded up and out of the way.

   So a dataset switch is one angle per flap. A flap at 0° lies flat over its own half; at
   90° it is edge-on to the viewer, a line of no width, and gone. Nothing is animated past
   that: the two vertices on the diagonal never move and the third slides in to meet them,
   so the whole fold is spent on the half that is actually being revealed or covered.

   Men's straight to women's is the one switch that moves both flaps, and they take it in
   turn rather than together: the men's half stands up first and the women's follows it
   down, overlapping only where both are near edge-on. That costs half a second more and
   buys the one thing the switch should show — the split square, in passing, on the way. */
const FOLD_MS = 600;
const FOLD_DOUBLE_MS = 900;          // one flap up, then the other down
const FOLD_EASE = "cubic-bezier(.58,.02,.28,1)";
const FLAP_ANGLE = {
  men:   { lower: 0,  upper: 90 },
  women: { lower: 90, upper: 0 },
  both:  { lower: 90, upper: 90 },
};
let _foldTimer = null;

// draw() paints through `ctx`. A flap is the same grid in another dataset on another
// canvas, so point it there for one synchronous draw and put everything back.
function paintTo(target, mode, scale) {
  const homeCtx = ctx, homeMode = S.paintMode, homeScale = S.paintScale;
  ctx = target; S.paintMode = mode; S.paintScale = scale;
  try { draw(); } finally { ctx = homeCtx; S.paintMode = homeMode; S.paintScale = homeScale; }
}

function renderFlap(mode, scale) {
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  const g = c.getContext("2d");
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  paintTo(g, mode, scale);
  return c;
}

/* A flap is the whole canvas clipped to one triangle of the grid square. clip-path is
   applied in the element's own coordinates, before the transform, so the fold swings the
   triangle rather than the hole it is cut from — and the hinge is the square's diagonal,
   which is the (1,1,0) axis through its top-left corner. */
function flapClip(half, ox, oy, L) {
  const pts = half === "lower"
    ? [[ox, oy], [ox, oy + L], [ox + L, oy + L]]
    : [[ox, oy], [ox + L, oy], [ox + L, oy + L]];
  return `polygon(${pts.map(([x, y]) => `${x}px ${y}px`).join(", ")})`;
}

// Put the canvas back in charge, whether the fold finished or something interrupted it.
function endFold() {
  clearTimeout(_foldTimer);
  _foldTimer = null;
  const host = $("fold");
  if (host) { host.textContent = ""; host.hidden = true; }
  if (!S.folding && S.paintMode == null) return;
  S.folding = false;
  S.paintMode = null;
  S.paintScale = null;
  draw();
}

/* Switch datasets, folding if there is a fold to show. The panel, the headline and the
   legend move at once; only the canvas lags, painting the split square while the flaps
   are in the air. */
function foldGender(next) {
  const prev = S.gender;
  endFold();
  const host = $("fold");
  // Nothing to fold: no flap host, no change, a list view, the single-team card, a grid too
  // small to read as a square, or a visitor who has asked for less motion.
  const foldable = host && next !== prev && S.view === "grid" && S.manual.size !== 1
    && S.order.length > 1 && !mqReduceMotion.matches;
  if (!foldable) { setGender(next); return; }

  const leaving = document.createElement("canvas");   // the frame we are walking away from
  leaving.width = canvas.width;
  leaving.height = canvas.height;
  leaving.getContext("2d").drawImage(canvas, 0, 0);

  S.hover = null;
  tooltip.hidden = true;
  closePeek();
  S.paintMode = "both";        // under the flaps the canvas is always the split square...
  S.paintScale = next;         // ...but on the ramp it is about to settle on
  setGender(next);
  S.folding = true;            // from here, anything else that redraws calls the fold off

  const ox = MARGIN + S.tx, oy = MARGIN + S.ty, L = S.order.length * S.cell;
  const from = FLAP_ANGLE[prev], to = FLAP_ANGLE[next];
  host.hidden = false;
  // Vanishing-point at the middle of the square, so the lift reads the same in both halves.
  host.style.perspectiveOrigin = `${ox + L / 2}px ${oy + L / 2}px`;

  const moving = [];
  for (const half of ["lower", "upper"]) {
    if (from[half] === 90 && to[half] === 90) continue;     // edge-on at both ends
    const el = renderFlap(half === "lower" ? "men" : "women", next);
    el.className = `flap ${half}`;
    el.style.transformOrigin = `${ox}px ${oy}px`;
    el.style.clipPath = flapClip(half, ox, oy, L);
    el.style.transform = `rotate3d(1,1,0,${from[half]}deg)`;
    host.appendChild(el);
    moving.push([el, to[half]]);
  }

  /* The two datasets rank the teams differently, so the rows come back a few places from
     where they were — a mean of four, in the default order. Holding the frame we left over
     the first moments of the fold, while the easing still has the flaps nearly flat, turns
     that reshuffle into a settle instead of a jump. */
  leaving.className = "leaving";
  host.appendChild(leaving);

  const total = moving.length === 2 ? FOLD_DOUBLE_MS : FOLD_MS;
  const span = moving.length === 2 ? Math.round(FOLD_DOUBLE_MS * .58) : FOLD_MS;
  requestAnimationFrame(() => {
    leaving.style.transition = `opacity ${Math.round(span * .26)}ms linear`;
    leaving.style.opacity = "0";
    for (const [el, angle] of moving) {
      // In a two-flap switch the one lying down waits for the one standing up.
      const wait = angle === 0 ? total - span : 0;
      el.style.transition = `transform ${span}ms ${FOLD_EASE} ${wait}ms`;
      el.style.transform = `rotate3d(1,1,0,${angle}deg)`;
    }
  });
  _foldTimer = setTimeout(endFold, total + 40);
}

/* ---------- interaction ---------- */
function cellAt(mx, my) {
  if (mx < MARGIN || my < MARGIN) return null;
  const c = Math.floor((mx - MARGIN - S.tx) / S.cell);
  const r = Math.floor((my - MARGIN - S.ty) / S.cell);
  if (r < 0 || c < 0 || r >= S.order.length || c >= S.order.length) return null;
  return { r, c };
}

// Which archive a grid cell belongs to: its half of the split square, else the dataset.
const cellGender = rc => (isCombined() ? halfGender(rc.r, rc.c) || "men" : S.gender);
const archiveWord = g => (g === "men" ? "Men's" : "Women's");

/* What one cell's colour is saying, in words, for one archive. */
function archiveSummary(A, B, gender) {
  const asOf = present() ? "" : ` by ${S.year}`;
  if (metAsOf(A.id, B.id, gender)) {
    const cnt = countAsOf(A.id, B.id, gender);
    const p = lookup(A.id, B.id, gender);
    const approx = countsExact() ? "" : "~";
    return { lines: [`${approx}${cnt} ${pl(cnt, "meeting")}${asOf}`,
                     present() ? `${p[1]}–${p[2]}` : `since ${p[1]}`] };
  }
  const up = upcomingInfo(A.id, B.id, gender);
  if (up && present()) {
    return {
      lines: [up[0] >= S.today ? "first meeting coming up" : "first meeting — result pending",
              `${up[0]} · ${up[1]}`],
      upcoming: true,
    };
  }
  // Distinguish the three empties in words as well as in colour.
  for (const t of [A, B]) {
    if (!hasAnyMatches(t.id, gender)) {
      return { lines: [`${t.name} has never played a ${genderWord(gender)} international`],
               silent: true };
    }
  }
  if (!present()) {
    for (const t of [A, B]) {
      const y = debutYear(t.id, gender);
      if (y != null && y > S.year) {
        return { lines: [`${t.name} had not debuted by ${S.year}`, `first match ${y}`],
                 predebut: true };
      }
    }
  }
  return { lines: [`never played${asOf}`, `${genderWord(gender)} internationals`] };
}

/* One description of a pairing, reused by the tooltip, the peek card and the screen reader.

   In the split square a cell belongs to one game, so the caller passes the half the
   pointer landed on: that archive leads, and the cell's own mirror across the diagonal —
   the same pairing in the other game — is the second line. */
function pairSummary(aId, bId, gender = S.gender) {
  const A = S.byId.get(aId), B = S.byId.get(bId);
  if (!A || !B) return { title: "", lines: [] };
  if (A.id === B.id) {
    return { title: A.name, lines: [`${A.confed}${A.defunct ? " · defunct" : ""}`], self: true };
  }
  const title = `${A.name} v ${B.name}`;
  if (gender === "both") {                     // no half in hand: report the two archives
    const say = g => `${archiveWord(g)}: ${archiveSummary(A, B, g).lines[0]}`;
    return { title, lines: [say("men"), say("women")] };
  }
  const sum = archiveSummary(A, B, gender);
  if (!isCombined()) return { ...sum, title };
  const other = gender === "men" ? "women" : "men";
  return { ...sum, title,
           lines: [`${archiveWord(gender)}: ${sum.lines[0]}`,
                   `${archiveWord(other)}: ${archiveSummary(A, B, other).lines[0]}`] };
}
const genderWord = (gender = S.gender) =>
  (gender === "both" ? "senior" : gender === "men" ? "men's" : "women's");

/* Which archive(s) a view is actually reading.

   genderWord() answers "a ___ international" and says "senior" for combined, which reads
   fine in a tooltip. The list views need the other thing — a name for the body of data
   behind the number they print — and getting that wrong is how they ended up labelling a
   men's-only figure "senior". */
function archiveLabel() {
  return isCombined() ? "men's and women's combined"
    : S.gender === "men" ? "men's" : "women's";
}
// The archives a view should read: combined means both, not "men's with a fallback".
const activeArchives = () => (isCombined() ? ["men", "women"] : [dataGender(S.gender)]);

function summaryHtml(sum) {
  const cls = sum.upcoming ? "up" : sum.silent ? "silent" : sum.predebut ? "pre" : "n";
  return `<div class="vs">${esc(sum.title)}</div>`
    + `<div class="${cls}">${esc(sum.lines[0] || "")}</div>`
    + (sum.lines[1] ? `<div class="dim">${esc(sum.lines[1])}</div>` : "");
}

function showTooltip(rc, mx, my) {
  tooltip.innerHTML = summaryHtml(pairSummary(S.order[rc.r], S.order[rc.c], cellGender(rc)));
  tooltip.hidden = false;
  const pad = 14;
  let x = mx + pad, y = my + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > canvas.clientWidth) x = mx - rect.width - pad;
  if (y + rect.height > canvas.clientHeight) y = my - rect.height - pad;
  tooltip.style.left = Math.max(4, x) + "px";
  tooltip.style.top = Math.max(4, y) + "px";
}

/* The peek card: touch's answer to hover.

   A tap used to go straight to the full head-to-head, which on a phone-sized grid meant
   committing to whichever of nine candidate cells the finger happened to cover. Now a tap
   shows what it landed on and offers to open it — and if the cells are too small to aim at,
   the same tap zooms in first so the next one is accurate. */
function closePeek() { const el = $("peek"); if (el) el.hidden = true; }

function showPeek(rc, px, py) {
  const el = $("peek");
  if (!el) return;
  const aId = S.order[rc.r], bId = S.order[rc.c];
  const sum = pairSummary(aId, bId, cellGender(rc));
  el.innerHTML = summaryHtml(sum)
    + `<div class="peek-act">`
    + (sum.self ? "" : `<button type="button" class="peek-open">See all meetings</button>`)
    + `<button type="button" class="peek-close" aria-label="Dismiss">Close</button></div>`;
  el.hidden = false;
  const open = el.querySelector(".peek-open");
  if (open) open.onclick = () => { closePeek(); openPair(aId, bId); };
  el.querySelector(".peek-close").onclick = closePeek;

  const rect = el.getBoundingClientRect();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  let x = Math.min(Math.max(8, px - rect.width / 2), W - rect.width - 8);
  let y = py + 18;
  if (y + rect.height > H - 8) y = Math.max(8, py - rect.height - 18);
  el.style.left = x + "px";
  el.style.top = y + "px";
  announce(`${sum.title}. ${sum.lines.join(". ")}`);
}

function zoomAt(px, py, newCell) {  // px,py = canvas-relative coords of the fixed point
  if (S.folding) endFold();          // the flaps are pinned to the geometry they left on
  newCell = Math.max(MIN_CELL, Math.min(80, newCell));
  const before = MARGIN;
  const k = newCell / S.cell;
  const mx = px - before, my = py - before;
  S.tx = mx - (mx - S.tx) * k;
  S.ty = my - (my - S.ty) * k;
  S.cell = newCell;
  // The label gutter grows with the cells; keep the point under the cursor put.
  MARGIN = marginFor(S.cell);
  S.tx -= (MARGIN - before);
  S.ty -= (MARGIN - before);
  clampPan();
  draw();
}
function zoomBy(factor) {
  zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, S.cell * factor);
}

function setupInteraction() {
  // Pointer Events unify mouse + touch: 1 pointer = pan/tap, 2 pointers = pinch-zoom.
  const pts = new Map();            // active pointers: id -> {x, y}
  let mode = null;                  // "pan" | "pinch"
  let downX = 0, downY = 0, moved = false, longPress = null, longFired = false;
  let pinchDist = 0, pinchCell = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const cancelLong = () => { if (longPress) { clearTimeout(longPress); longPress = null; } };

  canvas.addEventListener("pointerdown", e => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      mode = "pan"; downX = e.clientX; downY = e.clientY; moved = false; longFired = false;
      canvas.classList.add("panning");
      if (e.pointerType !== "mouse") {
        // Long-press previews in place, without the zoom a tap would do.
        const r = canvas.getBoundingClientRect();
        const lx = e.clientX - r.left, ly = e.clientY - r.top;
        longPress = setTimeout(() => {
          const rc = cellAt(lx, ly);
          if (rc && !moved) { longFired = true; showPeek(rc, lx, ly); }
        }, 450);
      }
    } else if (pts.size === 2) {
      cancelLong();
      mode = "pinch";
      const [a, b] = [...pts.values()];
      pinchDist = dist(a, b) || 1; pinchCell = S.cell;
    }
  });

  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect();
    if (!pts.has(e.pointerId)) {                 // hover (mouse only — no button held)
      if (e.pointerType === "mouse") {
        const rc = cellAt(e.clientX - r.left, e.clientY - r.top);
        S.hover = rc;
        if (rc) showTooltip(rc, e.clientX - r.left, e.clientY - r.top); else tooltip.hidden = true;
        draw();
      }
      return;
    }
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode === "pinch" && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      zoomAt(cx, cy, pinchCell * (dist(a, b) / pinchDist));
    } else if (mode === "pan") {
      if (S.folding) endFold();
      S.tx += e.clientX - prev.x; S.ty += e.clientY - prev.y;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= 5) { moved = true; cancelLong(); }
      clampPan(); S.hover = null; tooltip.hidden = true; draw();
    }
  });

  function endPointer(e) {
    cancelLong();
    if (pts.has(e.pointerId)) {
      if (mode === "pan" && pts.size === 1 && !moved && !longFired) {
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        if (e.pointerType === "mouse") {
          const rc = cellAt(px, py);              // a precise device: open it directly
          if (rc) { S.focus = rc; openDetail(rc); } else { closeDetail(); closePeek(); }
        } else {
          // Touch: aim first, commit second. Zoom in if the target is smaller than a fingertip.
          if (S.cell < TAP_LEGIBLE) {
            zoomAt(px, py, TAP_LEGIBLE);
          }
          const rc = cellAt(px, py);
          if (rc) { S.focus = rc; showPeek(rc, px, py); draw(); } else { closePeek(); }
        }
      }
      pts.delete(e.pointerId);
    }
    if (pts.size === 0) { mode = null; canvas.classList.remove("panning"); }
    else if (pts.size === 1) {                  // a finger lifted after a pinch
      mode = "pan"; const p = [...pts.values()][0];
      downX = p.x; downY = p.y; moved = true;   // don't treat the lift as a tap
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", e => {
    if (e.pointerType === "mouse") { S.hover = null; tooltip.hidden = true; draw(); }
  });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, S.cell * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  setupKeyboard();
}

/* Keyboard access to the grid.

   A canvas is invisible to a keyboard and to a screen reader unless you build the
   navigation yourself: arrow keys walk the cells, the live region reads out whatever the
   focus lands on, and Enter opens the same head-to-head a click would. */
function setupKeyboard() {
  canvas.addEventListener("focus", () => {
    if (!S.focus && S.order.length) {
      S.focus = { r: 0, c: Math.min(1, S.order.length - 1) };
      scrollFocusIntoView();
      announceFocus();
    }
    draw();
  });
  canvas.addEventListener("blur", () => { draw(); });

  canvas.addEventListener("keydown", e => {
    const n = S.order.length;
    if (!n) return;
    const f = S.focus || { r: 0, c: 0 };
    let handled = true;
    switch (e.key) {
      case "ArrowUp": f.r = Math.max(0, f.r - 1); break;
      case "ArrowDown": f.r = Math.min(n - 1, f.r + 1); break;
      case "ArrowLeft": f.c = Math.max(0, f.c - 1); break;
      case "ArrowRight": f.c = Math.min(n - 1, f.c + 1); break;
      case "Home": f.c = 0; break;
      case "End": f.c = n - 1; break;
      case "PageUp": f.r = Math.max(0, f.r - 10); break;
      case "PageDown": f.r = Math.min(n - 1, f.r + 10); break;
      case "Enter": case " ":
        S.focus = f; openDetail(f); break;
      case "+": case "=": zoomBy(1.4); break;
      case "-": case "_": zoomBy(1 / 1.4); break;
      case "f": case "F": fitView(); draw(); break;
      case "Escape": closeDetail(); closePeek(); break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End"
        || e.key.startsWith("Page")) {
      S.focus = f;
      scrollFocusIntoView();
      announceFocus();
    }
    draw();
  });
}

// Keep the keyboard focus on screen, panning the viewport if it has walked off the edge.
function scrollFocusIntoView() {
  if (!S.focus) return;
  const { w, h } = gridArea();
  const x = S.tx + S.focus.c * S.cell, y = S.ty + S.focus.r * S.cell;
  const pad = S.cell * 2;
  if (x < pad) S.tx += pad - x;
  if (x + S.cell > w - pad) S.tx -= (x + S.cell) - (w - pad);
  if (y < pad) S.ty += pad - y;
  if (y + S.cell > h - pad) S.ty -= (y + S.cell) - (h - pad);
  clampPan();
}
function announceFocus() {
  if (!S.focus) return;
  const sum = pairSummary(S.order[S.focus.r], S.order[S.focus.c], cellGender(S.focus));
  announce(`${sum.title}. ${sum.lines.join(". ")}`);
}

/* ---------- match-detail card (lazy-loaded) ---------- */
async function ensureMatches(gender) {
  const g = dataGender(gender);
  if (!S.matches[g]) {
    S.matches[g] = await fetch(`data/matches_${g}.json` + VBUST).then(r => r.json());
  }
  return S.matches[g];
}

let _detailReturnFocus = null;
function closeDetail() {
  const card = $("detail");
  if (!card || card.hidden) return;
  card.hidden = true;
  // Send focus back where it came from; losing it into the void is its own accessibility bug.
  const back = _detailReturnFocus;
  _detailReturnFocus = null;
  if (back && document.contains(back)) { try { back.focus(); } catch { /* ignore */ } }
}

function openDetail(rc) { openPair(S.order[rc.r], S.order[rc.c]); }

function openPair(aId, bId) {
  const A = S.byId.get(aId);
  const B = S.byId.get(bId);
  const card = $("detail");
  if (!A || !B || A.id === B.id) { closeDetail(); return; }
  if (!_detailReturnFocus) {
    _detailReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
  }
  card.hidden = false;
  card.innerHTML =
    `<div class="dh"><div class="dt">${esc(teamLabel(A))} <span class="vs">vs</span> `
    + `${esc(teamLabel(B))}</div>
     <button type="button" class="dx" aria-label="Close" title="Close">&times;</button></div>
     <div class="db dim">Loading match history…</div>`;
  const closeBtn = card.querySelector(".dx");
  closeBtn.onclick = closeDetail;
  closeBtn.focus();
  // token guards against a slow fetch resolving after the user clicked elsewhere
  const token = (card.dataset.token = String(Date.now()) + Math.random());
  const fail = () => {
    const db = card.querySelector(".db");
    if (db && card.dataset.token === token) db.textContent = "Couldn't load match details.";
  };
  const genders = isCombined() ? ["men", "women"] : [dataGender(S.gender)];
  Promise.all(genders.map(ensureMatches))
    .then(datasets => {
      if (card.dataset.token !== token) return;
      const db = card.querySelector(".db");
      if (!db) return;
      db.classList.remove("dim");
      db.innerHTML = genders.length === 1
        ? historyHtml(A, B, datasets[0], genders[0]).html
        : genders.map((g, i) =>
            `<div class="det-gender"><span class="det-label" `
            + `style="color:var(--${g}-only)">${g === "men" ? "Men's" : "Women's"}</span>`
            + `${historyHtml(A, B, datasets[i], g).html}</div>`).join("");
      announce(`${A.name} versus ${B.name}. ${db.textContent.trim().slice(0, 160)}`);
    })
    .catch(fail);
}

const teamLabel = m => (m.flag ? m.flag + " " : "") + m.name;

/* One gender's head-to-head: summary line + newest-first meeting rows.
   The detail card and the combined card are the same renderer; they used to be two copies
   of the same thirty lines. */
function historyHtml(A, B, data, gender) {
  const lo = Math.min(A.id, B.id), hi = Math.max(A.id, B.id);
  const list = data.pairs[`${lo},${hi}`] || [];
  const T = data.tournaments;
  const gLabel = gender === "women" ? " (women's)" : gender === "men" ? " (men's)" : "";
  if (!list.length) {
    return { count: 0, html: `<div class="never">Never played${esc(gLabel)}.</div>` };
  }
  const aIsLo = A.id === lo;
  let w = 0, d = 0, l = 0, gf = 0, ga = 0, unknown = 0;
  const rows = [];
  for (let i = list.length - 1; i >= 0; i--) {          // newest first
    const [yr, glo, ghi, ti] = list[i];
    const known = glo != null && ghi != null;
    const sa = aIsLo ? glo : ghi, sb = aIsLo ? ghi : glo;
    let res = "u";
    if (known) {
      gf += sa; ga += sb;
      res = sa > sb ? "w" : sa < sb ? "l" : "d";
      if (res === "w") w++; else if (res === "l") l++; else d++;
    } else { unknown++; }
    const tn = esc(T[ti] || "");
    rows.push(`<div class="mr ${res}"><span class="yr">${yr == null ? "?" : yr}</span>`
      + `<span class="sc">${known ? `${sa}–${sb}` : "—"}</span>`
      + `<span class="tn" title="${tn}">${tn}</span></div>`);
  }
  const html =
    `<div class="sum"><b>${list.length}</b> ${pl(list.length, "meeting")} · `
    + `<span class="w">${w}W</span> <span class="d">${d}D</span> <span class="l">${l}L</span>`
    + (unknown ? ` <span class="dim">+${unknown}?</span>` : "") + ` · `
    + `<span class="gd">${gf}–${ga}</span> <span class="dim">(${esc(A.name)})</span></div>`
    + `<div class="mlist">${rows.join("")}</div>`;
  return { count: list.length, html };
}

/* ---------- single-team focus (one team manually selected) ---------- */
function renderTeamFocus(teamId) {
  const team = S.byId.get(teamId);
  const panel = $("teamfocus");
  if (!team) { panel.hidden = true; return; }
  const combined = isCombined();

  let pool = S.members.filter(m => m.id !== teamId);
  if (S.includeDefunct) pool = pool.concat(S.defunct.members.filter(m => m.id !== teamId));

  const rows = pool.map(o => {
    const pm = lookup(teamId, o.id, "men"), pw = lookup(teamId, o.id, "women");
    const mc = pm ? pm[0] : 0, wc = pw ? pw[0] : 0;
    if (combined) {
      return { o, mc, wc, total: mc + wc, cat: (mc > 0 ? 1 : 0) | (wc > 0 ? 2 : 0),
               last: Math.max(pm ? pm[2] : 0, pw ? pw[2] : 0) || null };
    }
    const p = lookup(teamId, o.id);
    const n = p ? p[0] : 0;
    return { o, mc, wc, total: n, cat: n ? 1 : 0, last: p ? p[2] : null };
  }).sort((a, b) => b.total - a.total || a.o.name.localeCompare(b.o.name));

  const played = rows.filter(r => r.cat);
  const never = rows.filter(r => !r.cat);
  const maxC = played.length ? played[0].total : 1;
  const catColor = c => c === 3 ? getCss("--both") : c === 1 ? getCss("--men-only")
    : c === 2 ? getCss("--women-only") : getCss("--grid-strong");

  const row = r => {
    const dot = combined ? catColor(r.cat) : confedColor(r.o.confed);
    const title = combined
      ? `men's: ${r.mc || "never"} · women's: ${r.wc || "never"}`
      : `${r.o.confed}${r.total ? ` · ${r.total} ${pl(r.total, "meeting")}` : " · never met"}`;
    return `<button type="button" class="tf-row${r.total ? "" : " none"}" data-opp="${r.o.id}" `
      + `title="${esc(title)}">`
      + `<span class="tf-dot" style="background:${esc(dot)}"></span>`
      + `<span class="tf-name">${esc(teamLabel(r.o))}</span>`
      + `<span class="tf-bar"><span style="width:${Math.round(100 * r.total / maxC)}%"></span></span>`
      + `<span class="tf-n">${r.total || "—"}</span>`
      + `<span class="tf-last">${r.last || ""}</span></button>`;
  };

  const gLabel = genderWord();
  const head = combined
    ? `<div class="tf-title">${esc(teamLabel(team))} — opponents by game played in</div>
       <div class="tf-sum"><b style="color:var(--both)">${played.filter(r => r.cat === 3).length}</b> both ·
         <b style="color:var(--men-only)">${played.filter(r => r.cat === 1).length}</b> men's-only ·
         <b style="color:var(--women-only)">${played.filter(r => r.cat === 2).length}</b> women's-only ·
         <b class="never">${never.length}</b> neither</div>`
    : `<div class="tf-title">${esc(teamLabel(team))} — fixtures, most to least played</div>
       <div class="tf-sum">Played <b>${played.length}</b> of ${rows.length} opponents ·
         <b class="never">${never.length}</b> never met · ${esc(gLabel)}</div>`;

  const neverLabel = combined ? "Never met in either" : "Never played";
  panel.innerHTML =
    `<div class="tf-head">${head}</div>`
    + `<div class="tf-list">${played.map(row).join("")}`
    + (never.length ? `<div class="tf-sep">${neverLabel} (${never.length})</div>` : "")
    + `${never.map(row).join("")}</div>`;
  panel.onclick = e => {
    const b = e.target.closest(".tf-row");
    if (b) openPair(teamId, +b.dataset.opp);
  };
  panel.hidden = false;

  const headline = $("headline");
  headline.classList.toggle("combined", combined);
  headline.classList.remove("allplayed", "played");
  if (combined) {
    const both = played.filter(r => r.cat === 3).length;
    headline.innerHTML = `<span class="big">${both}</span>`
      + `<span class="rest">opponents <b>${esc(team.name)}</b> has met in <b>both</b> games — `
      + `${played.filter(r => r.cat === 1).length} men's-only, `
      + `${played.filter(r => r.cat === 2).length} women's-only, ${never.length} never met.</span>`;
  } else if (!played.length) {
    headline.innerHTML = `<span class="big">0</span>`
      + `<span class="rest"><b>${esc(team.name)}</b> has never played a <b>${esc(gLabel)}</b> `
      + `international against anyone.</span>`;
  } else {
    // Same framing as the grid headline: count the opponents met, not the ones missing.
    headline.classList.add("played");
    headline.innerHTML = `<span class="big">${played.length}</span>`
      + `<span class="rest">${pl(played.length, "opponent")} <b>${esc(team.name)}</b> `
      + `has played (${esc(gLabel)}), out of ${rows.length} possible.</span>`;
  }
}

/* ---------- the played graph: adjacency, common opponents, shortest paths ---------- */
/* 211 nodes and ~6,500 edges, so the whole graph fits in a handful of bitset words per
   team. Common-opponent counts for all 15,635 never-played pairs come out in a few ms. */
let _graphCache = null;
function graph() {
  const key = scopeKey();
  if (_graphCache && _graphCache.key === key) return _graphCache;

  // Only the teams the filters admit, only the archives the toggle selects, and only the
  // meetings that had happened by the scrubbed year — so "never played" and "opponents in
  // common" mean the same thing here as they do on the grid.
  const ids = scopeMembers().map(m => m.id);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length, W = Math.ceil(n / 32);
  const bits = new Uint32Array(n * W);
  const adj = ids.map(() => []);
  const has = (a, b) => (bits[a * W + (b >> 5)] >>> (b & 31)) & 1;
  for (const g of activeArchives()) {
    for (const k of S.pairs[g].keys()) {
      const comma = k.indexOf(",");
      const idA = +k.slice(0, comma), idB = +k.slice(comma + 1);
      const a = pos.get(idA), b = pos.get(idB);
      if (a === undefined || b === undefined) continue;
      if (!metAsOf(idA, idB, g)) continue;
      if (has(a, b)) continue;                  // combined view: the two archives overlap
      bits[a * W + (b >> 5)] |= (1 << (b & 31));
      bits[b * W + (a >> 5)] |= (1 << (a & 31));
      adj[a].push(b); adj[b].push(a);
    }
  }
  _graphCache = { key, ids, pos, n, W, bits, adj };
  return _graphCache;
}
// Have these two met in ANY archive the current toggle covers, as of the scrubbed year?
function metInView(a, b) {
  return activeArchives().some(g => metAsOf(a, b, g));
}
// Total meetings across the archives the toggle covers, as of the scrubbed year.
function countInView(a, b) {
  return activeArchives().reduce((t, g) => t + countAsOf(a, b, g), 0);
}
function popcount(v) {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}
function commonOpponents(g, a, b) {
  let total = 0;
  for (let w = 0; w < g.W; w++) total += popcount(g.bits[a * g.W + w] & g.bits[b * g.W + w]);
  return total;
}
// Shortest chain of actual matches from one team to another.
function shortestPath(g, fromId, toId) {
  const s = g.pos.get(fromId), t = g.pos.get(toId);
  if (s === undefined || t === undefined) return null;
  if (s === t) return [fromId];
  const prev = new Int32Array(g.n).fill(-1);
  const seen = new Uint8Array(g.n);
  seen[s] = 1;
  let frontier = [s];
  while (frontier.length) {
    const next = [];
    for (const u of frontier) {
      for (const v of g.adj[u]) {
        if (seen[v]) continue;
        seen[v] = 1; prev[v] = u;
        if (v === t) {
          const path = [];
          for (let k = t; k !== -1; k = prev[k]) path.push(g.ids[k]);
          return path.reverse();
        }
        next.push(v);
      }
    }
    frontier = next;
  }
  return null;
}

/* ---------- list views ---------- */
function daysUntil(iso) {
  const d = new Date(iso + "T00:00:00"), now = new Date(S.today + "T00:00:00");
  return Math.round((d - now) / 86400000);
}
function countdown(iso) {
  const n = daysUntil(iso);
  if (n < 0) return { text: `${-n}d ago`, cls: "past" };
  if (n === 0) return { text: "today", cls: "now" };
  if (n === 1) return { text: "tomorrow", cls: "now" };
  if (n < 31) return { text: `in ${n} days`, cls: "soon" };
  if (n < 365) return { text: `in ${Math.round(n / 30)} months`, cls: "" };
  return { text: `in ${(n / 365).toFixed(1)} years`, cls: "" };
}
const fmtDate = iso =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" });

function pairRowHtml(aId, bId, right, cls = "") {
  const A = S.byId.get(aId), B = S.byId.get(bId);
  if (!A || !B) return "";
  // The "v" travels with the second team, so a row that wraps on a narrow screen breaks
  // as "Montserrat" / "v Turks and Caicos Islands" instead of stranding the separator.
  return `<button type="button" class="lv-row ${cls}" data-a="${aId}" data-b="${bId}">`
    + `<span class="lv-teams"><span class="lv-t">${esc(teamLabel(A))}</span>`
    + `<span class="lv-t"><span class="lv-v">v</span> ${esc(teamLabel(B))}</span></span>`
    + `<span class="lv-right">${right}</span></button>`;
}
function wireRows(host) {
  host.onclick = e => {
    const b = e.target.closest(".lv-row");
    if (b) openPair(+b.dataset.a, +b.dataset.b);
  };
}

/* Fixtures — the feed. Every pair of nations with a date on the calendar and no history. */
function renderFixtures() {
  const host = $("view-fixtures");
  const cut = new Date(S.today + "T00:00:00"); cut.setDate(cut.getDate() - 14);
  const cutoff = cut.toISOString().slice(0, 10);
  const groups = [];
  const inScope = new Set(scopeMembers().map(m => m.id));
  for (const g of ["men", "women"]) {
    const items = [];
    for (const [key, [date, tourn]] of S.upcoming[g]) {
      if (date < cutoff) continue;                 // drop stale / abandoned fixtures
      const [lo, hi] = key.split(",").map(Number);
      if (!S.byId.has(lo) || !S.byId.has(hi)) continue;
      if (!inScope.has(lo) || !inScope.has(hi)) continue;   // obey the panel's filter
      items.push({ lo, hi, date, tourn, future: date >= S.today });
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    if (items.length) groups.push({ g, items });
  }

  if (!groups.length) {
    host.innerHTML = `<div class="lv-empty"><p>No first-ever meetings are on the calendar
      ${isFiltered() ? "for the teams in the current filter" : "right now"}.</p>
      <p class="hint">Fixtures come from martj42's advance listings and ESPN's scoreboard,
      up to two years out.</p></div>`;
    return;
  }

  host.innerHTML =
    `<div class="lv-head">
       <h2>Never met. Scheduled to.</h2>
       <p>Every pairing below would be a first meeting in the history of the game — two
          national teams that have never played each other, with a date. This feed covers
          <b>both</b> games, whichever dataset the grid is set to${esc(isFiltered() ? ", filtered to the teams in the panel" : "")}.
          <a href="feed.xml">Subscribe by RSS</a> or <a href="feed.json">JSON</a>.</p>
     </div>`
    + groups.map(gr =>
      `<div class="lv-group"><h3>${gr.g === "men" ? "Men's" : "Women's"}
         <span class="hint">${gr.items.filter(i => i.future).length} upcoming</span></h3>`
      + gr.items.map(it => {
        const cd = countdown(it.date);
        return pairRowHtml(it.lo, it.hi,
          `<span class="lv-when ${cd.cls}">${esc(cd.text)}</span>`
          + `<span class="lv-sub">${esc(fmtDate(it.date))} · ${esc(it.tourn)}</span>`,
          it.future ? "" : "pending");
      }).join("")
      + `</div>`).join("");
  wireRows(host);
}

/* One-offs — pairs that met exactly once and never again. */
function oneOffPairs() {
  // Candidate keys across every archive the toggle covers, so "met exactly once" in the
  // combined view means once in total rather than once in the men's game.
  const seen = new Set();
  const rows = [];
  const inScope = new Set(scopeMembers().map(m => m.id));
  for (const g of activeArchives()) {
    for (const [key, val] of S.pairs[g]) {
      if (seen.has(key)) continue;
      seen.add(key);
      const [lo, hi] = key.split(",").map(Number);
      if (!inScope.has(lo) || !inScope.has(hi)) continue;
      if (countInView(lo, hi) !== 1) continue;
      // The single meeting's year: whichever archive holds it.
      let year = val[1];
      if (isCombined()) {
        for (const g2 of activeArchives()) {
          if (countAsOf(lo, hi, g2) === 1) { const p2 = S.pairs[g2].get(key); year = p2 && p2[1]; }
        }
      }
      rows.push({ lo, hi, year });
    }
  }
  rows.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  return rows;
}

function renderOneOffs() {
  const host = $("view-oneoffs");
  // Counting meetings "by year Y" needs the per-pair years; the grid gets by on first-meeting
  // years alone, this view cannot. Fetch once, then re-render.
  if (!present() && !countsExact()) {
    host.innerHTML = `<div class="lv-head"><h2>Played once. Never again.</h2>
      <p>Counting meetings as of ${S.year}…</p></div>`;
    ensureYearsForView().then(() => { if (S.view === "oneoffs") { renderOneOffs(); updateHeadline(); } });
    return;
  }
  const rows = oneOffPairs();
  const shown = rows.slice(0, 300);

  host.innerHTML =
    `<div class="lv-head">
       <h2>Played once. Never again.</h2>
       <p><b>${num(rows.length)}</b> ${esc(archiveLabel())} ${pl(rows.length, "pairing")} had met
          exactly once${present() ? " in the whole history of the fixture list" : ` by ${S.year}`}${esc(scopeNote())}
          — oldest first, so the top of this list is the longest either side has gone without
          a rematch.</p>
     </div>`
    + (rows.length ? `<div class="lv-group">`
      + shown.map(r => pairRowHtml(r.lo, r.hi,
          `<span class="lv-when">${r.year ?? "?"}</span>`
          + `<span class="lv-sub">${esc(yearsAgo(r.year))}</span>`)).join("")
      + `</div>`
      : `<div class="lv-empty"><p>No pairing in the current filter has met exactly once.</p></div>`)
    + (rows.length > shown.length
      ? `<p class="lv-more">Showing the ${shown.length} oldest of ${num(rows.length)}.</p>` : "");
  wireRows(host);
}
function yearsAgo(year) {
  if (year == null) return "";
  const n = new Date().getFullYear() - year;
  return n <= 0 ? "this year" : `${n} ${pl(n, "year")} ago`;
}

/* Near misses — never played, but they keep almost meeting.
   Ranked by shared opponents, which is a real graph measure rather than a hunch: two teams
   with fifty opponents in common and no meeting between them are genuinely circling. */
function renderMisses() {
  const host = $("view-misses");
  const g = graph();
  const out = [];
  for (let a = 0; a < g.n; a++) {
    for (let b = a + 1; b < g.n; b++) {
      const aId = g.ids[a], bId = g.ids[b];
      if (metInView(aId, bId)) continue;                      // they have met
      const shared = commonOpponents(g, a, b);
      if (shared < 8) continue;
      const A = S.byId.get(aId), B = S.byId.get(bId);
      out.push({ aId, bId, shared, same: A.confed === B.confed });
    }
  }
  // Ranked on the number the row actually shows. A hidden bonus for same-confederation
  // pairs made the visible column read as unsorted (73, 68, 67, 64, 73 …), which looks
  // like a bug however defensible the weighting is; confederation is the tie-break and
  // is on the row for the reader to weigh themselves.
  out.sort((x, y) => y.shared - x.shared
    || (y.same ? 1 : 0) - (x.same ? 1 : 0)
    || S.byId.get(x.aId).name.localeCompare(S.byId.get(y.aId).name));
  const shown = out.slice(0, 120);

  host.innerHTML =
    `<div class="lv-head">
       <h2>Closest to happening.</h2>
       <p>Pairs that had <b>never</b> played each other${present() ? "" : ` by ${S.year}`},
          ranked by how many opponents they <i>have</i> in common. Nothing here is scheduled —
          this is the list of fixtures that keep not happening.
          <span class="lv-scope">${esc(archiveLabel())} archive${esc(scopeNote())}</span>.</p>
     </div>`
    + (shown.length ? `<div class="lv-group">`
      + shown.map(r => pairRowHtml(r.aId, r.bId,
          `<span class="lv-when">${r.shared}</span>`
          + `<span class="lv-sub">shared opponents${r.same
            ? ` · both ${esc(S.byId.get(r.aId).confed)}` : ""}</span>`)).join("")
      + `</div>`
      : `<div class="lv-empty"><p>No pair in the current filter has eight or more opponents
         in common without having met. Widen the confederation filter, or scrub forward.</p></div>`);
  wireRows(host);
}

/* Connect — the shortest chain of real matches between any two teams. */
function renderPath() {
  const host = $("view-path");
  const pool = scopeMembers().slice().sort((a, b) => a.name.localeCompare(b.name));
  const g = graph();
  if (S.path.a == null || !g.pos.has(S.path.a)) {
    S.path.a = (pool.find(m => m.name === "Tonga") || pool[0]).id;
  }
  if (S.path.b == null || !g.pos.has(S.path.b)) {
    S.path.b = (pool.find(m => m.name === "Brazil") || pool[pool.length - 1]).id;
  }
  const opts = sel => pool.map(m =>
    `<option value="${m.id}"${m.id === sel ? " selected" : ""}>${esc(m.name)}</option>`).join("");

  const path = shortestPath(g, S.path.a, S.path.b);
  let body;
  if (!pool.length) {
    body = `<div class="lv-empty"><p>No teams are in the current filter. Widen the
      confederation filter in the panel to pick two.</p></div>`;
  } else if (!path) {
    const undebuted = [S.path.a, S.path.b]
      .map(id => S.byId.get(id))
      .filter(m => m && (!hasAnyMatches(m.id) || notYetDebuted(m.id)));
    const why = undebuted.length
      ? `${esc(undebuted.map(m => m.name).join(" and "))} had not played anyone
         ${present() ? "in this archive" : `by ${S.year}`}.`
      : `The confederation filter may have removed the teams that link them.`;
    body = `<div class="lv-empty"><p>No chain of matches connects these two in the
      ${esc(archiveLabel())} archive${esc(asOfNote())}${esc(scopeNote())}. ${why}</p></div>`;
  } else if (path.length === 1) {
    body = `<div class="lv-empty"><p>Pick two different teams.</p></div>`;
  } else {
    const hops = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p = lookup(path[i], path[i + 1]);
      const n = countInView(path[i], path[i + 1]);
      hops.push(pairRowHtml(path[i], path[i + 1],
        `<span class="lv-when">${n}</span>`
        + `<span class="lv-sub">${pl(n, "meeting")}${p && p[2] && present() ? ` · last ${p[2]}` : ""}</span>`));
    }
    const degrees = path.length - 1;
    body = `<p class="path-sum"><b>${degrees}</b> ${pl(degrees, "degree")} of separation.</p>`
      + `<div class="lv-group">${hops.join("")}</div>`;
  }

  host.innerHTML =
    `<div class="lv-head">
       <h2>How far apart are any two teams?</h2>
       <p>The shortest chain of matches that have actually been played, from one national
          team to another. <span class="lv-scope">${esc(archiveLabel())} archive`
    + `${esc(asOfNote())}${esc(scopeNote())}</span>.</p>
       <div class="path-pick">
         <label class="sr-only" for="path-a">From</label>
         <select id="path-a">${opts(S.path.a)}</select>
         <span class="path-arrow">→</span>
         <label class="sr-only" for="path-b">To</label>
         <select id="path-b">${opts(S.path.b)}</select>
       </div>
     </div>${body}`;
  wireRows(host);
  $("path-a").onchange = e => { S.path.a = +e.target.value; renderPath(); updateHeadline(); writeUrl(); };
  $("path-b").onchange = e => { S.path.b = +e.target.value; renderPath(); updateHeadline(); writeUrl(); };
}

/* ---------- fact strip ----------
   A number on its own is not a reason to keep reading. facts.json is built alongside the
   matrices (see build_facts in build.py), so these refresh with the data instead of being
   hand-written prose that quietly goes out of date. One at a time, shuffled per visit, and
   each one links at the view that proves it. */
const FACTS = { list: [], at: 0 };

async function loadFacts() {
  let facts;
  try {
    facts = (await fetch("data/facts.json" + VBUST).then(r => r.json())).facts;
  } catch {
    return;                       // an older build has no facts.json; the strip stays hidden
  }
  if (!Array.isArray(facts) || !facts.length) return;
  // Shuffled, so a returning visitor is not met by the same line every time.
  for (let i = facts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [facts[i], facts[j]] = [facts[j], facts[i]];
  }
  FACTS.list = facts;
  FACTS.at = 0;
  $("fact-next").onclick = () => showFact(FACTS.at + 1);
  showFact(0);
}

function showFact(i) {
  const strip = $("factstrip");
  if (!FACTS.list.length) return;
  FACTS.at = ((i % FACTS.list.length) + FACTS.list.length) % FACTS.list.length;
  const f = FACTS.list[FACTS.at];
  const paint = () => {
    $("fact").innerHTML = `<span class="fact-stat">${esc(f.stat)}</span>${esc(f.text)}`;
    $("fact-link").href = f.url;
    strip.classList.remove("swapping");
  };
  // Only fade when there is something to fade from.
  if (strip.hidden) { paint(); } else { strip.classList.add("swapping"); setTimeout(paint, 180); }
  syncFactStrip();
}

/* The list views open with their own standfirst explaining what is in them, so the strip
   would be a second competing explanation. Keep it to the grid, which is the landing. */
function syncFactStrip() {
  const strip = $("factstrip");
  if (strip) strip.hidden = !FACTS.list.length || S.view !== "grid";
}

/* ---------- headline ---------- */
function updateStats() { updateHeadline(); }

function updateHeadline() {
  const headline = $("headline");
  headline.classList.remove("allplayed", "combined", "played");
  if (S.view === "fixtures") return headlineFixtures(headline);
  if (S.view === "oneoffs") return headlineOneOffs(headline);
  if (S.view === "misses") return headlineMisses(headline);
  if (S.view === "path") return headlinePath(headline);
  if (S.manual.size === 1) return;                 // team focus writes its own
  return isCombined() ? headlineCombined(headline) : headlineGrid(headline);
}

function headlineGrid(headline) {
  const counts = metCounts();
  const total = counts.total;
  const met = S.gender === "men" ? counts.men : counts.women;
  const never = total - met;
  const g = genderWord();
  const filter = (S.manual.size || S.showConfeds.size < S.confedOrder.length) ? " in this view" : "";
  const scope = present() ? filter : `${filter} by ${S.year}`;

  if (total === 0) {                       // fewer than two teams to compare
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">Pick at least two teams or confederations to compare.</span>`;
  } else if (never === 0) {                 // every possible fixture has happened
    headline.classList.add("allplayed");
    headline.innerHTML = `<span class="big">100%</span>`
      + `<span class="rest">every one of the ${num(total)} possible <b>${esc(g)}</b> `
      + `${pl(total, "fixture")}${esc(scope)} has been played — no unplayed pairings here.</span>`;
  } else {
    const pct = 100 * met / total;
    // Lead with what has happened. The grid already shows the absence; the headline does
    // not need to count it too.
    headline.classList.add("played");
    // Only name the membership when the grid really is all of it: under a filter the count
    // is the subset, not FIFA, and scrubbed back it is an anachronism.
    const whose = (!filter && present())
      ? ` between FIFA's ${num(S.order.length)} members` : "";
    headline.innerHTML = `<span class="big">${num(met)}</span>`
      + `<span class="rest"><b>${esc(g)}</b> ${pl(met, "fixture")} ${met === 1 ? "has" : "have"} `
      + `been played${esc(scope)}, <b>${pct.toFixed(1)}%</b> of the ${num(total)} possible `
      + `${pl(total, "pairing")}${whose}.</span>`;
  }
}

function headlineCombined(headline) {
  const c = metCounts();
  headline.classList.add("combined");
  if (c.total === 0) {
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">Pick at least two teams or confederations to compare.</span>`;
    return;
  }
  const menOnly = c.men - c.both, womenOnly = c.women - c.both;
  const neither = c.total - c.both - menOnly - womenOnly;
  const filter = (S.manual.size || S.showConfeds.size < S.confedOrder.length) ? " in this view" : "";
  const scope = present() ? filter : `${filter} as of ${S.year}`;
  // Lead with the gap between the halves: it is what the split square is for.
  headline.innerHTML =
    `<span class="big">${num(c.men)}</span>`
    + `<span class="rest"><b>men's</b> ${pl(c.men, "fixture")} above the diagonal, `
    + `<b>${num(c.women)}</b> <b>women's</b> below it${esc(scope)} — ${num(c.both)} `
    + `${pl(c.both, "pairing")} played in both games, ${num(menOnly)} in the men's alone, `
    + `${num(womenOnly)} in the women's, ${num(neither)} in neither.</span>`;
}

function headlineFixtures(headline) {
  const inScope = new Set(scopeMembers().map(m => m.id));
  let soonest = null, n = 0;
  for (const g of ["men", "women"]) {
    for (const [key, [date]] of S.upcoming[g]) {
      if (date < S.today) continue;
      const [lo, hi] = key.split(",").map(Number);
      if (!inScope.has(lo) || !inScope.has(hi)) continue;   // as filtered as the list below
      n++;
      if (!soonest || date < soonest) soonest = date;
    }
  }
  if (!n) {
    headline.innerHTML = `<span class="big">0</span>`
      + `<span class="rest">first-ever meetings are on the calendar`
      + `${esc(isFiltered() ? " for the teams in the current filter" : " right now")}.</span>`;
    return;
  }
  const cd = countdown(soonest);
  headline.innerHTML = `<span class="big">${n}</span>`
    + `<span class="rest">${pl(n, "pairing")} that ${n === 1 ? "has" : "have"} <b>never</b> met `
    + `${n === 1 ? "is" : "are"} scheduled to meet${esc(scopeNote())} — the next one `
    + `<b>${esc(cd.text)}</b>.</span>`;
}

function headlineOneOffs(headline) {
  if (!present() && !countsExact()) {                 // years file still on its way
    headline.innerHTML = `<span class="big">…</span>`
      + `<span class="rest">counting meetings as of ${S.year}.</span>`;
    return;
  }
  const rows = oneOffPairs();
  const oldest = rows.length ? rows[0].year : null;
  headline.innerHTML = `<span class="big">${num(rows.length)}</span>`
    + `<span class="rest"><b>${esc(archiveLabel())}</b> ${pl(rows.length, "pairing")} had played `
    + `<b>exactly once</b>${present() ? "" : ` by ${S.year}`}${esc(scopeNote())}`
    + `${oldest ? ` — the oldest still-unrepeated fixture was in <b>${oldest}</b>` : ""}.</span>`;
}

function headlineMisses(headline) {
  headline.innerHTML = `<span class="big">?</span>`
    + `<span class="rest">Pairs that have <b>never</b> met, ranked by how many opponents they `
    + `already share.</span>`;
  const host = $("view-misses");
  const first = host && host.querySelector(".lv-row .lv-when");
  if (first) {
    headline.innerHTML = `<span class="big">${esc(first.textContent)}</span>`
      + `<span class="rest">opponents in common — and still no meeting between them. `
      + `The ${esc(archiveLabel())} fixtures that keep not happening`
      + `${esc(asOfNote())}${esc(scopeNote())}.</span>`;
  } else {
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">No near misses in the current filter.</span>`;
  }
}

function headlinePath(headline) {
  const g = graph();
  const path = (S.path.a != null && S.path.b != null)
    ? shortestPath(g, S.path.a, S.path.b) : null;
  const A = S.byId.get(S.path.a), B = S.byId.get(S.path.b);
  if (!A || !B || A.id === B.id) {
    headline.innerHTML = `<span class="big">—</span>`
      + `<span class="rest">Pick two teams to connect through matches actually played.</span>`;
    return;
  }
  if (!path || path.length < 2) {
    // Two teams are chosen; there is simply no chain between them under the current
    // filter and year (a team that had not debuted yet has no edges at all).
    headline.innerHTML = `<span class="big">∞</span>`
      + `<span class="rest">no chain of matches connects <b>${esc(A.name)}</b> and `
      + `<b>${esc(B.name)}</b> in the ${esc(archiveLabel())} record`
      + `${esc(asOfNote())}${esc(scopeNote())}.</span>`;
    return;
  }
  const d = path.length - 1;
  headline.classList.add("allplayed");
  headline.innerHTML = `<span class="big">${d}</span>`
    + `<span class="rest">${pl(d, "degree")} of separation between <b>${esc(A.name)}</b> and `
    + `<b>${esc(B.name)}</b> in the ${esc(archiveLabel())} record`
    + `${esc(asOfNote())}${esc(scopeNote())}.</span>`;
}

/* ---------- views ---------- */
function defaultView() {
  // Phones used to land on the fixtures feed, on the theory that a 211-column matrix is
  // something you zoom into rather than arrive at. But the grid is what the share card
  // shows and what the link promises, and it does fit a phone: the labels shrink with the
  // cells and Fit fills the width. Landing anywhere else hid the whole point from the
  // majority of visitors, who arrive on a phone.
  return "grid";
}

function applyView(view, { push = true, focus = true } = {}) {
  if (!VIEWS.includes(view)) view = "grid";
  S.view = view;
  for (const v of VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== view;
  }
  document.querySelectorAll("#views button").forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  document.body.dataset.view = view;
  syncFactStrip();
  /* The fixtures feed deliberately lists both games in labelled groups, so the dataset
     toggle has nothing to change there. It used to sit enabled and do nothing, which reads
     as a broken control and teaches people to distrust the others. Disable it and say why —
     the same treatment the never/upcoming toggles already get in combined mode. */
  const genderMeaningless = view === "fixtures";
  document.querySelectorAll("#gender button").forEach(b => {
    b.disabled = genderMeaningless;
    b.title = genderMeaningless
      ? "The fixtures feed covers both games; switch to another view to pick one"
      : "";
  });
  const genderNote = $("gender-note");
  if (genderNote) genderNote.hidden = !genderMeaningless;
  // Timeline, legend and the grid-only toggles belong to the grid.
  const gridOnly = view === "grid";
  const timeline = $("timeline");
  if (timeline) timeline.hidden = !gridOnly;
  const legend = $("legend");
  if (legend) legend.hidden = !gridOnly;
  for (const id of ["opt-highlight", "opt-upcoming"]) {
    const el = $(id);
    if (el) el.hidden = !gridOnly;
  }
  if (view === "fixtures") renderFixtures();
  if (view === "oneoffs") renderOneOffs();
  if (view === "misses") renderMisses();
  if (view === "path") renderPath();
  if (gridOnly) { resize(); clampPan(); draw(); }
  updateHeadline();
  if (focus) {
    const tab = document.querySelector(`#views button[data-view="${view}"]`);
    if (tab) tab.focus();
  }
  if (push) writeUrl();
}

/* ---------- URL state ----------
   Every choice on the page is in the query string, so a view can be linked, bookmarked and
   screenshotted with its caption intact. replaceState, not pushState: scrubbing a year
   should not bury the back button under two hundred history entries. */
let _urlTimer = null;
function writeUrl() {
  clearTimeout(_urlTimer);
  _urlTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (S.view !== "grid") p.set("view", S.view);
    if (S.gender !== "men") p.set("g", S.gender);
    if (S.sort !== "confed") p.set("sort", S.sort);
    if (S.showConfeds.size < S.confedOrder.length) {
      p.set("confed", [...S.showConfeds].join(",") || "none");
    }
    if (S.manual.size) p.set("teams", [...S.manual].join(","));
    if (!present()) p.set("year", String(S.year));
    if (!S.highlightNever) p.set("never", "0");
    if (S.showUpcoming) p.set("up", "1");
    if (S.includeDefunct) p.set("defunct", "1");
    if (S.view === "path" && S.path.a != null && S.path.b != null) {
      p.set("path", `${S.path.a},${S.path.b}`);
    }
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }, 200);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  const ids = key => (p.get(key) || "").split(",").map(Number).filter(Number.isFinite);

  const g = p.get("g");
  if (g === "men" || g === "women" || g === "both") S.gender = g;
  const sort = p.get("sort");
  if (["confed", "rank", "matches", "alpha"].includes(sort)) S.sort = sort;
  if (p.has("confed")) {
    const raw = p.get("confed");
    S.showConfeds = new Set(raw === "none" ? []
      : raw.split(",").filter(c => S.confedOrder.includes(c)));
  }
  if (p.has("teams")) S.manual = new Set(ids("teams").filter(id => S.byId.has(id)));
  S.includeDefunct = p.get("defunct") === "1";
  S.highlightNever = p.get("never") !== "0";
  S.showUpcoming = p.get("up") === "1";
  const year = Number(p.get("year"));
  if (Number.isFinite(year) && year >= YEAR_MIN && year <= S.maxYear) S.year = year;
  if (p.has("path")) {
    const [a, b] = ids("path");
    if (S.byId.has(a)) S.path.a = a;
    if (S.byId.has(b)) S.path.b = b;
  }
  S.view = VIEWS.includes(p.get("view")) ? p.get("view") : defaultView();
  // ?pair=lo,hi deep-links straight to a head-to-head (the feed's links use it).
  const pair = ids("pair");
  if (pair.length === 2 && S.byId.has(pair[0]) && S.byId.has(pair[1])) {
    setTimeout(() => openPair(pair[0], pair[1]), 0);
  }
}

/* ---------- timeline ---------- */
function setYearLabel() {
  const text = present() ? `present (${S.maxYear})` : `${S.year}`;
  const el = $("year-label");
  if (el) el.textContent = text;
  // The phone header is the only thing visible while the scrubber is collapsed, so it has
  // to say which year the grid is showing.
  const sum = $("year-summary");
  if (sum) sum.textContent = present() ? "present" : `showing ${S.year}`;
  const tl = $("timeline");
  if (tl) tl.classList.toggle("scrubbed", !present());
}
function setYear(y, { redraw = true } = {}) {
  S.year = Math.max(YEAR_MIN, Math.min(S.maxYear, y));
  const scrub = $("year-scrub");
  if (scrub && +scrub.value !== S.year) scrub.value = String(S.year);
  setYearLabel();
  updateStats();
  if (redraw) draw();
  if (S.view !== "grid" && !S.playing) refreshListView();   // too heavy to redo mid-playback
  writeUrl();
  // Exact per-year counts are only needed by tooltips; fetch them in the background so
  // the grid never waits on a download to move.
  if (!present() && !countsExact()) ensureYearsForView().then(() => { if (S.hover) draw(); });
}

let _playRaf = null, _playLast = 0;
function stopPlay() {
  const wasPlaying = S.playing;
  S.playing = false;
  if (_playRaf) cancelAnimationFrame(_playRaf);
  _playRaf = null;
  if (wasPlaying && S.view !== "grid") refreshListView();
  const btn = $("year-play");
  if (btn) { btn.innerHTML = "&#9654;"; btn.setAttribute("aria-label", "Play the timeline"); }
}
function togglePlay() {
  if (S.playing) return stopPlay();
  S.playing = true;
  const btn = $("year-play");
  if (btn) { btn.innerHTML = "&#10073;&#10073;"; btn.setAttribute("aria-label", "Pause the timeline"); }
  if (present()) setYear(YEAR_MIN, { redraw: false });
  _playLast = 0;
  const step = ts => {
    if (!S.playing) return;
    if (!_playLast) _playLast = ts;
    // ~14 years a second: slow enough to watch a confederation appear, quick enough that
    // 150 years takes about ten seconds.
    const years = Math.floor((ts - _playLast) / 70);
    if (years) {
      _playLast = ts;
      const next = S.year + years;
      if (next >= S.maxYear) { setYear(S.maxYear); return stopPlay(); }
      setYear(next);
    }
    _playRaf = requestAnimationFrame(step);
  };
  _playRaf = requestAnimationFrame(step);
}

/* On mobile the controls sit below the grid, so move the timeline scrubber up into the stage
   (right under the headline, above the grid) so you can scrub and see the grid change at once. */
let _timelineHome = null;
function placeTimeline() {
  const timeline = $("timeline");
  if (!timeline) return;
  if (!_timelineHome) _timelineHome = { parent: timeline.parentNode, next: timeline.nextSibling };
  if (mqMobile.matches) $("timeline-slot").appendChild(timeline);
  else _timelineHome.parent.insertBefore(timeline, _timelineHome.next);
  // Collapsed by default on a phone, so the grid starts above the fold. A link that
  // arrives already scrubbed opens it, because hiding a control that is filtering what
  // you are looking at is worse than the space it costs.
  setTimelineOpen(mqMobile.matches ? !present() : true);
}

function setTimelineOpen(open) {
  const timeline = $("timeline"), btn = $("timeline-toggle");
  if (!timeline || !btn) return;
  timeline.classList.toggle("collapsed", !open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

/* MOCKUP: on a wide screen the headline, fact strip and view tabs move into the rail, so
   nothing sits above the grid and the square is bound by the window height rather than by
   whatever chrome happens to be stacked on top of it. Same reparenting trick as the
   timeline, so the markup stays one tree and mobile is unaffected. */
let _chromeHome = null;
function placeChrome() {
  const stage = $("stage"), panel = $("panel"), body = $("panel-body");
  if (!stage || !panel || !body) return;
  const parts = ["headline", "factstrip", "stage-bar"].map($).filter(Boolean);
  if (!_chromeHome) _chromeHome = parts.map(el => ({ el, next: el.nextSibling }));
  if (mqRail.matches) {
    for (const el of parts) panel.insertBefore(el, body);
  } else {
    for (const { el, next } of _chromeHome) stage.insertBefore(el, next);
  }
}

/* ---------- controls ---------- */
// A roving-tabindex tab strip: one stop in the tab order, arrow keys between the options.
function wireTabs(container, onPick) {
  const buttons = [...container.querySelectorAll("button")];
  buttons.forEach((btn, i) => {
    btn.addEventListener("click", () => onPick(btn));
    btn.addEventListener("keydown", e => {
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = buttons[(i + delta + buttons.length) % buttons.length];
      next.focus();
      onPick(next);
    });
  });
}

function setGender(gender) {
  S.gender = gender;
  document.querySelectorAll("#gender button").forEach(b => {
    const on = b.dataset.gender === gender;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  /* The never/upcoming highlights used to be greyed out in combined view: they are
     single-dataset ideas and the overlay had no single dataset to apply them to. Each half
     of the split square has one, so they mean something again in all three. */
  buildTeamList();           // refresh the rank shown per gender
  updateUpcomingCount();
  updateLegend();
  if (S.view !== "grid") applyView(S.view, { push: false, focus: false });
  recompute(false);
}

function buildControls() {
  wireTabs($("gender"), btn => foldGender(btn.dataset.gender));
  wireTabs($("views"), btn => applyView(btn.dataset.view));
  setGender(S.gender);

  const sortSel = $("sort");
  sortSel.value = S.sort;
  sortSel.addEventListener("change", e => { S.sort = e.target.value; recompute(true); });

  // confederation checkboxes
  const counts = {};
  for (const m of S.members) counts[m.confed] = (counts[m.confed] || 0) + 1;
  const cl = $("confed-list");
  cl.innerHTML = "";
  for (const cf of S.confedOrder) {
    const lab = document.createElement("label");
    lab.innerHTML = `<span class="dot" style="background:${esc(confedColor(cf))}"></span>
      <input type="checkbox" ${S.showConfeds.has(cf) ? "checked" : ""} data-confed="${esc(cf)}"> ${esc(cf)}
      <span class="cnt">${counts[cf] || 0}</span>`;
    cl.appendChild(lab);
  }
  cl.addEventListener("change", e => {
    const cb = e.target.closest("input"); if (!cb) return;
    if (cb.checked) S.showConfeds.add(cb.dataset.confed);
    else S.showConfeds.delete(cb.dataset.confed);
    recompute(true);
  });
  $("confed-all").onclick = () => toggleConfeds(true);
  $("confed-none").onclick = () => toggleConfeds(false);

  // stage toolbar toggles
  const toggle = (id, get, set, titles) => {
    const el = $(id);
    const sync = () => {
      el.setAttribute("aria-pressed", get() ? "true" : "false");
      el.classList.toggle("on", get());
      // The never-played highlight now ships on, so a fixed title would describe the
      // wrong half of the control for most visitors. Say what the click will do.
      if (titles) el.title = get() ? titles.off : titles.on;
    };
    sync();
    el.onclick = () => {
      set(!get());
      sync();
      draw();
      writeUrl();
    };
  };
  toggle("opt-highlight", () => S.highlightNever,
    v => { S.highlightNever = v; updateLegend(); }, {
      on: "Flood the never-played pairings with red",
      off: "Drop the red and colour by how often each pair has met",
    });
  toggle("opt-upcoming", () => S.showUpcoming, v => { S.showUpcoming = v; });

  $("opt-defunct").checked = S.includeDefunct;
  $("opt-defunct").onchange = e => {
    S.includeDefunct = e.target.checked;
    buildTeamList();
    recompute(true);
  };
  updateUpcomingCount();

  // theme
  $("theme").onclick = () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
    updateLegend();
    draw();
  };

  // share
  const shareBtn = $("share");
  shareBtn.onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share && mqMobile.matches) {
        await navigator.share({ title: document.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      const was = shareBtn.textContent;
      shareBtn.textContent = "Copied";
      announce("Link copied to the clipboard.");
      setTimeout(() => { shareBtn.textContent = was; }, 1600);
    } catch {
      // Clipboard denied (or share dismissed): the URL bar already holds the same link.
      announce("Copy the address bar to share this view.");
    }
  };

  const tlToggle = $("timeline-toggle");
  if (tlToggle) {
    tlToggle.onclick = () => {
      const open = tlToggle.getAttribute("aria-expanded") === "true";
      setTimelineOpen(!open);
      if (open) stopPlay();            // collapsing mid-playback would hide a moving grid
    };
  }

  // timeline scrubber
  const scrub = $("year-scrub");
  scrub.min = YEAR_MIN; scrub.max = S.maxYear;
  scrub.value = String(present() ? S.maxYear : S.year);
  setYearLabel();
  scrub.addEventListener("input", e => { stopPlay(); setYear(+e.target.value); });
  const play = $("year-play");
  play.onclick = togglePlay;
  if (mqReduceMotion.matches) play.title = "Play the timeline (motion is reduced in your settings)";

  // manual team list
  $("manual-clear").onclick = () => {
    S.manual.clear();
    document.querySelectorAll("#team-list input").forEach(i => { i.checked = false; });
    recompute(true);
  };
  $("team-search").addEventListener("input", buildTeamList);
  buildTeamList();

  // zoom controls (viewpane)
  $("zoom-in").onclick = () => zoomBy(1.4);
  $("zoom-out").onclick = () => zoomBy(1 / 1.4);
  $("zoom-fit").onclick = () => { fitView(); draw(); };

  // meta / provenance
  const dt = S.meta.dataThrough || {};
  const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "?";
  $("meta").innerHTML =
    `${S.members.length} current FIFA members · matches through <b>${esc(fmt(dt.men))}</b> (men) / `
    + `<b>${esc(fmt(dt.women))}</b> (women) · rankings ${esc(S.meta.rankingMen || "—")}, `
    + `${esc(S.meta.rankingWomen || "—")}.`;

  placeTimeline();
  placeChrome();
  mqMobile.addEventListener("change", () => {
    placeTimeline(); placeChrome(); resize(); clampPan(); draw();
  });
  mqRail.addEventListener("change", () => {
    placeChrome(); resize(); clampPan(); draw();
  });
}

function toggleConfeds(on) {
  S.showConfeds = on ? new Set(S.confedOrder) : new Set();
  document.querySelectorAll("#confed-list input").forEach(i => { i.checked = on; });
  recompute(true);
}

function buildTeamList() {
  const q = $("team-search").value.trim().toLowerCase();
  const list = $("team-list");
  let pool = S.members.slice();
  if (S.includeDefunct) pool = pool.concat(S.defunct.members);
  pool.sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = "";
  for (const m of pool) {
    if (q && !m.name.toLowerCase().includes(q)) continue;
    const lab = document.createElement("label");
    const r = isCombined() ? rankOf(m) : (S.gender === "men" ? m.mens_rank : m.womens_rank);
    const rk = (r && r !== Infinity) ? `#${r}` : (m.defunct ? "defunct" : "unranked");
    lab.innerHTML = `<input type="checkbox" data-id="${m.id}" ${S.manual.has(m.id) ? "checked" : ""}>
      ${esc(teamLabel(m))} <span class="rk">${esc(m.confed)} ${esc(rk)}</span>`;
    list.appendChild(lab);
  }
  list.onchange = e => {
    const cb = e.target.closest("input"); if (!cb) return;
    const id = +cb.dataset.id;
    if (cb.checked) S.manual.add(id); else S.manual.delete(id);
    if (S.view !== "grid") applyView("grid", { focus: false });
    recompute(true);
  };
}

function updateUpcomingCount() {
  const el = $("upcoming-count");
  if (!el) return;
  // Both halves of the split square can carry a highlight, so count across both archives.
  const n = activeArchives().reduce((t, g) =>
    t + [...S.upcoming[g].values()].filter(([d]) => d >= S.today).length, 0);
  el.textContent = n ? `${n}` : "";
  const pip = $("views-fixtures-pip");
  if (pip) {
    const all = ["men", "women"].reduce((t, g) =>
      t + [...S.upcoming[g].values()].filter(([d]) => d >= S.today).length, 0);
    pip.textContent = all ? String(all) : "";
    pip.hidden = !all;
  }
}

/* ---------- boot ---------- */
applyTheme(preferredTheme(), false);
window.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeDetail(); closePeek(); }
});
window.addEventListener("resize", () => { resize(); clampPan(); draw(); });
window.addEventListener("popstate", () => {
  readUrl();
  setGender(S.gender);
  applyView(S.view, { push: false, focus: false });
  recompute(true);
});
resize();
setupInteraction();
load().catch(err => {
  const el = $("loading");
  if (el) el.textContent = "Failed to load data: " + err.message;
  console.error(err);
});
// Separate from load(): the grid must not wait on the fact strip, and a missing or
// malformed facts.json should cost the page nothing.
loadFacts();
