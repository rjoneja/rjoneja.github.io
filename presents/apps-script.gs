// Backend for ordogame.com/presents: stores who is getting which present in this Google Sheet.
// Setup: open a new Google Sheet > Extensions > Apps Script, paste this file over the default code,
// then Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
// The web app URL (ending /exec) goes into API_URL at the top of presents/index.html.
//
// Endpoints (all GET, JSON):
//   ?action=list                          -> { claims: { id: { name } } }
//   ?action=claim&id=X&item=Label&name=N  -> { ok, claims } or { ok:false, error:"taken", claims }
//   ?action=unclaim&id=X&name=N           -> { ok, claims } (name must match the claim)
//
// You can also edit or delete rows in the "Claims" tab by hand.

const SHEET_NAME = 'Claims';

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

  if (action === 'list') return json_({ ok: true, claims: claims_(rows_(sh)) });

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
