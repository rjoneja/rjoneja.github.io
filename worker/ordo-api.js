// Ordo scores API: a Cloudflare Worker with one D1 database bound as DB.
// Endpoints (all JSON, open CORS):
//   POST /api/play   {day, pid}              count a player for today's puzzle
//   POST /api/score  {day, pid, score}       record a finished daily (first result per player per day only)
//   POST /api/name   {day, pid, name}        put a name on that result
//   GET  /api/board?day=N&pid=X              players today and ever, top 5 today and all time
//   POST /api/cd     {day, pid, score}       a Countdown run (keeps each player's best per day)
//   POST /api/cdname {day, pid, name}        put a name on that player's Countdown scores
//   GET  /api/cdboard?day=N&pid=X            Countdown top 5 today and all time (one entry per player)
// pid is a random ID the game makes on each device. It is never sent back out.

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
  'CREATE INDEX IF NOT EXISTS cd_by_best ON cd (best DESC, ts)'
];
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

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url), db = env.DB;
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
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
      let body;
      try { body = await req.json(); } catch { return bad('json'); }
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
