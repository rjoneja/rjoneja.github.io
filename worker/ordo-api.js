// Ordo scores API: a Cloudflare Worker with one D1 database bound as DB.
// Endpoints (all JSON, open CORS):
//   POST /api/play   {day, pid}              count a player for today's puzzle
//   POST /api/score  {day, pid, score}       record a finished daily (first result per player per day only)
//   POST /api/name   {day, pid, name}        put a name on that result
//   GET  /api/board?day=N&pid=X              players today and ever, top 5 today and all time
//   POST /api/cd     {day, pid, score}       a Countdown run (keeps each player's best per day)
//   POST /api/cdname {day, pid, name}        put a name on that player's Countdown scores
//   GET  /api/cdboard?day=N&pid=X            Countdown top 5 today and all time (one entry per player)
//   POST /api/ev     {vid, sid, pg, t, v, n, src}  an anonymous usage event (visits, runs, shares, time on site)
//   GET  /stats?key=STATS_KEY                 private usage dashboard; GET /api/stats?key=…&days=N is its data
// pid is a random ID the game makes on each device. It is never sent back out.
// STATS_KEY is a secret set in the Worker's settings (Variables and Secrets). Without it the dashboard stays shut.

const DAILY_START = Date.UTC(2026, 9, 21);
const MAX_SCORE = 400;
const MAX_CD = 1000;
const BLOCK = /(fuck|shit|cunt|bitch|nigg|fag|wank|twat|dick|cock|pussy|rape|nazi|hitler|slut|whore|retard|paki|spastic)/i;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS scores (day INTEGER NOT NULL, pid TEXT NOT NULL, score INTEGER NOT NULL, name TEXT, ts INTEGER NOT NULL, PRIMARY KEY (day, pid))',
  'CREATE INDEX IF NOT EXISTS scores_by_day ON scores (day, score DESC, ts)',
  'CREATE INDEX IF NOT EXISTS scores_by_score ON scores (score DESC, ts)',
  'CREATE TABLE IF NOT EXISTS plays (day INTEGER NOT NULL, pid TEXT NOT NULL, PRIMARY KEY (day, pid))',
  'CREATE INDEX IF NOT EXISTS plays_by_pid ON plays (pid)',
  'CREATE TABLE IF NOT EXISTS cd (day INTEGER NOT NULL, pid TEXT NOT NULL, best INTEGER NOT NULL, name TEXT, ts INTEGER NOT NULL, PRIMARY KEY (day, pid))',
  'CREATE INDEX IF NOT EXISTS cd_by_day ON cd (day, best DESC, ts)',
  'CREATE INDEX IF NOT EXISTS cd_by_best ON cd (best DESC, ts)',
  // Usage events. d is the London date. No IP addresses or names are stored.
  'CREATE TABLE IF NOT EXISTS ev (ts INTEGER NOT NULL, d TEXT NOT NULL, vid TEXT NOT NULL, sid TEXT NOT NULL, pg TEXT, t TEXT NOT NULL, v TEXT, n INTEGER, src TEXT, cc TEXT, dev TEXT)',
  'CREATE INDEX IF NOT EXISTS ev_by_day ON ev (d, t)',
  'CREATE INDEX IF NOT EXISTS ev_by_ts ON ev (ts)'
];
const EV_TYPES = new Set(['visit', 'time', 'run_start', 'run_end', 'practice', 'practice_end', 'share', 'board', 'kids_start', 'kids_end']);
const okId = x => typeof x === 'string' && /^[a-z0-9]{8,20}$/.test(x);
const short = (x, n) => typeof x === 'string' ? x.replace(/[^\w.:-]/g, '').slice(0, n) : '';
const LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const londonDay = ms => LONDON.format(new Date(ms));
const sameKey = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

