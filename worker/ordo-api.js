// Ordo scores API: a Cloudflare Worker with one D1 database bound as DB.
// Endpoints (all JSON, open CORS):
//   POST /api/play   {day, pid}              count a player for the classic daily
//   POST /api/score  {day, pid, score}       record a finished classic daily (first result per player per day only)
//   POST /api/name   {day, pid, name}        put a name on that result
//   GET  /api/board?day=N&pid=X              classic: players today and ever, top 5 today and all time
//   POST /api/cd     {day, pid, score, relaxed}  a daily run (keeps each player's best per day and ever)
//                    Relaxed runs (double time) have their own boards: day key day + 1000000, all-time table cdbest_r, tally scope -1.
//   POST /api/cdname {day, pid, name}        put a name on that player's runs
//   GET  /api/cdboard?day=N&pid=X[&relaxed=1] daily runs: top 5 today and all time (one entry per player), player counts
//   POST /api/ev     {vid, sid, pg, src, ev: [{t, v, n}]}   anonymous usage events (visits, runs, shares, time on site)
//   GET  /stats?key=STATS_KEY                private usage dashboard; GET /api/stats?key=…&days=N is its data
// pid is a random ID the game makes on each device. It is never sent back out.
// STATS_KEY is a secret set in the Worker's settings (Variables and Secrets). Without it the dashboard stays shut.
//
// Built to stay cheap under heavy traffic:
//  - Leaderboards are cached in the Worker for 20 seconds; each player's own entry is patched in fresh, so they always see themselves.
//  - Ranks come from a small score histogram (hist) instead of counting every player.
//  - Usage events are kept raw for two days only, then rolled up into one row per day and measure (agg).

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
  // All-time board now reads cdbest, so this index only cost writes.
  'DROP INDEX IF EXISTS cd_by_best',
  // Each player's best run ever.
  'CREATE TABLE IF NOT EXISTS cdbest (pid TEXT PRIMARY KEY, best INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT)',
  'CREATE INDEX IF NOT EXISTS cdbest_by_best ON cdbest (best DESC, ts)',
  'CREATE TABLE IF NOT EXISTS cdbest_r (pid TEXT PRIMARY KEY, best INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT)',
  'CREATE INDEX IF NOT EXISTS cdbest_r_by_best ON cdbest_r (best DESC, ts)',
  // How many players have each score: scope = day number, or 0 for all time.
  'CREATE TABLE IF NOT EXISTS hist (scope INTEGER NOT NULL, best INTEGER NOT NULL, c INTEGER NOT NULL, PRIMARY KEY (scope, best)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
  // Usage events: raw for two days (no indexes, so each event is one row written), then rolled up into agg. d is the London date.
  'CREATE TABLE IF NOT EXISTS ev (ts INTEGER NOT NULL, d TEXT NOT NULL, vid TEXT NOT NULL, sid TEXT NOT NULL, pg TEXT, t TEXT NOT NULL, v TEXT, n INTEGER, src TEXT, cc TEXT, dev TEXT)',
  'DROP INDEX IF EXISTS ev_by_day',
  'DROP INDEX IF EXISTS ev_by_ts',
  'CREATE TABLE IF NOT EXISTS agg (d TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, c INTEGER, u INTEGER, s INTEGER, PRIMARY KEY (d, k, v)) WITHOUT ROWID'
];
// One-off: fill cdbest and hist from the runs already stored.
const MIGRATE = [
  'INSERT OR IGNORE INTO cdbest (pid, best, ts, name) SELECT c.pid, c.best, c.ts, (SELECT n.name FROM cd n WHERE n.pid = c.pid AND n.name IS NOT NULL LIMIT 1) FROM cd c ' +
    'WHERE NOT EXISTS (SELECT 1 FROM cd d WHERE d.pid = c.pid AND (d.best > c.best OR (d.best = c.best AND d.ts < c.ts)))',
  'DELETE FROM hist',
  'INSERT INTO hist (scope, best, c) SELECT day, best, COUNT(*) FROM cd GROUP BY day, best',
  'INSERT INTO hist (scope, best, c) SELECT 0, best, COUNT(*) FROM cdbest GROUP BY best',
  "INSERT OR REPLACE INTO meta (k, v) VALUES ('v2', '1')"
];
let ready = null;
async function init(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  const done = await db.prepare("SELECT v FROM meta WHERE k = 'v2'").first();
  if (!done) await db.batch(MIGRATE.map(s => db.prepare(s)));
}
const setup = db => ready || (ready = init(db).catch(e => { ready = null; throw e; }));

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

// ---------- A short-lived cache inside this Worker instance ----------
const mem = new Map();
function cached(key, ttl, fn) {
  const e = mem.get(key), now = Date.now();
  if (e && now - e.at < ttl) return e.p;
  const p = fn().catch(err => { mem.delete(key); throw err; });
  mem.set(key, { at: now, p });
  if (mem.size > 300) mem.delete(mem.keys().next().value);
  return p;
}
const forget = prefix => { for (const k of mem.keys()) if (k.startsWith(prefix)) mem.delete(k); };

// Put the asking player's own up-to-date entry into a cached top 5.
function withOwn(list, own, key) {
  let out = list.filter(r => r.pid !== own?.pid);
  if (own) { out.push(own); out.sort((a, b) => b[key] - a[key] || a.ts - b.ts); }
  return out.slice(0, 5);
}

// ---------- Classic daily board ----------
async function board(db, day, pid) {
  const shared = await cached('b:' + day, 20e3, async () => {
    const [today, ever, playersToday] = await db.batch([
      db.prepare('SELECT score, name, ts, pid, day FROM scores WHERE day = ?1 ORDER BY score DESC, ts LIMIT 5').bind(day),
      db.prepare('SELECT score, name, ts, pid, day FROM scores ORDER BY score DESC, ts LIMIT 5'),
      db.prepare('SELECT COUNT(*) AS n FROM plays WHERE day = ?1').bind(day)
    ]);
    return { today: today.results, all: ever.results, players: playersToday.results[0].n };
  });
  const playersEver = await cached('pe', 10 * 60e3, async () => (await db.prepare('SELECT COUNT(DISTINCT pid) AS n FROM plays').first()).n);
  const own = pid ? await db.prepare('SELECT score, name, ts, pid, day FROM scores WHERE day = ?1 AND pid = ?2').bind(day, pid).first() : null;
  const tidy = r => ({ score: r.score, name: r.name || 'Player', day: r.day, me: !!pid && r.pid === pid });
  return { day, players: shared.players, playersEver, today: withOwn(shared.today, own, 'score').map(tidy), all: withOwn(shared.all, own, 'score').map(tidy) };
}
async function ranks(db, day, score, ts) {
  // Rank = 1 + results that beat this one (higher score, or same score set earlier).
  const [d, a] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM scores WHERE day = ?1 AND (score > ?2 OR (score = ?2 AND ts < ?3))').bind(day, score, ts),
    db.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?1 OR (score = ?1 AND ts < ?2)').bind(score, ts)
  ]);
  return { rankDay: d.results[0].n + 1, rankAll: a.results[0].n + 1 };
}

