// Backend for ordogame.com/presents: stores who is getting which present in this Google Sheet.
// Setup: open a new Google Sheet > Extensions > Apps Script, paste this file over the default code,
// then Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
// The web app URL (ending /exec) goes into API_URL at the top of presents/index.html.
//
// To update an existing deployment without changing its URL:
// Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
//
// Endpoints (all GET, JSON):
//   ?action=list                          -> { claims: { id: { name } }, suggestions: [ {id, name, for, link, by} ] }
//   ?action=claim&id=X&item=Label&name=N  -> { ok, claims } or { ok:false, error:"taken", claims }
//   ?action=unclaim&id=X&name=N           -> { ok, claims } (name must match the claim)
//   ?action=suggest&item=Label&for=albie|avani|&link=URL&by=N[&claim=1]  -> { ok, claims, suggestions }
//
// You can also edit or delete rows in the "Claims" and "Suggestions" tabs by hand.
// Delete a row in "Suggestions" to take that idea off the list.

const SHEET_NAME = 'Claims';
const SUGGEST_SHEET = 'Suggestions';
const MAX_SUGGESTIONS = 60;

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['Item ID', 'Item', 'Name', 'Claimed at']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function suggestSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SUGGEST_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SUGGEST_SHEET);
    sh.appendRow(['Item ID', 'Item', 'For', 'Link', 'Suggested by', 'Suggested at']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function suggestions_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 5).getValues()
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) {
      return { id: String(r[0]).trim(), name: String(r[1]).trim(), for: String(r[2]).trim().toLowerCase(), link: String(r[3]).trim(), by: String(r[4]).trim() };
    });
}

function cleanLink_(s) {
  const v = String(s || '').trim().slice(0, 500);
  return /^https?:\/\/[^\s<>"]+$/i.test(v) ? v : '';
}

function rows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 4).getValues();
}

function claims_(rows) {
  const out = {};
  rows.forEach(function (r) {
    const id = String(r[0]).trim();
    const name = String(r[2]).trim();
    if (id && name && !out[id]) out[id] = { name: name };
  });
  return out;
}

function clean_(s, max) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'list';
  const sh = sheet_();

  const ssh = suggestSheet_();

  if (action === 'list') return json_({ ok: true, claims: claims_(rows_(sh)), suggestions: suggestions_(ssh) });

  if (action === 'suggest') {
    const item = clean_(p.item, 80);
    const by = clean_(p.by, 40);
    const forKid = ['albie', 'avani'].indexOf(String(p['for'] || '').toLowerCase()) >= 0 ? String(p['for']).toLowerCase() : '';
    if (!item) return json_({ ok: false, error: 'Please say what the present is.' });
    if (!by) return json_({ ok: false, error: 'Please add your name.' });
    const lockS = LockService.getScriptLock();
    lockS.waitLock(10000);
    try {
      const list = suggestions_(ssh);
      if (list.length >= MAX_SUGGESTIONS) return json_({ ok: false, error: 'The list is full. Please message Raj instead.' });
      const dup = list.filter(function (s) { return s.name.toLowerCase() === item.toLowerCase(); })[0];
      if (dup) return json_({ ok: false, error: 'That one is already on the list.', claims: claims_(rows_(sh)), suggestions: list });
      const newId = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
      ssh.appendRow([newId, item, forKid, cleanLink_(p.link), by, new Date()]);
      if (p.claim === '1') sh.appendRow([newId, item, by, new Date()]);
      return json_({ ok: true, id: newId, claims: claims_(rows_(sh)), suggestions: suggestions_(ssh) });
    } finally {
      lockS.releaseLock();
    }
  }

  const id = clean_(p.id, 40);
  const name = clean_(p.name, 40);
  if (!id) return json_({ ok: false, error: 'Missing item.' });
  if (!name) return json_({ ok: false, error: 'Please add your name.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rows = rows_(sh);
    const current = claims_(rows);

    if (action === 'claim') {
      if (current[id]) return json_({ ok: false, error: 'taken', claims: current });
      sh.appendRow([id, clean_(p.item, 120), name, new Date()]);
      current[id] = { name: name };
      return json_({ ok: true, claims: current });
    }

    if (action === 'unclaim') {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]).trim() === id) {
          if (String(rows[i][2]).trim().toLowerCase() !== name.toLowerCase()) {
            return json_({ ok: false, error: 'Only the person who claimed this can undo it.', claims: current });
          }
          sh.deleteRow(i + 2);
          delete current[id];
          return json_({ ok: true, claims: current });
        }
      }
      return json_({ ok: true, claims: current });
    }

    return json_({ ok: false, error: 'Unknown action.' });
  } finally {
    lock.releaseLock();
  }
}
