const SYNC_HEADERS = [
  'id', 'date', 'no', 'name', 'address', 'phone', 'type', 'status', 'phase',
  'size', 'inPhase', 'pole', 'route', 'note', 'src', 'reason', '_revision', '_sync_status'
];

function syncProperties_() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    token: properties.getProperty('SYNC_TOKEN'),
    spreadsheetId: properties.getProperty('SPREADSHEET_ID'),
    sheetName: properties.getProperty('SHEET_NAME'),
    serverUrl: properties.getProperty('SERVER_URL')
  };
  if (!config.token || !config.spreadsheetId || !config.sheetName || !config.serverUrl) {
    throw new Error('กรุณาตั้งค่า SYNC_TOKEN, SPREADSHEET_ID, SHEET_NAME และ SERVER_URL ใน Script Properties');
  }
  return config;
}

function syncSheet_() {
  const config = syncProperties_();
  const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  let sheet = spreadsheet.getSheetByName(config.sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(config.sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SYNC_HEADERS.length).setValues([SYNC_HEADERS]);
    sheet.setFrozenRows(1);
  }
  const actual = sheet.getRange(1, 1, 1, SYNC_HEADERS.length).getDisplayValues()[0];
  if (SYNC_HEADERS.some((header, index) => actual[index] !== header)) {
    throw new Error('หัวคอลัมน์ในแท็บซิงก์ไม่ตรง กรุณาใช้แท็บว่างสำหรับการซิงก์');
  }
  return { config, sheet };
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function upsertSheetRow_(sheet, row) {
  const idColumn = SYNC_HEADERS.indexOf('id') + 1;
  const ids = sheet.getLastRow() > 1
    ? sheet.getRange(2, idColumn, sheet.getLastRow() - 1, 1).getDisplayValues().flat()
    : [];
  const existingIndex = ids.indexOf(String(row.id));
  const targetRow = existingIndex < 0 ? Math.max(2, sheet.getLastRow() + 1) : existingIndex + 2;
  const values = SYNC_HEADERS.map(header => {
    if (header === '_sync_status') return '';
    return row[header] == null ? '' : row[header];
  });
  sheet.getRange(targetRow, 1, 1, SYNC_HEADERS.length).setValues([values]);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const config = syncProperties_();
    const request = JSON.parse(e.postData.contents || '{}');
    if (request.token !== config.token) return jsonResponse_({ ok: false, error: 'token ไม่ถูกต้อง' });
    if (request.action !== 'upsert' || !request.row || !request.row.id) {
      return jsonResponse_({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง' });
    }
    const { sheet } = syncSheet_();
    upsertSheetRow_(sheet, request.row);
    return jsonResponse_({ ok: true, id: String(request.row.id) });
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message || 'ซิงก์ข้อมูลไม่สำเร็จ' });
  } finally {
    lock.releaseLock();
  }
}

function setupSheetSync() {
  const { config, sheet } = syncSheet_();
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'onSyncedSheetEdit')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('onSyncedSheetEdit')
    .forSpreadsheet(config.spreadsheetId)
    .onEdit()
    .create();
  sheet.hideColumns(SYNC_HEADERS.indexOf('_revision') + 1, 1);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Supabase')
    .addItem('โหลดข้อมูลจาก Supabase', 'syncAllFromServer')
    .addToUi();
}

function syncAllFromServer() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { config, sheet } = syncSheet_();
    const response = UrlFetchApp.fetch(config.serverUrl.replace(/\/$/, '') + '/api/sheets-sync/export', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ token: config.token }),
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText() || '{}');
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result.ok) {
      throw new Error(result.error || 'โหลดข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ');
    }
    result.rows.forEach(row => upsertSheetRow_(sheet, row));
    return result.rows.length;
  } finally {
    lock.releaseLock();
  }
}

function onSyncedSheetEdit(e) {
  if (!e || !e.range || e.range.getRow() < 2) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let sheet;
  let rowNumber;
  try {
    const { config, sheet: syncSheet } = syncSheet_();
    sheet = syncSheet;
    if (e.range.getSheet().getSheetId() !== sheet.getSheetId()) return;
    rowNumber = e.range.getRow();
    if (e.range.getColumn() > SYNC_HEADERS.length) return;

    const values = sheet.getRange(rowNumber, 1, 1, SYNC_HEADERS.length).getValues()[0];
    const timezone = sheet.getParent().getSpreadsheetTimeZone();
    const row = {};
    SYNC_HEADERS.forEach((header, index) => {
      let value = values[index];
      if (header === 'date' && value instanceof Date) {
        value = Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
      } else if (value instanceof Date) {
        value = Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
      }
      row[header] = value == null ? '' : String(value).trim();
    });
    if (!row.date && !row.type && !row.name) return;
    if (!row.id && row.date && row.type) {
      row.id = Utilities.getUuid();
      sheet.getRange(rowNumber, 1).setValue(row.id);
    }

    const response = UrlFetchApp.fetch(config.serverUrl.replace(/\/$/, '') + '/api/sheets-sync', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ token: config.token, row: row }),
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText() || '{}');
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result.ok) {
      throw new Error(result.error || 'เซิร์ฟเวอร์ปฏิเสธการซิงก์');
    }
    sheet.getRange(rowNumber, 1).setValue(result.id || row.id);
    if (result.no) sheet.getRange(rowNumber, SYNC_HEADERS.indexOf('no') + 1).setValue(result.no);
    sheet.getRange(rowNumber, SYNC_HEADERS.indexOf('_revision') + 1).setValue(result.revision);
    sheet.getRange(rowNumber, SYNC_HEADERS.indexOf('_sync_status') + 1).setValue('ซิงก์แล้ว');
  } catch (error) {
    if (sheet && rowNumber) {
      sheet.getRange(rowNumber, SYNC_HEADERS.indexOf('_sync_status') + 1)
        .setValue('รอแก้ไข: ' + String(error.message || error).slice(0, 180));
    }
    console.error('Google Sheets edit sync failed:', error);
  } finally {
    lock.releaseLock();
  }
}