async function stats(db, days) {
  const now = Date.now(), from = londonDay(now - (days - 1) * 864e5), week = londonDay(now - 6 * 864e5);
  const [byType, visitors, fresh, sources, countries, devices, scores, live, totals, arrivals, period] = await db.batch([
    db.prepare('SELECT d, t, v, COUNT(*) AS c, COUNT(DISTINCT vid) AS u, SUM(n) AS s FROM ev WHERE d >= ?1 GROUP BY d, t, v').bind(from),
    db.prepare("SELECT d, COUNT(DISTINCT vid) AS u FROM ev WHERE d >= ?1 AND t = 'visit' GROUP BY d").bind(from),
    db.prepare("SELECT f AS d, COUNT(*) AS c FROM (SELECT vid, MIN(d) AS f FROM ev WHERE t = 'visit' GROUP BY vid) WHERE f >= ?1 GROUP BY f").bind(from),
    db.prepare("SELECT src, COUNT(*) AS c FROM ev WHERE d >= ?1 AND t = 'visit' GROUP BY src ORDER BY c DESC LIMIT 12").bind(week),
    db.prepare("SELECT cc, COUNT(DISTINCT vid) AS c FROM ev WHERE d >= ?1 AND t = 'visit' GROUP BY cc ORDER BY c DESC LIMIT 10").bind(week),
    db.prepare("SELECT dev, COUNT(DISTINCT vid) AS c FROM ev WHERE d >= ?1 AND t = 'visit' GROUP BY dev").bind(week),
    db.prepare("SELECT d, n, COUNT(*) AS c FROM ev WHERE d >= ?1 AND t = 'run_end' GROUP BY d, n").bind(week),
    db.prepare('SELECT COUNT(DISTINCT vid) AS u FROM ev WHERE ts > ?1').bind(now - 5 * 60e3),
    db.prepare("SELECT COUNT(DISTINCT vid) AS u, MIN(d) AS first FROM ev WHERE t = 'visit'"),
    db.prepare("SELECT d, src, COUNT(*) AS c FROM ev WHERE d >= ?1 AND t = 'visit' AND src IN ('wa', 'cp') GROUP BY d, src").bind(from),
    db.prepare("SELECT COUNT(DISTINCT vid) AS u FROM ev WHERE d >= ?1 AND t = 'visit'").bind(from)
  ]);
  return { now, today: londonDay(now), from, days, rows: byType.results, visitors: visitors.results, fresh: fresh.results,
    sources: sources.results, countries: countries.results, devices: devices.results, scores: scores.results,
    arrivals: arrivals.results, periodVisitors: period.results[0].u, live: live.results[0].u, everVisitors: totals.results[0].u, first: totals.results[0].first };
}
let ready = null;
const setup = db => ready || (ready = db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
const bad = msg => json({ error: msg }, 400);

const todayNo = () => Math.floor((Date.now() - DAILY_START) / 864e5) + 1;
// Puzzle numbers follow the player's local date, so allow a day either side of UTC.
const okDay = d => Number.isInteger(d) && d >= 1 && Math.abs(d - todayNo()) <= 1;
const okPid = p => typeof p === 'string' && /^[a-z0-9]{12,40}$/.test(p);
function cleanName(raw) {
  const n = String(raw || '').normalize('NFKC').replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N} .'_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!n) return null;
  const plain = n.toLowerCase().replace(/[013457@$]/g, c => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' })[c]).replace(/[^a-z]/g, '');
  return BLOCK.test(plain) ? 'Player' : n;
}

async function board(db, day, pid) {
  const [today, ever, playersToday, playersEver] = await db.batch([
    db.prepare('SELECT score, name, pid = ?2 AS me FROM scores WHERE day = ?1 ORDER BY score DESC, ts LIMIT 5').bind(day, pid || ''),
    db.prepare('SELECT score, name, day, pid = ?1 AS me FROM scores ORDER BY score DESC, ts LIMIT 5').bind(pid || ''),
    db.prepare('SELECT COUNT(*) AS n FROM plays WHERE day = ?1').bind(day),
    db.prepare('SELECT COUNT(DISTINCT pid) AS n FROM plays')
  ]);
  const tidy = r => ({ score: r.score, name: r.name || 'Player', day: r.day, me: !!r.me });
  return { day, players: playersToday.results[0].n, playersEver: playersEver.results[0].n, today: today.results.map(tidy), all: ever.results.map(tidy) };
}
async function cdBoard(db, day, pid) {
  const [today, ever, nToday] = await db.batch([
    db.prepare('SELECT best, name, pid = ?2 AS me FROM cd WHERE day = ?1 ORDER BY best DESC, ts LIMIT 5').bind(day, pid || ''),
    // All time: each player's single best run.
    db.prepare('SELECT c.best AS best, c.name AS name, c.day AS day, c.pid = ?1 AS me FROM cd c WHERE NOT EXISTS (SELECT 1 FROM cd d WHERE d.pid = c.pid AND (d.best > c.best OR (d.best = c.best AND d.ts < c.ts))) ORDER BY c.best DESC, c.ts LIMIT 5').bind(pid || ''),
    db.prepare('SELECT COUNT(*) AS n FROM cd WHERE day = ?1').bind(day)
  ]);
  const tidy = r => ({ score: r.best, name: r.name || 'Player', day: r.day, me: !!r.me });
  return { day, players: nToday.results[0].n, today: today.results.map(tidy), all: ever.results.map(tidy) };
}
async function cdRanks(db, day, best, ts, pid) {
  const [d, a] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM cd WHERE day = ?1 AND (best > ?2 OR (best = ?2 AND ts < ?3))').bind(day, best, ts),
    db.prepare('SELECT COUNT(DISTINCT pid) AS n FROM cd WHERE pid != ?3 AND (best > ?1 OR (best = ?1 AND ts < ?2))').bind(best, ts, pid)
  ]);
  return { rankDay: d.results[0].n + 1, rankAll: a.results[0].n + 1 };
}
async function ranks(db, day, score, ts) {
  // Rank = 1 + results that beat this one (higher score, or same score set earlier).
  const [d, a] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM scores WHERE day = ?1 AND (score > ?2 OR (score = ?2 AND ts < ?3))').bind(day, score, ts),
    db.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?1 OR (score = ?1 AND ts < ?2)').bind(score, ts)
  ]);
  return { rankDay: d.results[0].n + 1, rankAll: a.results[0].n + 1 };
}

