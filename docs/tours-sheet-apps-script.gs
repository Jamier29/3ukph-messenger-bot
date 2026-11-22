/**
 * 3UK x TripHappy tracker: receives tour requests from 3ukph.com/tours
 * and adds them to the "Referrals" tab as new rows (status "Inquiry").
 *
 * Setup (once, on a computer):
 *  1. Open the tracker sheet > Extensions > Apps Script.
 *  2. Delete what's there, paste this whole file, and replace PASTE_YOUR_SECRET_HERE
 *     with a long secret phrase you make up (no spaces, e.g. 20+ letters and numbers).
 *  3. Save. Deploy > New deployment > type "Web app".
 *     Execute as: Me.  Who has access: Anyone.  Deploy, then Authorize access.
 *  4. Copy the Web app URL (starts with https://script.google.com/macros/s/...).
 *  5. In Render > Environment add:
 *       TOURS_SHEET_WEBHOOK = the Web app URL
 *       TOURS_SHEET_SECRET  = the same secret phrase as in step 2
 */
const SECRET = 'PASTE_YOUR_SECRET_HERE';

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const d = JSON.parse(e.postData.contents || '{}');
    if (!SECRET || SECRET === 'PASTE_YOUR_SECRET_HERE' || d.secret !== SECRET) return out({ ok: false, error: 'bad secret' });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sh = SpreadsheetApp.getActive().getSheetByName('Referrals');
      const colA = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
      let last = 0;
      for (let i = 0; i < colA.length; i++) {
        if (colA[i][0] !== '') last = i + 1;
        if (String(colA[i][0]) === String(d.ref)) return out({ ok: true, duplicate: true, row: i + 1 });
      }
      const row = last + 1;
      // A..K: Ref ID, Date referred, Guest name, Contact, Tour, Local/International, Travel date, Pax, Booking status, Amount, Commission %
      sh.getRange(row, 1, 1, 11).setValues([[d.ref, d.day, d.name, d.contact, d.tour, d.type || '', d.date, d.pax, 'Inquiry', '', '']]);
      // L is calculated by the sheet. M..O: Payout status, Payout date, Notes
      sh.getRange(row, 13, 1, 3).setValues([['Not yet due', '', d.notes || '']]);
      return out({ ok: true, row: row });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}
