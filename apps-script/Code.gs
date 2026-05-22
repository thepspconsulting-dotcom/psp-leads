/**
 * PSP Lead Capture — Google Apps Script bridge
 * --------------------------------------------------------------
 * Receives JSON entries from the PWA and upserts them into the
 * connected Google Sheet by `id`. Re-syncs (e.g. WhatsApp status
 * updates) overwrite the existing row.
 *
 * SETUP — see README.md, section "Google Apps Script setup".
 * --------------------------------------------------------------
 */

const SHEET_TAB = 'Entries';        // change if you renamed the tab
const HEADERS = [
  'ID',
  'Timestamp',
  'Name',
  'Position',
  'Company',
  'Mobile Number',
  'Email Address',
  'Address',
  'Remarks',
  'Recruitment Selected',
  'Consulting Selected',
  'WhatsApp Sent Status',
  'Saved Contact Status',
  'Event',
  'Last Updated'
];

/** Health check — GET ?ping=1 */
function doGet(e) {
  const out = { ok: true, app: 'PSP Lead Capture', time: new Date().toISOString() };
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Receive entry from PWA */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _json({ ok: false, error: 'No payload' });
    }
    const body = JSON.parse(e.postData.contents);
    if (!body.id) return _json({ ok: false, error: 'Missing id' });

    const sheet = _getSheet();
    const row = [
      body.id,
      body.timestamp || new Date().toISOString(),
      body.name || '',
      body.position || '',
      body.company || '',
      body.mobile || '',
      body.email || '',
      body.address || '',
      body.remarks || '',
      body.recruitment || 'No',
      body.consulting || 'No',
      body.whatsappSent || 'No',
      body.contactSaved || 'No',
      body.event || '',
      new Date().toISOString()
    ];

    // Upsert by ID (column A)
    const existingRow = _findRowById(sheet, body.id);
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    return _json({ ok: true, id: body.id, action: existingRow > 0 ? 'updated' : 'inserted' });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

/** Lazy-init: create the sheet/header row if missing */
function _getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_TAB);
  if (!sheet) sheet = ss.insertSheet(SHEET_TAB);
  // Make sure header row matches
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const headerMissing = HEADERS.some((h, i) => firstRow[i] !== h);
  if (headerMissing) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length)
         .setFontWeight('bold')
         .setBackground('#1B3668')
         .setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, HEADERS.length);
  }
  return sheet;
}

/** Returns row number (1-based) or 0 if not found. */
function _findRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return 0;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