const DASHBOARD = "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n<title>Ordo stats<\/title>\n<style>\n:root {\n  color-scheme: light;\n  --bg: #f6f6f3; --surface: #fcfcfb; --edge: #e4e3dd; --grid: #ecebe6;\n  --text: #0b0b0b; --text-2: #52514e; --muted: #7a7973;\n  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;\n  --bar: #86b6ef; --accent: #b414b4;\n}\n@media (prefers-color-scheme: dark) {\n  :root:where(:not([data-theme=\"light\"])) {\n    color-scheme: dark;\n    --bg: #121211; --surface: #1a1a19; --edge: #2c2c2a; --grid: #262624;\n    --text: #f0efec; --text-2: #c3c2b7; --muted: #8f8e86;\n    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --bar: #1c5cab; --accent: #e070e0;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --bg: #121211; --surface: #1a1a19; --edge: #2c2c2a; --grid: #262624;\n  --text: #f0efec; --text-2: #c3c2b7; --muted: #8f8e86;\n  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --bar: #1c5cab; --accent: #e070e0;\n}\n* { box-sizing: border-box; }\nbody { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif; }\nmain { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }\nheader { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 16px; }\nh1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }\n.live { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }\n.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--s3); display: inline-block; }\n.spacer { flex: 1; }\n.seg { display: inline-flex; border: 1px solid var(--edge); border-radius: 8px; overflow: hidden; background: var(--surface); }\n.seg button { appearance: none; border: 0; background: none; color: var(--text-2); font: inherit; font-size: 13px; padding: 6px 12px; cursor: pointer; }\n.seg button + button { border-left: 1px solid var(--edge); }\n.seg button[aria-pressed=\"true\"] { background: var(--text); color: var(--surface); }\n.updated { font-size: 12px; color: var(--muted); }\n.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }\n.tile { background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 12px 14px; }\n.tile .k { font-size: 12px; color: var(--text-2); }\n.tile .v { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.2; }\n.tile .d { font-size: 12px; color: var(--muted); }\n.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }\n.card { background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 14px 14px 10px; min-width: 0; }\n.card h2 { font-size: 15px; margin: 0; }\n.card .sub { font-size: 12px; color: var(--muted); margin: 2px 0 8px; }\n.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--text-2); margin-bottom: 4px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.legend b { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }\n.legend b.ln { height: 3px; border-radius: 2px; width: 14px; }\n.chart { position: relative; }\n.chart svg { display: block; width: 100%; overflow: visible; }\n.chart svg:focus { outline: none; }\n.chart svg:focus-visible { outline: 2px solid var(--s1); outline-offset: 2px; border-radius: 4px; }\n.ax { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }\n.dl { font-size: 11px; fill: var(--text-2); font-weight: 600; }\n.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--edge); border-radius: 8px; padding: 6px 9px; font-size: 12px;\n  box-shadow: 0 4px 14px rgb(0 0 0 / .12); white-space: nowrap; z-index: 2; color: var(--text); }\n.tip .h { color: var(--text-2); margin-bottom: 2px; }\n.tip .r { display: flex; align-items: center; gap: 6px; }\n.tip .r b { font-variant-numeric: tabular-nums; }\n.tip .r i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }\n.ranks { list-style: none; margin: 4px 0 6px; padding: 0; display: grid; gap: 6px; }\n.ranks li { display: grid; grid-template-columns: minmax(80px, 38%) 1fr 44px; align-items: center; gap: 8px; font-size: 13px; }\n.ranks .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }\n.ranks .tr { height: 12px; }\n.ranks .tr b { display: block; height: 100%; background: var(--bar); border-radius: 0 4px 4px 0; min-width: 2px; }\n.ranks .n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }\n.empty { color: var(--muted); font-size: 13px; padding: 18px 0; text-align: center; }\ndetails { margin-top: 14px; background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 10px 14px; }\nsummary { cursor: pointer; font-weight: 600; }\n.tw { overflow-x: auto; }\ntable { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }\nth, td { padding: 5px 8px; text-align: right; border-bottom: 1px solid var(--grid); white-space: nowrap; }\nth:first-child, td:first-child { text-align: left; }\nth { color: var(--text-2); font-weight: 600; }\n.note { font-size: 12px; color: var(--muted); margin-top: 14px; }\n.err { background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 20px; }\n<\/style>\n<\/head>\n<body>\n<main>\n  <header>\n    <h1>Ordo stats<\/h1>\n    <span class=\"live\" id=\"live\" hidden><i><\/i><span><\/span><\/span>\n    <span class=\"spacer\"><\/span>\n    <div class=\"seg\" role=\"group\" aria-label=\"Date range\">\n      <button type=\"button\" data-days=\"7\" aria-pressed=\"false\">7 days<\/button>\n      <button type=\"button\" data-days=\"30\" aria-pressed=\"true\">30 days<\/button>\n      <button type=\"button\" data-days=\"90\" aria-pressed=\"false\">90 days<\/button>\n    <\/div>\n    <span class=\"updated\" id=\"updated\"><\/span>\n  <\/header>\n  <div id=\"out\"><p class=\"updated\">Loading\u2026<\/p><\/div>\n<\/main>\n<script>\n(function () {\n  'use strict';\n  var key = new URLSearchParams(location.search).get('key') || '';\n  var days = 30;\n  try { days = parseInt(localStorage.getItem('ordoStats.days'), 10) || 30; } catch (e) {}\n  var out = document.getElementById('out');\n  var data = null;\n\n  function h(tag, attrs, kids) {\n    var n = document.createElement(tag);\n    if (attrs) for (var k in attrs) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'cls') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }\n    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });\n    return n;\n  }\n  var NS = 'http://www.w3.org/2000/svg';\n  function s(tag, attrs, text) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; }\n  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };\n  var fmtN = function (x) { return x == null ? '\u2013' : Math.round(x).toLocaleString('en-GB'); };\n  var fmtMin = function (sec) { if (!sec) return '0m'; var m = Math.floor(sec / 60), r = Math.round(sec % 60); return m ? m + 'm ' + r + 's' : r + 's'; };\n  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n  function parseD(d) { var p = d.split('-'); return new Date(Date.UTC(+p[0], p[1] - 1, +p[2])); }\n  function keyD(dt) { return dt.toISOString().slice(0, 10); }\n  function shortD(d) { var t = parseD(d); return t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; }\n  function longD(d) { var t = parseD(d); return DOW[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; }\n\n  // ---------- Turn the raw rows into one record per day ----------\n  function shape(st) {\n    var list = [], idx = {};\n    for (var t = parseD(st.from); keyD(t) <= st.today; t = new Date(t.getTime() + 864e5)) {\n      var d = keyD(t);\n      idx[d] = list.length;\n      list.push({ d: d, visits: 0, visitors: 0, fresh: 0, home: 0, kids: 0, classic: 0, runStart: 0, runEnd: 0, runLeft: 0, scoreSum: 0,\n        practice: 0, kidsGames: 0, shareWa: 0, shareCp: 0, arrivals: 0, timeSum: 0, timeU: 0, boards: 0 });\n    }\n    var at = function (d) { return idx[d] == null ? null : list[idx[d]]; };\n    st.rows.forEach(function (r) {\n      var x = at(r.d); if (!x) return;\n      if (r.t === 'visit') { x.visits += r.c; if (r.v === 'kids') x.kids += r.c; else if (r.v === 'classic') x.classic += r.c; else x.home += r.c; }\n      else if (r.t === 'run_start') x.runStart += r.c;\n      else if (r.t === 'run_end') { x.runEnd += r.c; x.scoreSum += r.s || 0; if (r.v === 'left') x.runLeft += r.c; }\n      else if (r.t === 'practice') x.practice += r.c;\n      else if (r.t === 'kids_start') x.kidsGames += r.c;\n      else if (r.t === 'share') { if (/^wa/.test(r.v)) x.shareWa += r.c; else x.shareCp += r.c; }\n      else if (r.t === 'time') { x.timeSum += r.s || 0; x.timeU += r.u; }\n      else if (r.t === 'board') x.boards += r.c;\n    });\n    // time rows are split by v (always ''), so u per day is already distinct visitors with time.\n    st.visitors.forEach(function (r) { var x = at(r.d); if (x) x.visitors = r.u; });\n    st.fresh.forEach(function (r) { var x = at(r.d); if (x) x.fresh = r.c; });\n    (st.arrivals || []).forEach(function (r) { var x = at(r.d); if (x) x.arrivals += r.c; });\n    list.forEach(function (x) { x.back = Math.max(0, x.visitors - x.fresh); x.avgTime = x.timeU ? x.timeSum / x.timeU : 0; x.avgScore = x.runEnd ? x.scoreSum / x.runEnd : 0; });\n    return list;\n  }\n\n  // ---------- A small SVG chart: bars (optionally stacked) or lines, one y-axis, crosshair tooltip ----------\n  function nice(max) {\n    if (max <= 0) return 4;\n    if (max <= 4 && max > 1) return max <= 2 ? 2 : 4;\n    if (max <= 1) return 1;\n    var p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p;\n    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;\n  }\n  function chart(box, cfg) {\n    // cfg: { labels, long, series: [{name, color, values}], kind: 'bar'|'line', stacked, fmt }\n    var series = cfg.series, n = cfg.labels.length, fmt = cfg.fmt || fmtN;\n    var legend = h('div', { cls: 'legend' });\n    if (series.length > 1) series.forEach(function (sr) { legend.appendChild(h('span', {}, [h('b', { cls: cfg.kind === 'line' ? 'ln' : '', style: 'background:' + css(sr.color) }), sr.name])); });\n    var wrap = h('div', { cls: 'chart' });\n    box.appendChild(legend); box.appendChild(wrap);\n    var total = 0; series.forEach(function (sr) { sr.values.forEach(function (v) { total += v || 0; }); });\n    if (!total) { wrap.appendChild(h('div', { cls: 'empty', text: 'Nothing yet in this period.' })); return; }\n    var W = Math.max(280, wrap.clientWidth || 320), H = 190;\n    var direct = cfg.kind === 'line' && series.length > 1 && series.length <= 4;\n    var L = 34, R = direct ? 74 : 10, T = 10, B = 24, pw = W - L - R, ph = H - T - B;\n    var max = 0;\n    for (var i = 0; i < n; i++) {\n      if (cfg.stacked) { var sum = 0; series.forEach(function (sr) { sum += sr.values[i] || 0; }); max = Math.max(max, sum); }\n      else series.forEach(function (sr) { max = Math.max(max, sr.values[i] || 0); });\n    }\n    var top = nice(max), y = function (v) { return T + ph - (v / top) * ph; };\n    var band = pw / n, xc = function (i) { return L + band * (i + 0.5); };\n    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', tabindex: '0', 'aria-label': cfg.aria || '' });\n    [0, top / 2, top].forEach(function (v) {\n      svg.appendChild(s('line', { x1: L, x2: L + pw, y1: y(v), y2: y(v), stroke: css('--grid'), 'stroke-width': 1 }));\n      svg.appendChild(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'ax' }, cfg.axisFmt ? cfg.axisFmt(v) : (v % 1 ? v.toFixed(1) : fmtN(v))));\n    });\n    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));\n    for (var j = n - 1; j >= 0; j -= every) svg.appendChild(s('text', { x: xc(j), y: H - 6, 'text-anchor': 'middle', class: 'ax' }, cfg.labels[j]));\n    if (cfg.kind === 'bar') {\n      var bw = Math.max(2, Math.min(28, band * 0.72));\n      for (var b = 0; b < n; b++) {\n        var base = 0, segs = [];\n        series.forEach(function (sr) { var v = sr.values[b] || 0; if (v > 0) segs.push({ v: v, c: css(sr.color), from: base }); base += v; });\n        segs.forEach(function (sg, k) {\n          var y0 = y(sg.from), y1 = y(sg.from + sg.v), x0 = xc(b) - bw / 2;\n          if (k > 0) y0 -= 2; // surface gap between stacked segments\n          var hgt = Math.max(1, y0 - y1), last = k === segs.length - 1, r = last ? Math.min(4, bw / 2, hgt) : 0;\n          var d = 'M' + x0 + ',' + y0 + 'V' + (y1 + r) + (r ? 'Q' + x0 + ',' + y1 + ' ' + (x0 + r) + ',' + y1 : '') + 'H' + (x0 + bw - r) +\n            (r ? 'Q' + (x0 + bw) + ',' + y1 + ' ' + (x0 + bw) + ',' + (y1 + r) : '') + 'V' + y0 + 'Z';\n          svg.appendChild(s('path', { d: d, fill: sg.c }));\n        });\n      }\n    } else {\n      var ends = [];\n      series.forEach(function (sr) {\n        var pts = sr.values.map(function (v, i) { return xc(i).toFixed(1) + ',' + y(v || 0).toFixed(1); });\n        svg.appendChild(s('polyline', { points: pts.join(' '), fill: 'none', stroke: css(sr.color), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));\n        if (n === 1) svg.appendChild(s('circle', { cx: xc(0), cy: y(sr.values[0] || 0), r: 4, fill: css(sr.color) }));\n        ends.push({ y: y(sr.values[n - 1] || 0), name: sr.name });\n      });\n      if (direct) {\n        ends.sort(function (a, b) { return a.y - b.y; });\n        for (var e = 1; e < ends.length; e++) if (ends[e].y - ends[e - 1].y < 13) ends[e].y = ends[e - 1].y + 13;\n        ends.forEach(function (en) { svg.appendChild(s('text', { x: L + pw + 6, y: en.y + 4, class: 'dl' }, en.name)); });\n      }\n    }\n    // Hover layer: hairline + tooltip with every series at that day.\n    var hair = s('line', { y1: T, y2: T + ph, stroke: css('--muted'), 'stroke-width': 1, opacity: 0 });\n    svg.appendChild(hair);\n    var dots = series.map(function (sr) { var c = s('circle', { r: 4, fill: css(sr.color), stroke: css('--surface'), 'stroke-width': 2, opacity: 0 }); svg.appendChild(c); return c; });\n    var tip = h('div', { cls: 'tip', hidden: '' });\n    wrap.appendChild(svg); wrap.appendChild(tip);\n    var cur = -1;\n    function show(i) {\n      if (i < 0 || i >= n) return hide();\n      cur = i;\n      var scale = wrap.clientWidth / W;\n      hair.setAttribute('x1', xc(i)); hair.setAttribute('x2', xc(i)); hair.setAttribute('opacity', cfg.kind === 'line' ? 0.6 : 0);\n      if (cfg.kind === 'line') series.forEach(function (sr, k) { dots[k].setAttribute('cx', xc(i)); dots[k].setAttribute('cy', y(sr.values[i] || 0)); dots[k].setAttribute('opacity', 1); });\n      tip.textContent = '';\n      tip.appendChild(h('div', { cls: 'h', text: cfg.long[i] }));\n      var rows = series.slice();\n      if (cfg.stacked) rows = rows.slice().reverse();\n      rows.forEach(function (sr) { tip.appendChild(h('div', { cls: 'r' }, [h('i', { style: 'background:' + css(sr.color) }), h('b', { text: fmt(sr.values[i] || 0) }), ' ' + sr.name])); });\n      if (cfg.extra) cfg.extra(i).forEach(function (line) { tip.appendChild(h('div', { cls: 'r', text: line })); });\n      tip.hidden = false;\n      var tx = xc(i) * scale + 12, tw = tip.offsetWidth;\n      if (tx + tw > wrap.clientWidth) tx = xc(i) * scale - tw - 12;\n      tip.style.left = Math.max(0, tx) + 'px'; tip.style.top = '4px';\n    }\n    function hide() { cur = -1; tip.hidden = true; hair.setAttribute('opacity', 0); dots.forEach(function (d) { d.setAttribute('opacity', 0); }); }\n    svg.addEventListener('pointermove', function (ev) {\n      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W;\n      show(Math.max(0, Math.min(n - 1, Math.floor((x - L) / band))));\n    });\n    svg.addEventListener('pointerleave', hide);\n    svg.addEventListener('focus', function () { show(n - 1); });\n    svg.addEventListener('blur', hide);\n    svg.addEventListener('keydown', function (ev) {\n      if (ev.key === 'ArrowLeft') { show(Math.max(0, (cur < 0 ? n : cur) - 1)); ev.preventDefault(); }\n      if (ev.key === 'ArrowRight') { show(Math.min(n - 1, cur + 1)); ev.preventDefault(); }\n    });\n  }\n\n  function ranks(box, items, fmt) {\n    if (!items.length) { box.appendChild(h('div', { cls: 'empty', text: 'Nothing yet.' })); return; }\n    var max = Math.max.apply(null, items.map(function (x) { return x.c; })) || 1;\n    var ul = h('ul', { cls: 'ranks' });\n    items.forEach(function (x) {\n      ul.appendChild(h('li', {}, [h('span', { cls: 'nm', text: x.name, title: x.name }),\n        h('span', { cls: 'tr' }, [h('b', { style: 'width:' + (x.c / max * 100).toFixed(1) + '%' })]), h('span', { cls: 'n', text: (fmt || fmtN)(x.c) })]));\n    });\n    box.appendChild(ul);\n  }\n  function card(title, sub) {\n    var c = h('section', { cls: 'card' }, [h('h2', { text: title }), sub ? h('p', { cls: 'sub', text: sub }) : null]);\n    return c;\n  }\n  function tile(k, v, d) { return h('div', { cls: 'tile' }, [h('div', { cls: 'k', text: k }), h('div', { cls: 'v', text: v }), h('div', { cls: 'd', text: d || '' })]); }\n  var SRC = { direct: 'Direct or app', wa: 'WhatsApp link', cp: 'Copied link' };\n  var CC = (function () { try { return new Intl.DisplayNames(['en-GB'], { type: 'region' }); } catch (e) { return null; } })();\n  var ccName = function (c) { if (!c) return 'Unknown'; try { return CC ? CC.of(c) : c; } catch (e) { return c; } };\n\n  var queue = [];\n  function chartLater(box, cfg) { queue.push([box, cfg]); }\n  function render() {\n    queue = [];\n    var st = data, D = shape(st), n = D.length;\n    var today = D[n - 1], yest = D[n - 2] || {};\n    var col = function (f) { return D.map(function (x) { return x[f]; }); };\n    var labels = D.map(function (x) { return shortD(x.d); }), long = D.map(function (x) { return longD(x.d); });\n    var sum = function (f) { return D.reduce(function (a, x) { return a + x[f]; }, 0); };\n    out.textContent = '';\n    var live = document.getElementById('live');\n    live.hidden = false; live.lastChild.textContent = st.live + (st.live === 1 ? ' person on now' : ' people on now');\n\n    var tiles = h('div', { cls: 'tiles' });\n    tiles.appendChild(tile('Visitors today', fmtN(today.visitors), 'Yesterday ' + fmtN(yest.visitors)));\n    tiles.appendChild(tile('Visits today', fmtN(today.visits), 'Yesterday ' + fmtN(yest.visits)));\n    tiles.appendChild(tile('Daily runs today', fmtN(today.runEnd), today.runEnd ? 'Average ' + today.avgScore.toFixed(1) + ' in a row' : 'Yesterday ' + fmtN(yest.runEnd)));\n    tiles.appendChild(tile('Shares today', fmtN(today.shareWa + today.shareCp), fmtN(today.arrivals) + ' arrived from shared links'));\n    tiles.appendChild(tile('Time per visitor', fmtMin(today.avgTime), 'Yesterday ' + fmtMin(yest.avgTime)));\n    tiles.appendChild(tile('Visitors, ' + n + ' days', fmtN(st.periodVisitors), fmtN(st.everVisitors) + ' ever'));\n    out.appendChild(tiles);\n\n    var grid = h('div', { cls: 'grid' });\n    out.appendChild(grid);\n\n    var c1 = card('Visitors per day', 'Unique visitors, split into first-timers and people coming back.');\n    grid.appendChild(c1);\n    chartLater(c1, { kind: 'bar', stacked: true, labels: labels, long: long, aria: 'Visitors per day',\n      series: [{ name: 'New', color: '--s1', values: col('fresh') }, { name: 'Returning', color: '--s2', values: col('back') }],\n      extra: function (i) { return [fmtN(D[i].visits) + ' visits']; } });\n\n    var c2 = card('Plays per day', 'Daily runs finished, practice runs started, and Kids games started.');\n    grid.appendChild(c2);\n    chartLater(c2, { kind: 'line', labels: labels, long: long, aria: 'Plays per day',\n      series: [{ name: 'Daily runs', color: '--s1', values: col('runEnd') }, { name: 'Practice', color: '--s2', values: col('practice') }, { name: 'Kids', color: '--s3', values: col('kidsGames') }],\n      extra: function (i) { return D[i].runEnd ? ['Average run ' + D[i].avgScore.toFixed(1) + (D[i].runLeft ? ' \u00b7 ' + D[i].runLeft + ' left mid-run' : '')] : []; } });\n\n    var c3 = card('Shares per day', 'Taps on WhatsApp and Copy, and visits that came in through a shared link.');\n    grid.appendChild(c3);\n    chartLater(c3, { kind: 'line', labels: labels, long: long, aria: 'Shares per day',\n      series: [{ name: 'WhatsApp', color: '--s1', values: col('shareWa') }, { name: 'Copy', color: '--s2', values: col('shareCp') }, { name: 'Arrivals', color: '--s3', values: col('arrivals') }] });\n\n    var c4 = card('Time on site', 'Average time per visitor each day, counting only while the page is on screen.');\n    grid.appendChild(c4);\n    chartLater(c4, { kind: 'line', labels: labels, long: long, aria: 'Average time per visitor', fmt: function (m) { return fmtMin(m * 60); },\n      axisFmt: function (v) { return (v % 1 ? v.toFixed(1) : v) + 'm'; },\n      series: [{ name: 'Per visitor', color: '--s1', values: D.map(function (x) { return x.avgTime / 60; }) }] });\n\n    // Run lengths over the last 7 days.\n    var hist = {}, hmax = 0;\n    st.scores.forEach(function (r) { var k = Math.min(30, r.n || 0); hist[k] = (hist[k] || 0) + r.c; hmax = Math.max(hmax, k); });\n    var c5 = card('How far people get', 'Daily run lengths over the last 7 days (30 means 30 or more).');\n    grid.appendChild(c5);\n    var hl = [], hv = [];\n    for (var k = 0; k <= Math.max(10, hmax); k++) { hl.push(String(k)); hv.push(hist[k] || 0); }\n    chartLater(c5, { kind: 'bar', labels: hl, long: hl.map(function (x) { return x + ' in a row'; }), aria: 'Run lengths', series: [{ name: 'Runs', color: '--s1', values: hv }] });\n\n    var c6 = card('Where visitors came from', 'Last 7 days, by visit.');\n    grid.appendChild(c6);\n    ranks(c6, st.sources.map(function (r) { return { name: SRC[r.src] || r.src, c: r.c }; }));\n\n    var c7 = card('Countries', 'Last 7 days, by visitor.');\n    grid.appendChild(c7);\n    ranks(c7, st.countries.map(function (r) { return { name: ccName(r.cc), c: r.c }; }));\n\n    var c8 = card('Pages and devices', 'Visits to each page in this period; devices by visitor over the last 7 days.');\n    grid.appendChild(c8);\n    ranks(c8, [{ name: 'Daily game', c: sum('home') }, { name: 'Ordo Kids', c: sum('kids') }, { name: 'Classic', c: sum('classic') }]);\n    ranks(c8, st.devices.map(function (r) { return { name: r.dev ? r.dev[0].toUpperCase() + r.dev.slice(1) : 'Unknown', c: r.c }; }));\n\n    // Every number, by day.\n    var det = h('details', {}, [h('summary', { text: 'All numbers by day' })]);\n    var cols = [['Day', function (x) { return longD(x.d); }], ['Visitors', 'visitors'], ['New', 'fresh'], ['Visits', 'visits'], ['Daily runs', 'runEnd'],\n      ['Avg run', function (x) { return x.runEnd ? x.avgScore.toFixed(1) : '\u2013'; }], ['Practice', 'practice'], ['Kids', 'kidsGames'],\n      ['WhatsApp', 'shareWa'], ['Copy', 'shareCp'], ['Arrivals', 'arrivals'], ['Boards', 'boards'], ['Time/visitor', function (x) { return fmtMin(x.avgTime); }]];\n    var tb = h('table', {}, [h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { text: c[0] }); }))])]);\n    var body = h('tbody');\n    D.slice().reverse().forEach(function (x) { body.appendChild(h('tr', {}, cols.map(function (c) { return h('td', { text: typeof c[1] === 'function' ? c[1](x) : fmtN(x[c[1]]) }); }))); });\n    tb.appendChild(body); det.appendChild(h('div', { cls: 'tw' }, [tb])); out.appendChild(det);\n    out.appendChild(h('p', { cls: 'note', text: 'Days run midnight to midnight, London time. Visitors are browsers, so one person on a phone and a laptop counts twice. ' +\n      'Counting started ' + (st.first ? longD(st.first) : 'today') + '. Visit ordogame.com/?notrack on your own devices to leave yourself out.' }));\n    queue.forEach(function (q) { chart(q[0], q[1]); });\n    document.getElementById('updated').textContent = 'Updated ' + new Date(st.now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });\n  }\n\n  function load() {\n    document.querySelectorAll('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.days === days)); });\n    fetch('/api/stats?days=' + days + '&key=' + encodeURIComponent(key), { cache: 'no-store' })\n      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })\n      .then(function (st) { data = st; render(); })\n      .catch(function () { out.textContent = ''; out.appendChild(h('div', { cls: 'err', text: 'Couldn\u2019t load the numbers. Check the link has the right key.' })); });\n  }\n  document.querySelectorAll('.seg button').forEach(function (b) {\n    b.addEventListener('click', function () { days = +b.dataset.days; try { localStorage.setItem('ordoStats.days', days); } catch (e) {} load(); });\n  });\n  var rt = 0;\n  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (data) render(); }, 150); });\n  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (data) render(); });\n  setInterval(load, 5 * 60e3);\n  load();\n})();\n<\/script>\n<\/body>\n<\/html>\n";

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url), db = env.DB;
    if (url.pathname === '/stats') {
      if (!env.STATS_KEY) return new Response('Dashboard is off. Add a secret called STATS_KEY to this Worker.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      if (!sameKey(url.searchParams.get('key'), env.STATS_KEY)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      return new Response(DASHBOARD, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
    }
    if (!db) return json({ error: 'Database not bound. Add a D1 binding called DB.' }, 500);
    try {
      await setup(db);
      if (req.method === 'GET' && (url.pathname === '/api/board' || url.pathname === '/')) {
        const day = parseInt(url.searchParams.get('day') || todayNo(), 10);
        if (!Number.isInteger(day) || day < 1) return bad('day');
        const pid = url.searchParams.get('pid');
        return json(await board(db, day, okPid(pid) ? pid : ''), 200, { 'Cache-Control': okPid(pid) ? 'no-store' : 'public, max-age=30' });
      }
      if (req.method === 'GET' && url.pathname === '/api/cdboard') {
        const day = parseInt(url.searchParams.get('day') || todayNo(), 10);
        if (!Number.isInteger(day) || day < 1) return bad('day');
        const pid = url.searchParams.get('pid');
        return json(await cdBoard(db, day, okPid(pid) ? pid : ''), 200, { 'Cache-Control': okPid(pid) ? 'no-store' : 'public, max-age=30' });
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        if (!env.STATS_KEY || !sameKey(url.searchParams.get('key'), env.STATS_KEY)) return json({ error: 'Not found' }, 404);
        const days = Math.min(400, Math.max(7, parseInt(url.searchParams.get('days') || '30', 10) || 30));
        return json(await stats(db, days), 200, { 'Cache-Control': 'no-store' });
      }
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
      let body;
      try { body = JSON.parse(await req.text()); } catch { return bad('json'); }
      if (url.pathname === '/api/ev') {
        const e = body || {};
        if (!okId(e.vid) || !okId(e.sid) || !EV_TYPES.has(e.t)) return bad('event');
        const n = Number.isFinite(e.n) ? Math.max(-1, Math.min(100000, Math.round(e.n))) : null;
        const ua = req.headers.get('User-Agent') || '';
        const dev = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'computer';
        const now = Date.now();
        await db.prepare('INSERT INTO ev (ts, d, vid, sid, pg, t, v, n, src, cc, dev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)')
          .bind(now, londonDay(now), e.vid, e.sid, short(e.pg, 10), e.t, short(e.v, 24), n, short(e.src, 40) || 'direct', (req.cf && req.cf.country) || '', dev).run();
        // Now and then, drop events older than 13 months.
        if (Math.random() < 0.002) await db.prepare('DELETE FROM ev WHERE ts < ?1').bind(now - 400 * 864e5).run();
        return json({ ok: true });
      }
      const { day, pid } = body || {};
      if (!okDay(day)) return bad('day');
      if (!okPid(pid)) return bad('pid');

      if (url.pathname === '/api/play') {
        await db.prepare('INSERT OR IGNORE INTO plays (day, pid) VALUES (?1, ?2)').bind(day, pid).run();
        return json({ ok: true });
      }
      if (url.pathname === '/api/score') {
        const score = body.score;
        if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) return bad('score');
        await db.batch([
          db.prepare('INSERT OR IGNORE INTO plays (day, pid) VALUES (?1, ?2)').bind(day, pid),
          db.prepare('INSERT OR IGNORE INTO scores (day, pid, score, ts) VALUES (?1, ?2, ?3, ?4)').bind(day, pid, score, Date.now())
        ]);
        // If they already had a result today, the first one stands.
        const row = await db.prepare('SELECT score, ts FROM scores WHERE day = ?1 AND pid = ?2').bind(day, pid).first();
        return json({ score: row.score, ...(await ranks(db, day, row.score, row.ts)), board: await board(db, day, pid) });
      }
      if (url.pathname === '/api/cd') {
        const score = body.score;
        if (!Number.isInteger(score) || score < 0 || score > MAX_CD) return bad('score');
        const now = Date.now();
        await db.prepare('INSERT INTO cd (day, pid, best, ts) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (day, pid) DO UPDATE SET ts = CASE WHEN excluded.best > cd.best THEN excluded.ts ELSE cd.ts END, best = MAX(cd.best, excluded.best)')
          .bind(day, pid, score, now).run();
        const row = await db.prepare('SELECT best, ts, name FROM cd WHERE day = ?1 AND pid = ?2').bind(day, pid).first();
        // Carry over a name this player gave before.
        if (!row.name) {
          const prev = await db.prepare('SELECT name FROM cd WHERE pid = ?1 AND name IS NOT NULL LIMIT 1').bind(pid).first();
          if (prev) await db.prepare('UPDATE cd SET name = ?3 WHERE day = ?1 AND pid = ?2').bind(day, pid, prev.name).run();
        }
        return json({ best: row.best, ...(await cdRanks(db, day, row.best, row.ts, pid)), named: !!row.name, board: await cdBoard(db, day, pid) });
      }
      if (url.pathname === '/api/cdname') {
        const name = cleanName(body.name);
        if (!name) return bad('name');
        const r = await db.prepare('UPDATE cd SET name = ?2 WHERE pid = ?1').bind(pid, name).run();
        if (!r.meta.changes) return json({ error: 'No score to name' }, 404);
        return json({ name, board: await cdBoard(db, day, pid) });
      }
      if (url.pathname === '/api/name') {
        const name = cleanName(body.name);
        if (!name) return bad('name');
        const r = await db.prepare('UPDATE scores SET name = ?3 WHERE day = ?1 AND pid = ?2').bind(day, pid, name).run();
        if (!r.meta.changes) return json({ error: 'No score to name' }, 404);
        return json({ name, board: await board(db, day, pid) });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error' }, 500);
    }
  }
};