// ---------- Daily run board ----------
const RELAXED_DAY = 1000000;
const modeOf = (day, rx) => rx ? { dk: day + RELAXED_DAY, all: -1, tbl: 'cdbest_r' } : { dk: day, all: 0, tbl: 'cdbest' };
async function cdBoard(db, day, pid, rx) {
  const m = modeOf(day, rx);
  const shared = await cached('cd:' + m.dk, 20e3, async () => {
    const [today, ever, nToday, nEver] = await db.batch([
      db.prepare('SELECT best, name, ts, pid FROM cd WHERE day = ?1 ORDER BY best DESC, ts LIMIT 5').bind(m.dk),
      db.prepare(`SELECT best, name, ts, pid FROM ${m.tbl} ORDER BY best DESC, ts LIMIT 5`),
      // Player counts cover both clocks.
      db.prepare('SELECT COALESCE(SUM(c), 0) AS n FROM hist WHERE scope IN (?1, ?2)').bind(day, day + RELAXED_DAY),
      db.prepare('SELECT COALESCE(SUM(c), 0) AS n FROM hist WHERE scope IN (0, -1)')
    ]);
    return { today: today.results, all: ever.results, players: nToday.results[0].n, playersEver: nEver.results[0].n };
  });
  let ownDay = null, ownAll = null;
  if (pid) {
    const [a, b] = await db.batch([
      db.prepare('SELECT best, name, ts, pid FROM cd WHERE day = ?1 AND pid = ?2').bind(m.dk, pid),
      db.prepare(`SELECT best, name, ts, pid FROM ${m.tbl} WHERE pid = ?1`).bind(pid)
    ]);
    ownDay = a.results[0] || null; ownAll = b.results[0] || null;
  }
  const tidy = r => ({ score: r.best, name: r.name || 'Player', me: !!pid && r.pid === pid });
  return { day, relaxed: !!rx, players: shared.players, playersEver: shared.playersEver,
    today: withOwn(shared.today, ownDay, 'best').map(tidy), all: withOwn(shared.all, ownAll, 'best').map(tidy) };
}
// Rank from the histogram; near the top, count exactly so ties and the top 5 are right.
async function cdRank(db, scope, best, ts, pid, tbl) {
  const [above, same] = await db.batch([
    db.prepare('SELECT COALESCE(SUM(c), 0) AS n FROM hist WHERE scope = ?1 AND best > ?2').bind(scope, best),
    db.prepare('SELECT c FROM hist WHERE scope = ?1 AND best = ?2').bind(scope, best)
  ]);
  const up = above.results[0].n;
  if (up < 6) {
    const q = scope > 0
      ? db.prepare('SELECT COUNT(*) AS n FROM cd WHERE day = ?1 AND (best > ?2 OR (best = ?2 AND ts < ?3))').bind(scope, best, ts)
      : db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE pid != ?3 AND (best > ?1 OR (best = ?1 AND ts < ?2))`).bind(best, ts, pid);
    return (await q.first()).n + 1;
  }
  return up + Math.max(0, ((same.results[0] || {}).c || 1) - 1) + 1;
}
const histMove = (db, scope, from, to) => [
  ...(from == null ? [] : [db.prepare('UPDATE hist SET c = c - 1 WHERE scope = ?1 AND best = ?2').bind(scope, from)]),
  db.prepare('INSERT INTO hist (scope, best, c) VALUES (?1, ?2, 1) ON CONFLICT (scope, best) DO UPDATE SET c = c + 1').bind(scope, to)
];
async function saveRun(db, day, pid, score, rx) {
  const m = modeOf(day, rx), now = Date.now();
  const [dRow, aRow, nRow] = await db.batch([
    db.prepare('SELECT best, ts, name FROM cd WHERE day = ?1 AND pid = ?2').bind(m.dk, pid),
    db.prepare(`SELECT best, ts, name FROM ${m.tbl} WHERE pid = ?1`).bind(pid),
    // A name given on either board carries over.
    db.prepare('SELECT name FROM cdbest WHERE pid = ?1 AND name IS NOT NULL UNION ALL SELECT name FROM cdbest_r WHERE pid = ?1 AND name IS NOT NULL LIMIT 1').bind(pid)
  ]);
  let day1 = dRow.results[0], all1 = aRow.results[0];
  const writes = [];
  const name = (day1 && day1.name) || (all1 && all1.name) || (nRow.results[0] || {}).name || null;
  if (!day1) {
    writes.push(db.prepare('INSERT INTO cd (day, pid, best, name, ts) VALUES (?1, ?2, ?3, ?4, ?5)').bind(m.dk, pid, score, name, now), ...histMove(db, m.dk, null, score));
    day1 = { best: score, ts: now, name };
  } else if (score > day1.best) {
    writes.push(db.prepare('UPDATE cd SET best = ?3, ts = ?4 WHERE day = ?1 AND pid = ?2').bind(m.dk, pid, score, now), ...histMove(db, m.dk, day1.best, score));
    day1 = { best: score, ts: now, name: day1.name };
  }
  if (!all1) {
    writes.push(db.prepare(`INSERT INTO ${m.tbl} (pid, best, ts, name) VALUES (?1, ?2, ?3, ?4)`).bind(pid, score, now, name), ...histMove(db, m.all, null, score));
    all1 = { best: score, ts: now };
  } else if (score > all1.best) {
    writes.push(db.prepare(`UPDATE ${m.tbl} SET best = ?2, ts = ?3 WHERE pid = ?1`).bind(pid, score, now), ...histMove(db, m.all, all1.best, score));
    all1 = { best: score, ts: now };
  }
  if (writes.length) await db.batch(writes);
  const [rankDay, rankAll] = await Promise.all([cdRank(db, m.dk, day1.best, day1.ts, pid), cdRank(db, m.all, all1.best, all1.ts, pid, m.tbl)]);
  return { best: day1.best, rankDay, rankAll, named: !!day1.name, relaxed: !!rx };
}

// ---------- Usage stats ----------
const EV_TYPES = new Set(['visit', 'time', 'run_start', 'run_end', 'practice', 'practice_end', 'share', 'board', 'kids_start', 'kids_end', 'relaxed']);
const okId = x => typeof x === 'string' && /^[a-z0-9]{8,20}$/.test(x);
const short = (x, n) => typeof x === 'string' ? x.replace(/[^\w.:-]/g, '').slice(0, n) : '';
const LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const londonDay = ms => LONDON.format(new Date(ms));
const LONDON_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Yesterday is rolled up from 00:15 London time (a margin for requests still in flight at midnight).
const rollCutoff = now => { const [h, m] = LONDON_HM.format(new Date(now)).split(':').map(Number); return h * 60 + m >= 15 ? londonDay(now) : londonDay(now - 864e5); };
// Each Worker instance checks once a day whether there's anything to roll up.
function maybeRollUp(db, ctx) {
  const cut = rollCutoff(Date.now());
  if (mem.has('roll:' + cut)) return;
  mem.set('roll:' + cut, { at: Date.now(), p: Promise.resolve() });
  const p = rollUp(db, cut).catch(() => mem.delete('roll:' + cut));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}
const sameKey = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

// Everything the dashboard needs about one day, from the raw events.
async function aggDay(db, d) {
  const [ev, vis, src, cc, dev, score] = await db.batch([
    db.prepare('SELECT t, v, COUNT(*) AS c, COUNT(DISTINCT vid) AS u, SUM(n) AS s FROM ev WHERE d = ?1 GROUP BY t, v').bind(d),
    db.prepare("SELECT COUNT(DISTINCT vid) AS u FROM ev WHERE d = ?1 AND t = 'visit'").bind(d),
    db.prepare("SELECT src AS v, COUNT(*) AS c FROM ev WHERE d = ?1 AND t = 'visit' GROUP BY src ORDER BY c DESC LIMIT 40").bind(d),
    db.prepare("SELECT cc AS v, COUNT(*) AS c FROM ev WHERE d = ?1 AND t = 'visit' GROUP BY cc ORDER BY c DESC LIMIT 40").bind(d),
    db.prepare("SELECT dev AS v, COUNT(*) AS c FROM ev WHERE d = ?1 AND t = 'visit' GROUP BY dev").bind(d),
    db.prepare("SELECT n AS v, COUNT(*) AS c FROM ev WHERE d = ?1 AND t = 'run_end' GROUP BY n").bind(d)
  ]);
  const rows = [];
  ev.results.forEach(r => rows.push({ d, k: 't:' + r.t, v: r.v || '', c: r.c, u: r.u, s: r.s || 0 }));
  rows.push({ d, k: 'visitors', v: '', c: 0, u: vis.results[0].u, s: 0 });
  rows.push({ d, k: 'fresh', v: '', c: ev.results.filter(r => r.t === 'visit').reduce((a, r) => a + (r.s || 0), 0), u: 0, s: 0 });
  [['src', src], ['cc', cc], ['dev', dev], ['score', score]].forEach(([k, res]) => res.results.forEach(r => rows.push({ d, k, v: String(r.v ?? ''), c: r.c, u: 0, s: 0 })));
  return rows;
}
// Finished days get rolled up once, then their raw events are deleted.
async function rollUp(db, cutoff) {
  const days = (await db.prepare('SELECT DISTINCT d FROM ev WHERE d < ?1').bind(cutoff).all()).results.map(r => r.d);
  for (const d of days) {
    const rows = await aggDay(db, d);
    const fresh = rows.find(r => r.k === 'fresh').c;
    const put = db.prepare('INSERT OR REPLACE INTO agg (d, k, v, c, u, s) VALUES (?1, ?2, ?3, ?4, ?5, ?6)');
    await db.batch([
      ...rows.map(r => put.bind(r.d, r.k, r.v, r.c, r.u, r.s)),
      db.prepare("INSERT INTO meta (k, v) VALUES ('ever', ?1) ON CONFLICT (k) DO UPDATE SET v = CAST(v AS INTEGER) + ?1").bind(fresh),
      db.prepare('DELETE FROM ev WHERE d = ?1').bind(d)
    ]);
  }
}
async function stats(db, days) {
  const now = Date.now(), today = londonDay(now), yday = londonDay(now - 864e5);
  const from = londonDay(now - (days - 1) * 864e5), week = londonDay(now - 6 * 864e5);
  const cut = rollCutoff(now);
  await rollUp(db, cut);
  const [stored, liveT, liveY, extra] = await Promise.all([
    db.prepare('SELECT d, k, v, c, u, s FROM agg WHERE d >= ?1').bind(from).all(),
    aggDay(db, today), cut === today ? [] : aggDay(db, yday),
    db.batch([
      db.prepare('SELECT COUNT(DISTINCT vid) AS u FROM ev WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM ev) - 5000 AND ts > ?1').bind(now - 5 * 60e3),
      db.prepare("SELECT v FROM meta WHERE k = 'ever'"),
      db.prepare('SELECT MIN(d) AS d FROM agg'),
      db.prepare('SELECT MIN(d) AS d FROM ev')
    ])
  ]);
  const all = stored.results.concat(liveY, liveT).filter(r => r.d >= from);
  const sumBy = (k, sinceD) => {
    const m = {};
    all.filter(r => r.k === k && r.d >= sinceD).forEach(r => { m[r.v] = (m[r.v] || 0) + r.c; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const [live, ever, firstAgg, firstEv] = extra.map(r => r.results[0]);
  const freshLive = [liveY, liveT].reduce((a, rows) => a + (rows.find(r => r.k === 'fresh') || { c: 0 }).c, 0);
  // Milestone: two days in a row with 100+ visitors. Remembered once reached (it's the cue to file the trade mark).
  const MILESTONE = 100;
  let milestone = (await db.prepare("SELECT v FROM meta WHERE k = 'milestone100'").first() || {}).v || null;
  if (!milestone) {
    const byDay = {};
    all.filter(r => r.k === 'visitors').forEach(r => { byDay[r.d] = r.u; });
    const ds = Object.keys(byDay).sort();
    for (let i = 1; i < ds.length; i++) {
      const gap = (Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 864e5;
      if (gap === 1 && byDay[ds[i]] >= MILESTONE && byDay[ds[i - 1]] >= MILESTONE) { milestone = ds[i]; break; }
    }
    if (milestone) await db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('milestone100', ?1)").bind(milestone).run();
  }
  return { now, today, from, days, milestone,
    rows: all.filter(r => r.k.startsWith('t:')).map(r => ({ d: r.d, t: r.k.slice(2), v: r.v, c: r.c, u: r.u, s: r.s })),
    visitors: all.filter(r => r.k === 'visitors').map(r => ({ d: r.d, u: r.u })),
    fresh: all.filter(r => r.k === 'fresh').map(r => ({ d: r.d, c: r.c })),
    arrivals: all.filter(r => r.k === 'src' && (r.v === 'wa' || r.v === 'cp')).map(r => ({ d: r.d, src: r.v, c: r.c })),
    scores: all.filter(r => r.k === 'score' && r.d >= week).map(r => ({ d: r.d, n: +r.v, c: r.c })),
    sources: sumBy('src', week).slice(0, 12).map(([src, c]) => ({ src, c })),
    countries: sumBy('cc', week).slice(0, 10).map(([cc, c]) => ({ cc, c })),
    devices: sumBy('dev', week).map(([dev, c]) => ({ dev, c })),
    live: live.u, everVisitors: (ever ? +ever.v : 0) + freshLive, first: (firstAgg && firstAgg.d) || (firstEv && firstEv.d) || null };
}

const DASHBOARD = "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n<title>Ordo stats<\/title>\n<style>\n:root {\n  color-scheme: light;\n  --bg: #f6f6f3; --surface: #fcfcfb; --edge: #e4e3dd; --grid: #ecebe6;\n  --text: #0b0b0b; --text-2: #52514e; --muted: #7a7973;\n  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;\n  --bar: #86b6ef; --accent: #b414b4;\n}\n@media (prefers-color-scheme: dark) {\n  :root:where(:not([data-theme=\"light\"])) {\n    color-scheme: dark;\n    --bg: #121211; --surface: #1a1a19; --edge: #2c2c2a; --grid: #262624;\n    --text: #f0efec; --text-2: #c3c2b7; --muted: #8f8e86;\n    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --bar: #1c5cab; --accent: #e070e0;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --bg: #121211; --surface: #1a1a19; --edge: #2c2c2a; --grid: #262624;\n  --text: #f0efec; --text-2: #c3c2b7; --muted: #8f8e86;\n  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --bar: #1c5cab; --accent: #e070e0;\n}\n* { box-sizing: border-box; }\nbody { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif; }\nmain { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }\nheader { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 16px; }\nh1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }\n.live { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }\n.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--s3); display: inline-block; }\n.spacer { flex: 1; }\n.seg { display: inline-flex; border: 1px solid var(--edge); border-radius: 8px; overflow: hidden; background: var(--surface); }\n.seg button { appearance: none; border: 0; background: none; color: var(--text-2); font: inherit; font-size: 13px; padding: 6px 12px; cursor: pointer; }\n.seg button + button { border-left: 1px solid var(--edge); }\n.seg button[aria-pressed=\"true\"] { background: var(--text); color: var(--surface); }\n.updated { font-size: 12px; color: var(--muted); }\n.milestone { display: flex; gap: 12px; align-items: center; background: var(--surface); border: 1px solid var(--s3); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; font-size: 14px; }\n.milestone div { flex: 1; }\n.milestone button { appearance: none; border: 1px solid var(--edge); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }\n.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }\n.tile { background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 12px 14px; }\n.tile .k { font-size: 12px; color: var(--text-2); }\n.tile .v { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.2; }\n.tile .d { font-size: 12px; color: var(--muted); }\n.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }\n.card { background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 14px 14px 10px; min-width: 0; }\n.card h2 { font-size: 15px; margin: 0; }\n.card .sub { font-size: 12px; color: var(--muted); margin: 2px 0 8px; }\n.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--text-2); margin-bottom: 4px; }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.legend b { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }\n.legend b.ln { height: 3px; border-radius: 2px; width: 14px; }\n.chart { position: relative; }\n.chart svg { display: block; width: 100%; overflow: visible; }\n.chart svg:focus { outline: none; }\n.chart svg:focus-visible { outline: 2px solid var(--s1); outline-offset: 2px; border-radius: 4px; }\n.ax { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }\n.dl { font-size: 11px; fill: var(--text-2); font-weight: 600; }\n.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--edge); border-radius: 8px; padding: 6px 9px; font-size: 12px;\n  box-shadow: 0 4px 14px rgb(0 0 0 / .12); white-space: nowrap; z-index: 2; color: var(--text); }\n.tip .h { color: var(--text-2); margin-bottom: 2px; }\n.tip .r { display: flex; align-items: center; gap: 6px; }\n.tip .r b { font-variant-numeric: tabular-nums; }\n.tip .r i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }\n.ranks { list-style: none; margin: 4px 0 6px; padding: 0; display: grid; gap: 6px; }\n.ranks li { display: grid; grid-template-columns: minmax(80px, 38%) 1fr 44px; align-items: center; gap: 8px; font-size: 13px; }\n.ranks .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }\n.ranks .tr { height: 12px; }\n.ranks .tr b { display: block; height: 100%; background: var(--bar); border-radius: 0 4px 4px 0; min-width: 2px; }\n.ranks .n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }\n.empty { color: var(--muted); font-size: 13px; padding: 18px 0; text-align: center; }\ndetails { margin-top: 14px; background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 10px 14px; }\nsummary { cursor: pointer; font-weight: 600; }\n.tw { overflow-x: auto; }\ntable { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }\nth, td { padding: 5px 8px; text-align: right; border-bottom: 1px solid var(--grid); white-space: nowrap; }\nth:first-child, td:first-child { text-align: left; }\nth { color: var(--text-2); font-weight: 600; }\n.note { font-size: 12px; color: var(--muted); margin-top: 14px; }\n.err { background: var(--surface); border: 1px solid var(--edge); border-radius: 12px; padding: 20px; }\n<\/style>\n<\/head>\n<body>\n<main>\n  <header>\n    <h1>Ordo stats<\/h1>\n    <span class=\"live\" id=\"live\" hidden><i><\/i><span><\/span><\/span>\n    <span class=\"spacer\"><\/span>\n    <div class=\"seg\" role=\"group\" aria-label=\"Date range\">\n      <button type=\"button\" data-days=\"7\" aria-pressed=\"false\">7 days<\/button>\n      <button type=\"button\" data-days=\"30\" aria-pressed=\"true\">30 days<\/button>\n      <button type=\"button\" data-days=\"90\" aria-pressed=\"false\">90 days<\/button>\n    <\/div>\n    <span class=\"updated\" id=\"updated\"><\/span>\n  <\/header>\n  <div id=\"out\"><p class=\"updated\">Loading\u2026<\/p><\/div>\n<\/main>\n<script>\n(function () {\n  'use strict';\n  var key = new URLSearchParams(location.search).get('key') || '';\n  var days = 30;\n  try { days = parseInt(localStorage.getItem('ordoStats.days'), 10) || 30; } catch (e) {}\n  var out = document.getElementById('out');\n  var data = null;\n\n  function h(tag, attrs, kids) {\n    var n = document.createElement(tag);\n    if (attrs) for (var k in attrs) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'cls') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }\n    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });\n    return n;\n  }\n  var NS = 'http://www.w3.org/2000/svg';\n  function s(tag, attrs, text) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; }\n  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };\n  var fmtN = function (x) { return x == null ? '\u2013' : Math.round(x).toLocaleString('en-GB'); };\n  var fmtMin = function (sec) { if (!sec) return '0m'; var m = Math.floor(sec / 60), r = Math.round(sec % 60); return m ? m + 'm ' + r + 's' : r + 's'; };\n  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n  function parseD(d) { var p = d.split('-'); return new Date(Date.UTC(+p[0], p[1] - 1, +p[2])); }\n  function keyD(dt) { return dt.toISOString().slice(0, 10); }\n  function shortD(d) { var t = parseD(d); return t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; }\n  function longD(d) { var t = parseD(d); return DOW[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; }\n\n  // ---------- Turn the raw rows into one record per day ----------\n  function shape(st) {\n    var list = [], idx = {};\n    for (var t = parseD(st.from); keyD(t) <= st.today; t = new Date(t.getTime() + 864e5)) {\n      var d = keyD(t);\n      idx[d] = list.length;\n      list.push({ d: d, visits: 0, visitors: 0, fresh: 0, home: 0, kids: 0, classic: 0, runStart: 0, runEnd: 0, runLeft: 0, scoreSum: 0,\n        practice: 0, relaxed: 0, kidsGames: 0, shareWa: 0, shareCp: 0, arrivals: 0, timeSum: 0, timeU: 0, boards: 0 });\n    }\n    var at = function (d) { return idx[d] == null ? null : list[idx[d]]; };\n    st.rows.forEach(function (r) {\n      var x = at(r.d); if (!x) return;\n      if (r.t === 'visit') { x.visits += r.c; if (r.v === 'kids') x.kids += r.c; else if (r.v === 'classic') x.classic += r.c; else x.home += r.c; }\n      else if (r.t === 'run_start') x.runStart += r.c;\n      else if (r.t === 'run_end') { x.runEnd += r.c; x.scoreSum += r.s || 0; if (/left/.test(r.v)) x.runLeft += r.c; if (/relaxed/.test(r.v)) x.relaxed += r.c; }\n      else if (r.t === 'practice') x.practice += r.c;\n      else if (r.t === 'kids_start') x.kidsGames += r.c;\n      else if (r.t === 'share') { if (/^wa/.test(r.v)) x.shareWa += r.c; else x.shareCp += r.c; }\n      else if (r.t === 'time') { x.timeSum += r.s || 0; x.timeU += r.u; }\n      else if (r.t === 'board') x.boards += r.c;\n    });\n    // time rows are split by v (always ''), so u per day is already distinct visitors with time.\n    st.visitors.forEach(function (r) { var x = at(r.d); if (x) x.visitors = r.u; });\n    st.fresh.forEach(function (r) { var x = at(r.d); if (x) x.fresh = r.c; });\n    (st.arrivals || []).forEach(function (r) { var x = at(r.d); if (x) x.arrivals += r.c; });\n    list.forEach(function (x) { x.back = Math.max(0, x.visitors - x.fresh); x.avgTime = x.timeU ? x.timeSum / x.timeU : 0; x.avgScore = x.runEnd ? x.scoreSum / x.runEnd : 0; });\n    return list;\n  }\n\n  // ---------- A small SVG chart: bars (optionally stacked) or lines, one y-axis, crosshair tooltip ----------\n  function nice(max) {\n    if (max <= 0) return 4;\n    if (max <= 4 && max > 1) return max <= 2 ? 2 : 4;\n    if (max <= 1) return 1;\n    var p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p;\n    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;\n  }\n  function chart(box, cfg) {\n    // cfg: { labels, long, series: [{name, color, values}], kind: 'bar'|'line', stacked, fmt }\n    var series = cfg.series, n = cfg.labels.length, fmt = cfg.fmt || fmtN;\n    var legend = h('div', { cls: 'legend' });\n    if (series.length > 1) series.forEach(function (sr) { legend.appendChild(h('span', {}, [h('b', { cls: cfg.kind === 'line' ? 'ln' : '', style: 'background:' + css(sr.color) }), sr.name])); });\n    var wrap = h('div', { cls: 'chart' });\n    box.appendChild(legend); box.appendChild(wrap);\n    var total = 0; series.forEach(function (sr) { sr.values.forEach(function (v) { total += v || 0; }); });\n    if (!total) { wrap.appendChild(h('div', { cls: 'empty', text: 'Nothing yet in this period.' })); return; }\n    var W = Math.max(280, wrap.clientWidth || 320), H = 190;\n    var direct = cfg.kind === 'line' && series.length > 1 && series.length <= 4;\n    var L = 34, R = direct ? 74 : 10, T = 10, B = 24, pw = W - L - R, ph = H - T - B;\n    var max = 0;\n    for (var i = 0; i < n; i++) {\n      if (cfg.stacked) { var sum = 0; series.forEach(function (sr) { sum += sr.values[i] || 0; }); max = Math.max(max, sum); }\n      else series.forEach(function (sr) { max = Math.max(max, sr.values[i] || 0); });\n    }\n    var top = nice(max), y = function (v) { return T + ph - (v / top) * ph; };\n    var band = pw / n, xc = function (i) { return L + band * (i + 0.5); };\n    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', tabindex: '0', 'aria-label': cfg.aria || '' });\n    [0, top / 2, top].forEach(function (v) {\n      svg.appendChild(s('line', { x1: L, x2: L + pw, y1: y(v), y2: y(v), stroke: css('--grid'), 'stroke-width': 1 }));\n      svg.appendChild(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'ax' }, cfg.axisFmt ? cfg.axisFmt(v) : (v % 1 ? v.toFixed(1) : fmtN(v))));\n    });\n    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));\n    for (var j = n - 1; j >= 0; j -= every) svg.appendChild(s('text', { x: xc(j), y: H - 6, 'text-anchor': 'middle', class: 'ax' }, cfg.labels[j]));\n    if (cfg.kind === 'bar') {\n      var bw = Math.max(2, Math.min(28, band * 0.72));\n      for (var b = 0; b < n; b++) {\n        var base = 0, segs = [];\n        series.forEach(function (sr) { var v = sr.values[b] || 0; if (v > 0) segs.push({ v: v, c: css(sr.color), from: base }); base += v; });\n        segs.forEach(function (sg, k) {\n          var y0 = y(sg.from), y1 = y(sg.from + sg.v), x0 = xc(b) - bw / 2;\n          if (k > 0) y0 -= 2; // surface gap between stacked segments\n          var hgt = Math.max(1, y0 - y1), last = k === segs.length - 1, r = last ? Math.min(4, bw / 2, hgt) : 0;\n          var d = 'M' + x0 + ',' + y0 + 'V' + (y1 + r) + (r ? 'Q' + x0 + ',' + y1 + ' ' + (x0 + r) + ',' + y1 : '') + 'H' + (x0 + bw - r) +\n            (r ? 'Q' + (x0 + bw) + ',' + y1 + ' ' + (x0 + bw) + ',' + (y1 + r) : '') + 'V' + y0 + 'Z';\n          svg.appendChild(s('path', { d: d, fill: sg.c }));\n        });\n      }\n    } else {\n      var ends = [];\n      series.forEach(function (sr) {\n        var pts = sr.values.map(function (v, i) { return xc(i).toFixed(1) + ',' + y(v || 0).toFixed(1); });\n        svg.appendChild(s('polyline', { points: pts.join(' '), fill: 'none', stroke: css(sr.color), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));\n        if (n === 1) svg.appendChild(s('circle', { cx: xc(0), cy: y(sr.values[0] || 0), r: 4, fill: css(sr.color) }));\n        ends.push({ y: y(sr.values[n - 1] || 0), name: sr.name });\n      });\n      if (direct) {\n        ends.sort(function (a, b) { return a.y - b.y; });\n        for (var e = 1; e < ends.length; e++) if (ends[e].y - ends[e - 1].y < 13) ends[e].y = ends[e - 1].y + 13;\n        ends.forEach(function (en) { svg.appendChild(s('text', { x: L + pw + 6, y: en.y + 4, class: 'dl' }, en.name)); });\n      }\n    }\n    // Hover layer: hairline + tooltip with every series at that day.\n    var hair = s('line', { y1: T, y2: T + ph, stroke: css('--muted'), 'stroke-width': 1, opacity: 0 });\n    svg.appendChild(hair);\n    var dots = series.map(function (sr) { var c = s('circle', { r: 4, fill: css(sr.color), stroke: css('--surface'), 'stroke-width': 2, opacity: 0 }); svg.appendChild(c); return c; });\n    var tip = h('div', { cls: 'tip', hidden: '' });\n    wrap.appendChild(svg); wrap.appendChild(tip);\n    var cur = -1;\n    function show(i) {\n      if (i < 0 || i >= n) return hide();\n      cur = i;\n      var scale = wrap.clientWidth / W;\n      hair.setAttribute('x1', xc(i)); hair.setAttribute('x2', xc(i)); hair.setAttribute('opacity', cfg.kind === 'line' ? 0.6 : 0);\n      if (cfg.kind === 'line') series.forEach(function (sr, k) { dots[k].setAttribute('cx', xc(i)); dots[k].setAttribute('cy', y(sr.values[i] || 0)); dots[k].setAttribute('opacity', 1); });\n      tip.textContent = '';\n      tip.appendChild(h('div', { cls: 'h', text: cfg.long[i] }));\n      var rows = series.slice();\n      if (cfg.stacked) rows = rows.slice().reverse();\n      rows.forEach(function (sr) { tip.appendChild(h('div', { cls: 'r' }, [h('i', { style: 'background:' + css(sr.color) }), h('b', { text: fmt(sr.values[i] || 0) }), ' ' + sr.name])); });\n      if (cfg.extra) cfg.extra(i).forEach(function (line) { tip.appendChild(h('div', { cls: 'r', text: line })); });\n      tip.hidden = false;\n      var tx = xc(i) * scale + 12, tw = tip.offsetWidth;\n      if (tx + tw > wrap.clientWidth) tx = xc(i) * scale - tw - 12;\n      tip.style.left = Math.max(0, tx) + 'px'; tip.style.top = '4px';\n    }\n    function hide() { cur = -1; tip.hidden = true; hair.setAttribute('opacity', 0); dots.forEach(function (d) { d.setAttribute('opacity', 0); }); }\n    svg.addEventListener('pointermove', function (ev) {\n      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W;\n      show(Math.max(0, Math.min(n - 1, Math.floor((x - L) / band))));\n    });\n    svg.addEventListener('pointerleave', hide);\n    svg.addEventListener('focus', function () { show(n - 1); });\n    svg.addEventListener('blur', hide);\n    svg.addEventListener('keydown', function (ev) {\n      if (ev.key === 'ArrowLeft') { show(Math.max(0, (cur < 0 ? n : cur) - 1)); ev.preventDefault(); }\n      if (ev.key === 'ArrowRight') { show(Math.min(n - 1, cur + 1)); ev.preventDefault(); }\n    });\n  }\n\n  function ranks(box, items, fmt) {\n    if (!items.length) { box.appendChild(h('div', { cls: 'empty', text: 'Nothing yet.' })); return; }\n    var max = Math.max.apply(null, items.map(function (x) { return x.c; })) || 1;\n    var ul = h('ul', { cls: 'ranks' });\n    items.forEach(function (x) {\n      ul.appendChild(h('li', {}, [h('span', { cls: 'nm', text: x.name, title: x.name }),\n        h('span', { cls: 'tr' }, [h('b', { style: 'width:' + (x.c / max * 100).toFixed(1) + '%' })]), h('span', { cls: 'n', text: (fmt || fmtN)(x.c) })]));\n    });\n    box.appendChild(ul);\n  }\n  function card(title, sub) {\n    var c = h('section', { cls: 'card' }, [h('h2', { text: title }), sub ? h('p', { cls: 'sub', text: sub }) : null]);\n    return c;\n  }\n  function tile(k, v, d) { return h('div', { cls: 'tile' }, [h('div', { cls: 'k', text: k }), h('div', { cls: 'v', text: v }), h('div', { cls: 'd', text: d || '' })]); }\n  var SRC = { direct: 'Direct or app', wa: 'WhatsApp link', cp: 'Copied link' };\n  var CC = (function () { try { return new Intl.DisplayNames(['en-GB'], { type: 'region' }); } catch (e) { return null; } })();\n  var ccName = function (c) { if (!c) return 'Unknown'; try { return CC ? CC.of(c) : c; } catch (e) { return c; } };\n\n  var queue = [];\n  function chartLater(box, cfg) { queue.push([box, cfg]); }\n  function render() {\n    queue = [];\n    var st = data, D = shape(st), n = D.length;\n    var today = D[n - 1], yest = D[n - 2] || {};\n    var col = function (f) { return D.map(function (x) { return x[f]; }); };\n    var labels = D.map(function (x) { return shortD(x.d); }), long = D.map(function (x) { return longD(x.d); });\n    var sum = function (f) { return D.reduce(function (a, x) { return a + x[f]; }, 0); };\n    out.textContent = '';\n    var live = document.getElementById('live');\n    live.hidden = false; live.lastChild.textContent = st.live + (st.live === 1 ? ' person on now' : ' people on now');\n\n    var tiles = h('div', { cls: 'tiles' });\n    tiles.appendChild(tile('Visitors today', fmtN(today.visitors), 'Yesterday ' + fmtN(yest.visitors)));\n    tiles.appendChild(tile('Visits today', fmtN(today.visits), 'Yesterday ' + fmtN(yest.visits)));\n    tiles.appendChild(tile('Daily runs today', fmtN(today.runEnd), today.runEnd ? 'Average ' + today.avgScore.toFixed(1) + ' in a row' : 'Yesterday ' + fmtN(yest.runEnd)));\n    tiles.appendChild(tile('Shares today', fmtN(today.shareWa + today.shareCp), fmtN(today.arrivals) + ' arrived from shared links'));\n    tiles.appendChild(tile('Time per visitor', fmtMin(today.avgTime), 'Yesterday ' + fmtMin(yest.avgTime)));\n    tiles.appendChild(tile('New visitors, ' + n + ' days', fmtN(sum('fresh')), fmtN(st.everVisitors) + ' visitors ever'));\n    if (st.milestone && !seen()) {\n      var ban = h('div', { cls: 'milestone' }, [\n        h('div', {}, [h('b', { text: '100+ visitors two days running (reached ' + longD(st.milestone) + ').' }),\n          ' Time to file the UK trade mark for ORDO: classes 41 and 9, about \u00a3220 at GOV.UK \u201cApply to register a trade mark\u201d.']),\n        h('button', { type: 'button', text: 'Done' })]);\n      ban.lastChild.addEventListener('click', function () { try { localStorage.setItem('ordoStats.milestone', st.milestone); } catch (e) {} ban.remove(); });\n      out.appendChild(ban);\n    }\n    function seen() { try { return localStorage.getItem('ordoStats.milestone') === st.milestone; } catch (e) { return false; } }\n    out.appendChild(tiles);\n\n    var grid = h('div', { cls: 'grid' });\n    out.appendChild(grid);\n\n    var c1 = card('Visitors per day', 'Unique visitors, split into first-timers and people coming back.');\n    grid.appendChild(c1);\n    chartLater(c1, { kind: 'bar', stacked: true, labels: labels, long: long, aria: 'Visitors per day',\n      series: [{ name: 'New', color: '--s1', values: col('fresh') }, { name: 'Returning', color: '--s2', values: col('back') }],\n      extra: function (i) { return [fmtN(D[i].visits) + ' visits']; } });\n\n    var c2 = card('Plays per day', 'Daily runs finished, practice runs started, and Kids games started.');\n    grid.appendChild(c2);\n    chartLater(c2, { kind: 'line', labels: labels, long: long, aria: 'Plays per day',\n      series: [{ name: 'Daily runs', color: '--s1', values: col('runEnd') }, { name: 'Practice', color: '--s2', values: col('practice') }, { name: 'Kids', color: '--s3', values: col('kidsGames') }],\n      extra: function (i) { return D[i].runEnd ? ['Average run ' + D[i].avgScore.toFixed(1) + (D[i].relaxed ? ' \u00b7 ' + D[i].relaxed + ' relaxed' : '') + (D[i].runLeft ? ' \u00b7 ' + D[i].runLeft + ' left mid-run' : '')] : []; } });\n\n    var c3 = card('Shares per day', 'Taps on WhatsApp and Copy, and visits that came in through a shared link.');\n    grid.appendChild(c3);\n    chartLater(c3, { kind: 'line', labels: labels, long: long, aria: 'Shares per day',\n      series: [{ name: 'WhatsApp', color: '--s1', values: col('shareWa') }, { name: 'Copy', color: '--s2', values: col('shareCp') }, { name: 'Arrivals', color: '--s3', values: col('arrivals') }] });\n\n    var c4 = card('Time on site', 'Average time per visitor each day, counting only while the page is on screen.');\n    grid.appendChild(c4);\n    chartLater(c4, { kind: 'line', labels: labels, long: long, aria: 'Average time per visitor', fmt: function (m) { return fmtMin(m * 60); },\n      axisFmt: function (v) { return (v % 1 ? v.toFixed(1) : v) + 'm'; },\n      series: [{ name: 'Per visitor', color: '--s1', values: D.map(function (x) { return x.avgTime / 60; }) }] });\n\n    // Run lengths over the last 7 days.\n    var hist = {}, hmax = 0;\n    st.scores.forEach(function (r) { var k = Math.min(30, r.n || 0); hist[k] = (hist[k] || 0) + r.c; hmax = Math.max(hmax, k); });\n    var c5 = card('How far people get', 'Daily run lengths over the last 7 days (30 means 30 or more).');\n    grid.appendChild(c5);\n    var hl = [], hv = [];\n    for (var k = 0; k <= Math.max(10, hmax); k++) { hl.push(String(k)); hv.push(hist[k] || 0); }\n    chartLater(c5, { kind: 'bar', labels: hl, long: hl.map(function (x) { return x + ' in a row'; }), aria: 'Run lengths', series: [{ name: 'Runs', color: '--s1', values: hv }] });\n\n    var c6 = card('Where visitors came from', 'Last 7 days, by visit.');\n    grid.appendChild(c6);\n    ranks(c6, st.sources.map(function (r) { return { name: SRC[r.src] || r.src, c: r.c }; }));\n\n    var c7 = card('Countries', 'Last 7 days, by visit.');\n    grid.appendChild(c7);\n    ranks(c7, st.countries.map(function (r) { return { name: ccName(r.cc), c: r.c }; }));\n\n    var c8 = card('Pages and devices', 'Visits to each page in this period; devices by visit over the last 7 days.');\n    grid.appendChild(c8);\n    ranks(c8, [{ name: 'Daily game', c: sum('home') }, { name: 'Ordo Kids', c: sum('kids') }, { name: 'Classic', c: sum('classic') }]);\n    ranks(c8, st.devices.map(function (r) { return { name: r.dev ? r.dev[0].toUpperCase() + r.dev.slice(1) : 'Unknown', c: r.c }; }));\n\n    // Every number, by day.\n    var det = h('details', {}, [h('summary', { text: 'All numbers by day' })]);\n    var cols = [['Day', function (x) { return longD(x.d); }], ['Visitors', 'visitors'], ['New', 'fresh'], ['Visits', 'visits'], ['Daily runs', 'runEnd'],\n      ['Avg run', function (x) { return x.runEnd ? x.avgScore.toFixed(1) : '\u2013'; }], ['Relaxed', 'relaxed'], ['Practice', 'practice'], ['Kids', 'kidsGames'],\n      ['WhatsApp', 'shareWa'], ['Copy', 'shareCp'], ['Arrivals', 'arrivals'], ['Boards', 'boards'], ['Time/visitor', function (x) { return fmtMin(x.avgTime); }]];\n    var tb = h('table', {}, [h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { text: c[0] }); }))])]);\n    var body = h('tbody');\n    D.slice().reverse().forEach(function (x) { body.appendChild(h('tr', {}, cols.map(function (c) { return h('td', { text: typeof c[1] === 'function' ? c[1](x) : fmtN(x[c[1]]) }); }))); });\n    tb.appendChild(body); det.appendChild(h('div', { cls: 'tw' }, [tb])); out.appendChild(det);\n    out.appendChild(h('p', { cls: 'note', text: 'Days run midnight to midnight, London time. Visitors are browsers, so one person on a phone and a laptop counts twice. ' +\n      'Counting started ' + (st.first ? longD(st.first) : 'today') + '. Visit ordogame.com/?notrack on your own devices to leave yourself out.' }));\n    queue.forEach(function (q) { chart(q[0], q[1]); });\n    document.getElementById('updated').textContent = 'Updated ' + new Date(st.now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });\n  }\n\n  function load() {\n    document.querySelectorAll('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.days === days)); });\n    fetch('/api/stats?days=' + days + '&key=' + encodeURIComponent(key), { cache: 'no-store' })\n      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })\n      .then(function (st) { data = st; render(); })\n      .catch(function () { out.textContent = ''; out.appendChild(h('div', { cls: 'err', text: 'Couldn\u2019t load the numbers. Check the link has the right key.' })); });\n  }\n  document.querySelectorAll('.seg button').forEach(function (b) {\n    b.addEventListener('click', function () { days = +b.dataset.days; try { localStorage.setItem('ordoStats.days', days); } catch (e) {} load(); });\n  });\n  var rt = 0;\n  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (data) render(); }, 150); });\n  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (data) render(); });\n  setInterval(load, 5 * 60e3);\n  load();\n})();\n<\/script>\n<\/body>\n<\/html>\n";

export default {
  async fetch(req, env, ctx) {
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
      if (req.method === 'GET' && (url.pathname === '/api/board' || url.pathname === '/' || url.pathname === '/api/cdboard')) {
        const day = parseInt(url.searchParams.get('day') || todayNo(), 10);
        if (!Number.isInteger(day) || day < 1) return bad('day');
        const pid = url.searchParams.get('pid'), mine = okPid(pid) ? pid : '';
        const data = url.pathname === '/api/cdboard' ? await cdBoard(db, day, mine, url.searchParams.get('relaxed') === '1') : await board(db, day, mine);
        return json(data, 200, { 'Cache-Control': mine ? 'no-store' : 'public, max-age=30' });
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        if (!env.STATS_KEY || !sameKey(url.searchParams.get('key'), env.STATS_KEY)) return json({ error: 'Not found' }, 404);
        const days = Math.min(400, Math.max(7, parseInt(url.searchParams.get('days') || '30', 10) || 30));
        return json(await cached('stats:' + days, 5 * 60e3, () => stats(db, days)), 200, { 'Cache-Control': 'no-store' });
      }
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
      let body;
      try { body = JSON.parse(await req.text()); } catch { return bad('json'); }

      if (url.pathname === '/api/ev') {
        const e = body || {};
        if (!okId(e.vid) || !okId(e.sid)) return bad('event');
        // A bundle of events from one page, or a single event.
        const list = (Array.isArray(e.ev) ? e.ev : [e]).filter(x => x && EV_TYPES.has(x.t)).slice(0, 25);
        if (!list.length) return bad('event');
        const ua = req.headers.get('User-Agent') || '';
        const dev = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'computer';
        const now = Date.now(), d = londonDay(now), cc = (req.cf && req.cf.country) || '', src = short(e.src, 40) || 'direct', pg = short(e.pg, 10);
        const put = db.prepare('INSERT INTO ev (ts, d, vid, sid, pg, t, v, n, src, cc, dev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)');
        await db.batch(list.map(x => put.bind(now, d, e.vid, e.sid, pg, x.t, short(x.v, 24),
          Number.isFinite(x.n) ? Math.max(-1, Math.min(100000, Math.round(x.n))) : null, src, cc, dev)));
        maybeRollUp(db, ctx);
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
        const rx = body.relaxed === true;
        const res = await saveRun(db, day, pid, score, rx);
        return json({ ...res, board: await cdBoard(db, day, pid, rx) });
      }
      if (url.pathname === '/api/cdname') {
        const name = cleanName(body.name);
        if (!name) return bad('name');
        // One name for this player on both clocks' boards.
        const res = await db.batch([
          db.prepare('UPDATE cd SET name = ?3 WHERE day IN (?1, ?4) AND pid = ?2').bind(day, pid, name, day + RELAXED_DAY),
          db.prepare('UPDATE cdbest SET name = ?2 WHERE pid = ?1').bind(pid, name),
          db.prepare('UPDATE cdbest_r SET name = ?2 WHERE pid = ?1').bind(pid, name)
        ]);
        if (!res.some(r => r.meta.changes)) return json({ error: 'No score to name' }, 404);
        forget('cd:');
        return json({ name, board: await cdBoard(db, day, pid, body.relaxed === true) });
      }
      if (url.pathname === '/api/name') {
        const name = cleanName(body.name);
        if (!name) return bad('name');
        const r = await db.prepare('UPDATE scores SET name = ?3 WHERE day = ?1 AND pid = ?2').bind(day, pid, name).run();
        if (!r.meta.changes) return json({ error: 'No score to name' }, 404);
        forget('b:');
        return json({ name, board: await board(db, day, pid) });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error' }, 500);
    }
  }
};
