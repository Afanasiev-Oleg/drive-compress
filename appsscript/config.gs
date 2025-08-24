/** === CONFIG (Drive Video Auditor) ===
 * Требуется: в Script Properties задать ключ GH_PAT (GitHub Personal Access Token)
 *   Extensions → Apps Script → Project Settings → Script properties
 *   Key: GH_PAT, Value: <твой токен>
 */

// ===== Листы =====
const SHEET_CONFIG = 'Config';
const SHEET_VIDEOS = 'Videos';
const SHEET_LOG    = 'Log';   // для табличных логов (опционально используется)

// ===== GitHub repository_dispatch (ВАЖНО: GH_REPO = ИМЯ, не URL) =====
const GH_OWNER = 'Afanasiev-Oleg';
const GH_REPO  = 'drive-compress'; // из https://github.com/Afanasiev-Oleg/drive-compress.git
const SA_EMAIL = 'drive-compressor@drive-video-compressor.iam.gserviceaccount.com';

// ===== Пороги рекомендаций (skip / normal / aggressive) =====
const NORMAL_HEIGHT = 720;    // >720 → хотя бы normal
const AGGR_HEIGHT   = 1080;   // >1080 → aggressive

const MBPM_SKIP_MAX   = 16;   // <16 MB/мин → skip
const MBPM_NORMAL_MIN = 22;   // 22–35     → normal
const MBPM_AGGR_MIN   = 35;   // ≥35       → aggressive

// Если duration нет, предполагаем 40–60 сек
const ASSUMED_MIN_SEC = 40;
const ASSUMED_MAX_SEC = 60;

// Пороги по РАЗМЕРУ для файлов без duration (оценка 40–60 с)
const UNKNOWN_SIZE_THRESHOLD_NORMAL_MB =
  Math.round(MBPM_NORMAL_MIN * (ASSUMED_MAX_SEC/60) * 10) / 10; // ≈ 22.0 MB
const UNKNOWN_SIZE_THRESHOLD_AGGR_MB =
  Math.round(MBPM_AGGR_MIN * (ASSUMED_MIN_SEC/60) * 10) / 10;   // ≈ 23.3 MB

// Целевые MB/мин для оценки нового размера (EstNewSizeMB)
const TARGET_MBPM_NORMAL = 18;
const TARGET_MBPM_AGGR   = 10;

// ===== Range-пробивка (HTTP Range) =====
const RANGE_HEAD_BYTES = 512 * 1024;        // первые ~512 КБ
const RANGE_TAIL_BYTES_STEP1 = 2 * 1024 * 1024;  // хвост 2 МБ (первый проход)
const RANGE_TAIL_BYTES_STEP2 = 8 * 1024 * 1024;  // хвост 8 МБ (повтор)
const RANGE_ALLOWED_MIME = ['video/mp4', 'video/quicktime'];
const RANGE_SLEEP_MS = 120;                 // пауза между файлами
const RANGE_RESUME_DELAY_MS = 60000;        // задержка перед автопродолжением (≈60–120 с фактически)
const RANGE_MAX_MS = 270000;                // максимум ~4.5 мин на запуск

// Продолжение пачек: курсор абсолютной строки и флаг отложенного запуска
const PROP_RANGE_ROW        = 'RANGE_ROW';          // 2-based (строка A2=2)
const PROP_RANGE_SCHEDULED  = 'RANGE_SCHEDULED';    // '1' если триггер поставлен
const PROP_RANGE_STOP       = 'RANGE_STOP';         // '1' если запрошена остановка Range

// ===== Маппинг колонок (1-based) — Порядок ДОЛЖЕН совпадать со шапкой листа Videos =====
// Path перед Name (как договорено)
const COL = {
  FileId:1, Path:2, Name:3, MimeType:4, SizeMB:5, DurationSec:6, MBperMin:7,
  Width:8, Height:9, ModifiedTime:10, NeedCompress:11, HasOldRevisions:12,
  Recommend:13, Why:14, Action:15, EstNewSizeMB:16, EstSavingsMB:17,
  MarkDeleteRevisions:18, Status:19
};

// ===== Форматирование и утилиты =====

// Формат ISO → человекочитаемо, например 05.12.2022 19:28
function formatIso_(iso) {
  if (!iso) return '';
  try {
    return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
  } catch (e) { return iso; }
}

// 1-based номер колонки → буква A1 (1->A, 19->S)
function toA1Col_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Округления
function round1_(x){ return (x==null||x==='') ? '' : Math.round(Number(x)*10)/10; }
function round2_(x){ return (x==null||x==='') ? '' : Math.round(Number(x)*100)/100; }

// Получить/создать лист по имени
function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Прочитать FolderId из листа Config (колонка A со 2-й строки)
function readFolderIds_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CONFIG);
  if (!sh) throw new Error('Нет листа Config');
  const vals = sh.getRange(2,1,Math.max(0, sh.getLastRow()-1),1).getValues()
    .map(r => String(r[0]||'').trim()).filter(Boolean);
  if (!vals.length) throw new Error('В Config нет FolderId');
  return vals;
}

// Гарантированно выставляет фильтр на первых numCols колонок, не дублируя его
function ensureFilter_(sh, numCols) {
  const rows = Math.max(2, sh.getLastRow()); // минимум: заголовок + 1 строка
  const want = sh.getRange(1, 1, rows, numCols);
  const f = sh.getFilter();
  if (!f) { want.createFilter(); return; }
  const cur = f.getRange();
  if (cur.getNumColumns() !== numCols || cur.getNumRows() !== rows
      || cur.getRow() !== 1 || cur.getColumn() !== 1) {
    f.remove();
    want.createFilter();
  }
}

// Удалить все таймер-триггеры с заданным обработчиком
function deleteTriggersByHandler_(name){
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === name) ScriptApp.deleteTrigger(t);
  });
}

// ===== GitHub токен из Script Properties =====
function getGithubToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('GH_PAT');
  if (!t) throw new Error('Нет Script Property GH_PAT');
  return t;
}

// ===== Табличное логирование (опционально; вызывается только если есть logEvent_) =====
const LOG_VERBOSE = true;
const LOG_MAX_ROWS = 3000;

function ensureLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_LOG);
    sh.appendRow(['Time','Event','File ID','Name','Action','Detail','Extra']);
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, 7, 220);
    // Оформление заголовка (жирный, по центру)
    sh.getRange(1, 1, 1, 7).setFontWeight('bold').setHorizontalAlignment('center');
  }
  return sh;
}

function logEvent_(event, {fileId='', name='', action='', detail='', extra=''} = {}) {
  try {
    const sh = ensureLogSheet_();
    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
    sh.appendRow([ts, event, fileId, name, action, detail, extra]);

    // кольцевой буфер
    const lr = sh.getLastRow();
    if (lr > LOG_MAX_ROWS) {
      const toDel = lr - LOG_MAX_ROWS;
      sh.deleteRows(2, Math.min(toDel, LOG_MAX_ROWS)); // оставляем заголовок
    }
  } catch (e) {
    console.log('logEvent_ ERR: ' + (e && e.message || e));
  }
}

// Включение извлечения Width/Height в режиме Range: читаем Config!B2 (Y/N)
function isRangeWHEnabled_() {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CONFIG);
    if (!sh) return false;
    const v = String(sh.getRange(2, 2).getValue() || '').trim().toUpperCase();
    return v === 'Y' || v === 'YES' || v === 'TRUE' || v === 'ON' || v === '1';
  } catch (_) {
    return false;
  }
}
