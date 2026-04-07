/** === AUDIT (Drive v3 + Range-probe) ===
 * - Обновление списка (REST v3): рекурсивный обход папок; кликабельные Path/Name
 * - Добор duration через v3 get
 * - Range-пробивка duration (A2→A3…, head→tail 2MB→tail 8MB) с автопродолжением пачками
 * - Recommend/Action, ревизии, экспорт CSV
 * Требуется включить Advanced Google Services → Drive API (для Revisions/Permissions).
 */

// Меню
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🎬 Видео утилиты')
    .addItem('Обновить список (v3 list)', 'cmdRefresh')
    .addItem('Добрать длительность (v3 get — быстрый)', 'cmdEnrichDurations')
    .addItem('Добрать длительность (Range — надёжный)', 'cmdProbeDurationsRange')
    .addSeparator()
    .addItem('Автомаркировка Recommend', 'cmdAutoRecommend')
    .addItem('Применить Recommend → Action', 'cmdApplyRecommend')
    .addSeparator()
    .addItem('Проверить ревизии', 'cmdCheckRevisions')
    .addItem('Удалить отмеченные ревизии', 'cmdDeleteMarkedRevisions')
    .addSeparator()
    .addItem('Экспортировать задачи (CSV)', 'cmdExportCompressionCSV')
    .addItem('Очистить логи', 'cmdClearLogSheet')
    .addItem('Сбросить курсор Range', 'cmdResetRangeCursor')
    .addItem('Остановить Range-пробивку', 'cmdStopRange')
    .addItem('Отправить задачи в GitHub Actions', 'cmdRepositoryDispatchBatch')
    .addToUi();
}

// Backward-compat старого пункта меню
function cmdAutoMarkCompress() { return cmdAutoRecommend(); }

/** ---------- Обновление списка (v3 list) ---------- */
function cmdRefresh() {
  const sh = getOrCreateSheet_(SHEET_VIDEOS);

  // СБРОС СОСТОЯНИЯ RANGE, чтобы следующий запуск шёл с A2
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_RANGE_ROW);
  props.deleteProperty(PROP_RANGE_SCHEDULED);
  deleteTriggersByHandler_('cmdProbeDurationsRange');

  // Сброс содержимого
  sh.clearContents();

  // ВСТАВИТЬ: уберём ручной фон из колонки DurationSec (на случай оставшегося индикатора)
  // Снять возможную ручную заливку «Паузы» из DurationSec
  if (sh.getMaxRows() > 1) {
    sh.getRange(2, COL.DurationSec, sh.getMaxRows() - 1, 1).setBackground(null);
  }

  // Шапка (Path перед Name — как договорились)
  sh.appendRow([
    'File ID','Path','Name','MIME Type','Size MB','Duration Sec','MBperMin',
    'Width','Height','Modified Time','Need Compress','Has Old Revisions',
    'Recommend','Why','Action','Est. New Size MB','Est. Savings MB','Delete Old Revisions (Y/N)','Status'
  ]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, COL.Status).setHorizontalAlignment('center');

  const folderIds = readFolderIds_();
  const files = [];
  const seen = {};
  const recursive = isRecursiveScanEnabled_();
  for (let i = 0; i < folderIds.length; i++) {
    if (recursive) listVideosRecursiveV3_(folderIds[i], files, seen);
    else           listVideosSingleFolderV3_(folderIds[i], files, seen);
  }

  const rows = files.map(f => {
    const sizeMB = f.size ? (Number(f.size)/(1024*1024)) : '';
    const durSec = f.videoMediaMetadata && f.videoMediaMetadata.durationMillis
      ? Math.round(Number(f.videoMediaMetadata.durationMillis)/1000) : '';
    const w = f.videoMediaMetadata ? (f.videoMediaMetadata.width  || '') : '';
    const h = f.videoMediaMetadata ? (f.videoMediaMetadata.height || '') : '';
    const mbpmNum = (sizeMB && durSec) ? sizeMB*(60/durSec) : '';
    const mbpmDisp = (mbpmNum!=='')
      ? round1_(mbpmNum)
      : (sizeMB ? ('~'+round1_(sizeMB)+'–'+round1_(sizeMB*(ASSUMED_MAX_SEC/ASSUMED_MIN_SEC))) : '');

    const need = decideNeedCompress_(h, (mbpmNum||''), sizeMB, durSec) ? 'Y' : '';
    const statusNote = (!durSec && need==='Y') ? 'Assumed by size (40–60s)' : '';

    // Кликовые Path/Name
    const parentId = (f.parents && f.parents.length) ? f.parents[0] : '';
    const pathText = resolvePathV3_(f);
    const pathCell = parentId
      ? `=HYPERLINK("https://drive.google.com/drive/folders/${parentId}","${escQ_(pathText)}")`
      : pathText;
    const nameCell = `=HYPERLINK("https://drive.google.com/file/d/${f.id}/view","${escQ_(f.name)}")`;

    return [
      f.id, pathCell, nameCell, f.mimeType, round2_(sizeMB), durSec, mbpmDisp,
      w, h, formatIso_(f.modifiedTime),
      need, '', '', '', 'none', '', '', '', statusNote
    ];
  });

  if (rows.length) sh.getRange(2,1,rows.length, rows[0].length).setValues(rows);
  setupFormattingAndValidation_(sh);

  // Итоги под таблицей
  if (rows.length) {
    var totalsRow = rows.length + 3;
    var sumSize = 0;
    var sumEstNew = 0;
    var sumEstSavings = 0;

    for (var i = 0; i < rows.length; i++) {
      sumSize += Number(rows[i][COL.SizeMB - 1]) || 0;
      sumEstNew += Number(rows[i][COL.EstNewSizeMB - 1]) || 0;
      sumEstSavings += Number(rows[i][COL.EstSavingsMB - 1]) || 0;
    }

    sh.getRange(totalsRow, COL.SizeMB).setValue(round2_(sumSize));
    sh.getRange(totalsRow, COL.EstNewSizeMB).setValue(round2_(sumEstNew));
    sh.getRange(totalsRow, COL.EstSavingsMB).setValue(round2_(sumEstSavings));

    sh.getRange(totalsRow, COL.SizeMB, 1, 1).setFontWeight('bold');
    sh.getRange(totalsRow, COL.EstNewSizeMB, 1, 1).setFontWeight('bold');
    sh.getRange(totalsRow, COL.EstSavingsMB, 1, 1).setFontWeight('bold');
  }

  if (typeof logEvent_ === 'function') logEvent_('refresh', {detail: 'rows='+rows.length});
}

/** ---------- Добор duration через v3 get ---------- */
function cmdEnrichDurations() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr<2) return;

  if (typeof logEvent_ === 'function') logEvent_('v3get-start');

  const ids = sh.getRange(2, COL.FileId, lr-1, 1).getValues().map(r=>r[0]);
  for (let i=0;i<ids.length;i++){
    const r = 2+i;
    const fileId = ids[i]; 
    if (!fileId) continue;
    const durCell = sh.getRange(r, COL.DurationSec).getValue();
    if (durCell) continue;

    try {
      try { sh.getRange(r, COL.DurationSec).setValue('⏳ get…').setBackground('#FFF3CD'); } catch(_) {}

      const f = driveV3GetFile_(fileId, 'id,name,size,modifiedTime,videoMediaMetadata(width,height,durationMillis)');

      try {
        const cell = sh.getRange(r, COL.DurationSec);
        if (String(cell.getValue()) === '⏳ get…') cell.clearContent();
        cell.setBackground(null);
      } catch(_) {}

      const sizeMB = f.size ? (Number(f.size)/(1024*1024)) : '';
      const durSec = f.videoMediaMetadata && f.videoMediaMetadata.durationMillis
        ? Math.round(Number(f.videoMediaMetadata.durationMillis)/1000) : '';
      const w = f.videoMediaMetadata ? (f.videoMediaMetadata.width  || '') : '';
      const h = f.videoMediaMetadata ? (f.videoMediaMetadata.height || '') : '';
      const mbpmNum = (sizeMB && durSec) ? sizeMB*(60/durSec) : '';
      const mbpmDisp = (mbpmNum!=='') ? round1_(mbpmNum)
        : (sizeMB ? ('~'+round1_(sizeMB)+'–'+round1_(sizeMB*(ASSUMED_MAX_SEC/ASSUMED_MIN_SEC))) : '');

      sh.getRange(r, COL.DurationSec).setValue(durSec);
      sh.getRange(r, COL.Width).setValue(w);
      sh.getRange(r, COL.Height).setValue(h);
      sh.getRange(r, COL.MBperMin).setValue(mbpmDisp);

      const need = decideNeedCompress_(h, (mbpmNum||''), sizeMB, durSec) ? 'Y' : '';
      sh.getRange(r, COL.NeedCompress).setValue(need);
      if (!durSec && need==='Y') {
        sh.getRange(r, COL.Status).setValue('Assumed by size (40–60s)');
      }
      if (durSec && typeof logEvent_ === 'function') logEvent_('v3get-ok', {fileId: f.id, name: f.name, detail: 'dur='+durSec});
    } catch(e){
      sh.getRange(r, COL.Status).setValue('GET ERR: '+e.message);
      if (typeof logEvent_ === 'function') logEvent_('v3get-err', {fileId, detail: String(e && e.message || e)});
    }
  }
}

/** ---------- Автомаркировка/применение рекомендаций ---------- */
function cmdAutoRecommend() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr<2) return;

  const rng = sh.getRange(2,1,lr-1, COL.Status).getValues();
  for (let i=0;i<rng.length;i++){
    const row = rng[i];
    const sizeMB = Number(row[COL.SizeMB-1] || 0);
    const durSec = Number(row[COL.DurationSec-1] || 0);
    const mbpmStr = row[COL.MBperMin-1];
    const mbpmNum = (durSec && sizeMB) ? sizeMB*(60/durSec) : (isFinite(parseFloat(mbpmStr))?parseFloat(mbpmStr):'');
    const h = Number(row[COL.Height-1] || 0);

    const rec = recommendProfile_(h, mbpmNum, sizeMB, durSec);
    const why = explainWhy_(h, mbpmNum, sizeMB, durSec, rec);
    const need = (rec==='skip') ? '' : 'Y';
    const est = estimateNewSizeMB_(rec, durSec);
    const savings = (est!=='' && sizeMB) ? Math.max(0, round2_(sizeMB - est)) : '';

    const r = 2+i;
    sh.getRange(r, COL.Recommend).setValue(rec);
    sh.getRange(r, COL.Why).setValue(why);
    sh.getRange(r, COL.NeedCompress).setValue(need);
    sh.getRange(r, COL.EstNewSizeMB).setValue(est);
    sh.getRange(r, COL.EstSavingsMB).setValue(savings);
  }
}

function cmdApplyRecommend() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr<2) return;

  const recs = sh.getRange(2, COL.Recommend, lr-1, 1).getValues().map(r=>String(r[0]||''));
  const acts = sh.getRange(2, COL.Action, lr-1, 1).getValues().map(r=>String(r[0]||'none'));

  const out = acts.map((a,idx)=>{
    if (a && a!=='none') return [a]; // не перетираем ручное
    const r = recs[idx];
    if (r==='normal') return ['compress_normal'];
    if (r==='aggressive') return ['compress_aggressive'];
    return ['none'];
  });
  sh.getRange(2, COL.Action, lr-1, 1).setValues(out);
}

/** ---------- Ревизии и экспорт ---------- */
function cmdCheckRevisions() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr < 2) return;
  const ids = sh.getRange(2, COL.FileId, lr-1, 1).getValues().map(r=>r[0]).filter(Boolean);

  ids.forEach((fileId, idx) => {
    try {
      const revs = Drive.Revisions.list(fileId, {fields:'revisions(id,keepForever,modifiedTime)'}).revisions || [];
      sh.getRange(2+idx, COL.HasOldRevisions).setValue(revs.length>1?'Y':'');
      if (typeof logEvent_ === 'function') logEvent_('revisions-check', { fileId: fileId, detail: 'count=' + revs.length });
    } catch(e){
      sh.getRange(2+idx, COL.Status).setValue('REV ERR: '+e.message);
      if (typeof logEvent_ === 'function') logEvent_('revisions-check-err', { fileId: fileId, detail: String(e && e.message || e) });
    }
  });
}

function cmdDeleteMarkedRevisions() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr < 2) return;

  const rng = sh.getRange(2,1,lr-1, COL.Status).getValues();
  for (let i=0;i<rng.length;i++){
    const row = rng[i];
    const fileId = row[COL.FileId-1];
    const hasOld = row[COL.HasOldRevisions-1]==='Y';
    const markDel= String(row[COL.MarkDeleteRevisions-1]||'')==='Y';
    if (!fileId || !hasOld || !markDel) continue;
    try {
      const opt = { supportsAllDrives: true, supportsTeamDrives: true };
      const listOpt = { fields:'revisions(id,keepForever,modifiedTime)', supportsAllDrives:true, supportsTeamDrives:true };

      if (typeof logEvent_ === 'function') logEvent_('revisions-start', { fileId: fileId });

      // 1) Получить список ревизий
      var resp = Drive.Revisions.list(fileId, listOpt) || {};
      var revs = resp.revisions || resp.items || [];
      if (revs.length > 1) {
        // Сортируем по времени (старые → новые) по modifiedTime (если нет — считаем 0)
        revs.sort(function(a,b){
          var ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
          var tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
          return ta - tb;
        });
        // оставляем самую свежую (последнюю)
        const lastIdx = revs.length - 1;

        for (let r = 0; r < revs.length; r++) {
          if (r === lastIdx) continue; // пропускаем самую свежую
          const rev = revs[r];
          try {
            // если ревизия закреплена (keepForever), сначала снять
            if (rev.keepForever === true) {
              Drive.Revisions.update({ keepForever: false }, fileId, rev.id, opt);
              if (typeof logEvent_ === 'function') logEvent_('revisions-unpin', { fileId: fileId, rev: rev.id });
            }
            // удалить ревизию
            Drive.Revisions.remove(fileId, rev.id);
            if (typeof logEvent_ === 'function') logEvent_('revisions-del', { fileId: fileId, rev: rev.id });
          } catch (eDel) {
            if (typeof logEvent_ === 'function') logEvent_('revisions-err', { fileId: fileId, detail: String(eDel && eDel.message || eDel) });
          }
        }
      }

      // 2) Повторная проверка
      var resp2 = Drive.Revisions.list(fileId, listOpt) || {};
      var after = resp2.revisions || resp2.items || [];
      var afterCount = Math.max(0, after.length - 1);
      if (after.length <= 1) {
        sh.getRange(2+i, COL.Status).setValue('Revisions deleted');
      } else {
        sh.getRange(2+i, COL.Status).setValue('Revisions not deleted (remain: ' + afterCount + ')');
      }
      if (typeof logEvent_ === 'function') logEvent_('revisions-done', { fileId: fileId, left: afterCount });
    } catch(e){
      sh.getRange(2+i, COL.Status).setValue('DEL ERR: '+e.message);
      if (typeof logEvent_ === 'function') logEvent_('revisions-err', { fileId: fileId, detail: String(e && e.message || e) });
    }
  }
}

function cmdExportCompressionCSV(){
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr<2) return;

  const data = sh.getRange(2,1,lr-1, COL.Status).getValues();
  const rows = [['FileId','Name','Action','Path']];
  data.forEach(r=>{
    const act = String(r[COL.Action-1]||'none');
    if (act==='compress_normal' || act==='compress_aggressive'){
      rows.push([r[COL.FileId-1], stripA1Link_(r[COL.Name-1]), act, stripA1Link_(r[COL.Path-1])]);
    }
  });
  const csv = rows.map(row=>row.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const file = DriveApp.createFile(Utilities.newBlob(csv,'text/csv','compress_tasks.csv'));
  if (typeof logEvent_ === 'function') {
    const exported = Math.max(0, rows.length - 1); // exclude header
    logEvent_('csv-export', { name: file.getName(), detail: file.getUrl(), extra: 'rows='+exported });
  }
  SpreadsheetApp.getUi().alert('CSV создан: '+file.getUrl());
}

function cmdRepositoryDispatchBatch(){
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow();
  if (lr < 2) { SpreadsheetApp.getActive().toast('Нет задач для отправки', 'GitHub', 5); return; }

  try {
    const data = sh.getRange(2, 1, lr - 1, COL.Status).getValues();
    const files = [];
    const rowIdxs = [];
    for (let i = 0; i < data.length; i++) {
      if (files.length >= 20) break;
      const row = data[i];
      const fileId = String(row[COL.FileId-1] || '').trim();
      let act = String(row[COL.Action-1] || '').trim();
      if (!fileId) continue;
      // normalize action
      if (act === 'compress_normal') act = 'normal';
      if (act === 'compress_aggressive') act = 'aggressive';
      if (act !== 'normal' && act !== 'aggressive') continue;

      const recommend = String(row[COL.Recommend-1] || '').trim();
      const estRaw = row[COL.EstNewSizeMB-1];
      const estNum = Number(estRaw);
      const why = String(row[COL.Why-1] || '').trim();

      const item = { fileId: fileId, action: act, recommend: recommend, why: why };
      if (isFinite(estNum)) item.estNewSizeMB = estNum;

      files.push(item);
      rowIdxs.push(2 + i); // absolute row number in sheet
    }

    if (!files.length) {
      SpreadsheetApp.getActive().toast('Нет подходящих задач для отправки', 'GitHub', 5);
      return;
    }

    // send one batch
    sendRepositoryDispatchBatch_(files);

    // optionally mark dispatched
    try {
      rowIdxs.forEach(r => sh.getRange(r, COL.Status).setValue('dispatched'));
    } catch (_) {}

    if (typeof logEvent_ === 'function') {
      logEvent_('dispatch-batch', { detail: 'count=' + files.length });
    }
    SpreadsheetApp.getActive().toast('Отправлено: ' + files.length, 'GitHub', 5);
  } catch (e) {
    if (typeof logEvent_ === 'function') {
      logEvent_('dispatch-error', { detail: String(e && e.message || e) });
    }
    SpreadsheetApp.getActive().toast('ERR: ' + (e && e.message || e), 'GitHub', 7);
  }
}

function cmdClearLogSheet(){
  try{
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(SHEET_LOG);
    if (!sh) { SpreadsheetApp.getUi().alert('Лист Log не найден'); return; }
    const lr = sh.getLastRow();
    if (lr > 1) sh.getRange(2,1,lr-1, sh.getMaxColumns()).clearContent().clearFormat();
    SpreadsheetApp.getActive().toast('Логи очищены', 'Log', 3);
  }catch(e){
    SpreadsheetApp.getActive().toast('ERR: '+(e.message||e), 'Log', 5);
  }
}

function cmdResetRangeCursor(){
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_RANGE_ROW);
  props.deleteProperty(PROP_RANGE_SCHEDULED);
  deleteTriggersByHandler_('cmdProbeDurationsRange');
  SpreadsheetApp.getActive().toast('Курсор Range и триггеры очищены', 'Range', 5);
}

function cmdStopRange(){
  const props = PropertiesService.getScriptProperties();
  try {
    props.setProperty(PROP_RANGE_STOP, '1');
    deleteTriggersByHandler_('cmdProbeDurationsRange');
    if (typeof logEvent_ === 'function') logEvent_('range-stop-requested');
    SpreadsheetApp.getActive().toast('Остановка Range запрошена', 'Range', 5);
  } catch (e) {
    SpreadsheetApp.getActive().toast('ERR: '+(e.message||e), 'Range', 5);
  }
}


/** ---------- Recommend rules & estimates ---------- */
function recommendProfile_(height, mbpmNum, sizeMB, durSec){
  // 1) Приоритет — по MB/мин
  if (mbpmNum!=='' && Number(mbpmNum) >= MBPM_AGGR_MIN)  return 'aggressive';
  if (mbpmNum!=='' && Number(mbpmNum) >= MBPM_NORMAL_MIN) return 'normal';

  // 2) Если длительность неизвестна — эвристики по размеру
  if (!durSec && sizeMB){
    if (Number(sizeMB) >= UNKNOWN_SIZE_THRESHOLD_AGGR_MB)  return 'aggressive';
    if (Number(sizeMB) >= UNKNOWN_SIZE_THRESHOLD_NORMAL_MB) return 'normal';
  }

  // 3) Явный skip для низких MB/мин
  if (mbpmNum!=='' && Number(mbpmNum) < MBPM_NORMAL_MIN) return 'skip';

  // 4) По умолчанию
  return 'normal';
}

function explainWhy_(h, mbpm, sizeMB, durSec, rec){
  const parts = [];
  if (h) parts.push('h='+h);
  if (mbpm!=='' && !isNaN(mbpm)) parts.push('MB/min='+round1_(mbpm));
  if (!durSec && sizeMB) parts.push('no duration, size≈'+round1_(sizeMB)+'MB');
  return (rec+': '+parts.join(', '));
}

function estimateNewSizeMB_(rec, durSec){
  if (!durSec) return '';
  if (rec==='aggressive') return round2_(durSec/60*TARGET_MBPM_AGGR);
  if (rec==='normal')    return round2_(durSec/60*TARGET_MBPM_NORMAL);
  return '';
}

/** ---------- REST v3 helpers ---------- */
function authHeaders_(){
  return {'Authorization':'Bearer '+ScriptApp.getOAuthToken(),'Accept':'application/json'};
}
function httpGetJson_(url){
  const resp = UrlFetchApp.fetch(url, {method:'get', headers: authHeaders_(), muteHttpExceptions:true});
  const code = resp.getResponseCode();
  if (code>=200 && code<300) return JSON.parse(resp.getContentText());
  throw new Error('HTTP '+code+' '+resp.getContentText());
}

function driveV3List_(q, fields){
  const base = 'https://www.googleapis.com/drive/v3/files';
  let pageToken = '';
  const out = [];
  do {
    const params = {
      q:q, fields:'nextPageToken,files('+fields+')', pageSize:1000,
      includeItemsFromAllDrives:true, supportsAllDrives:true, corpora:'allDrives', spaces:'drive'
    };
    if (pageToken) params.pageToken = pageToken;
    const url = base + '?' + Object.keys(params).map(k=>k+'='+encodeURIComponent(params[k])).join('&');
    const js = httpGetJson_(url);
    (js.files||[]).forEach(f=>out.push(f));
    pageToken = js.nextPageToken || '';
  } while (pageToken);
  return out;
}

function driveV3GetFile_(fileId, fields){
  const url = 'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)
    + '?fields='+encodeURIComponent(fields)+'&supportsAllDrives=true';
  return httpGetJson_(url);
}

// Рекурсивный обход папки: видео и подпапки
function listVideosRecursiveV3_(folderId, out, seen){
  const qFiles = `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`;
  driveV3List_(qFiles, 'id,name,parents,mimeType,size,modifiedTime,videoMediaMetadata(width,height,durationMillis)')
    .forEach(f=>{ if (!seen[f.id]){ seen[f.id]=true; out.push(f); } });
  const qFolders = `'${folderId}' in parents and trashed=false and mimeType = 'application/vnd.google-apps.folder'`;
  driveV3List_(qFolders, 'id,name,parents').forEach(fd=> listVideosRecursiveV3_(fd.id, out, seen));
}

// Нерекурсивный обход: только файлы в заданной папке (без подпапок)
function listVideosSingleFolderV3_(folderId, out, seen){
  const qFiles = `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`;
  driveV3List_(qFiles, 'id,name,parents,mimeType,size,modifiedTime,videoMediaMetadata(width,height,durationMillis)')
    .forEach(f=>{ if (!seen[f.id]){ seen[f.id]=true; out.push(f); } });
}

// Человеческий путь (кэш по папкам)
const _folderCacheV3_ = {};
function resolvePathV3_(file){
  try{
    if (!file.parents || !file.parents.length) return file.name;
    let p = file.parents[0];
    const parts = [file.name];
    while (p){
      const f = _folderCacheV3_[p] || driveV3GetFile_(p, 'id,name,parents');
      _folderCacheV3_[p] = f;
      parts.unshift(f.name);
      p = (f.parents && f.parents.length) ? f.parents[0] : null;
    }
    return parts.join(' / ');
  }catch(e){
    return file.name;
  }
}

// Экранирование кавычек в A1-формуле
function escQ_(s){ return String(s||'').replace(/"/g,'""'); }

// Удалить HYPERLINK(...) и оставить только видимый текст
function stripA1Link_(val){
  const s = String(val||'');
  if (s.startsWith('=HYPERLINK(')) {
    const m = s.match(/,"(.*)"\)\s*$/);
    if (m) return m[1].replace(/""/g,'"');
  }
  return s;
}

/** ---------- Range-пробивка duration (A2→A3…, head→tail 2MB→tail 8MB) ---------- */
function cmdProbeDurationsRange() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr < 2) return;

  // Защита от параллельных запусков
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) {
    SpreadsheetApp.getActive().toast('Range-пробивка уже запущена.', 'Range', 5);
    return;
  }

  // === Подготовка прохода A2, A3, ...
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();

  // Принудительная остановка по флагу
  if (props.getProperty(PROP_RANGE_STOP) === '1') {
    props.deleteProperty(PROP_RANGE_STOP);
    props.deleteProperty(PROP_RANGE_ROW);
    props.deleteProperty(PROP_RANGE_SCHEDULED);
    deleteTriggersByHandler_('cmdProbeDurationsRange');
    SpreadsheetApp.getActive().toast('Range остановлен по запросу', 'Range', 5);
    if (typeof logEvent_ === 'function') logEvent_('range-stopped', { detail: 'manual stop' });
    lock.releaseLock();
    return;
  }

  // Если это НЕ автопродолжение (нет флага), считаем запуск ручным и начинаем с A2
  const isScheduled = props.getProperty(PROP_RANGE_SCHEDULED) === '1';
  if (!isScheduled) {
    props.deleteProperty(PROP_RANGE_ROW); // сбрасываем курсор
  }

  let startRow = parseInt(props.getProperty(PROP_RANGE_ROW) || '2', 10);
  /* Чистим прошлый индикатор паузы в DurationSec (если был), логируем resume */
  { // очистка «⏸ Пауза …» из предыдущего запуска
    const pauseRowStr = props.getProperty('RANGE_PAUSE_ROW');
    if (pauseRowStr) {
      const pr = parseInt(pauseRowStr, 10);
      try {
        const cell = sh.getRange(pr, COL.DurationSec);
        if (String(cell.getValue()).indexOf('⏸ Пауза') === 0) {
          cell.clearContent().setBackground(null);
        }
      } catch (_) {}
      props.deleteProperty('RANGE_PAUSE_ROW');
      if (typeof logEvent_ === 'function') logEvent_('range-resume', { detail: 'resumeRow=' + pr });
    }
  }
  if (startRow < 2) startRow = 2;

  // ЛОГ: старт или возобновление
  if (typeof logEvent_ === 'function') {
    logEvent_(isScheduled ? 'range-resume' : 'range-start', { detail: 'startRow='+startRow });
  }

  let processed = 0;

  const n = lr - 1;
  const fileIds = sh.getRange(2, COL.FileId,     n, 1).getValues().map(r => r[0]);
  const mimes   = sh.getRange(2, COL.MimeType,   n, 1).getValues().map(r => String(r[0] || ''));
  const sizeMBs = sh.getRange(2, COL.SizeMB,     n, 1).getValues().map(r => Number(r[0] || 0));
  const durs    = sh.getRange(2, COL.DurationSec,n, 1).getValues().map(r => r[0]);
  const names   = sh.getRange(2, COL.Name,       n, 1).getValues().map(r => String(r[0] || ''));

  let i0 = startRow - 2; if (i0 < 0) i0 = 0;

  for (let i = i0; i < fileIds.length; i++) {
    const r      = 2 + i;
    const fileId = fileIds[i];
    const mime   = mimes[i];
    const dur    = durs[i];
    const sizeMB = sizeMBs[i];
    const name   = names[i];

    // Принудительная остановка (в ходе прохода)
    if (props.getProperty(PROP_RANGE_STOP) === '1') {
      props.deleteProperty(PROP_RANGE_STOP);
      props.deleteProperty(PROP_RANGE_ROW);
      props.deleteProperty(PROP_RANGE_SCHEDULED);
      deleteTriggersByHandler_('cmdProbeDurationsRange');
      try { sh.getRange(r, COL.Status).setValue('range: stopped'); } catch (_) {}
      if (typeof logEvent_ === 'function') logEvent_('range-stopped', { detail: 'manual stop mid-loop, row='+r });
      SpreadsheetApp.getActive().toast('Range остановлен по запросу', 'Range', 5);
      lock.releaseLock();
      return;
    }

    if (!fileId) continue;
    if (dur) continue;
    if (RANGE_ALLOWED_MIME.indexOf(mime) === -1) {
      sh.getRange(r, COL.Status).setValue('range: unsupported mime');
      if (typeof logEvent_ === 'function') logEvent_('range-skip', {fileId, name, detail: 'unsupported mime: '+mime});
      continue;
    }

    // Бюджет времени — если истекает, ставим курсор на текущую строку и выходим
    if (Date.now() - t0 > RANGE_MAX_MS) {
      props.setProperty(PROP_RANGE_ROW, String(r));
      if (props.getProperty(PROP_RANGE_SCHEDULED) !== '1') {
        ScriptApp.newTrigger('cmdProbeDurationsRange')
          .timeBased()
          .after(RANGE_RESUME_DELAY_MS)
          .create();
        props.setProperty(PROP_RANGE_SCHEDULED, '1');
      }

      /* Логируем паузу, ставим индикатор в DurationSec текущей строки */
      // ⏸ Пауза: ставим заметку в текущую ячейку DurationSec и мягкий жёлтый фон
      // Индикатор паузы в текущей строке
      const pauseNote = '⏸ Пауза (≈60–120 с)';
      try {
        sh.getRange(r, COL.DurationSec).setValue(pauseNote).setBackground('#FFF3CD');
      } catch (_) {}

      // Лог и тост c числом из константы
      props.setProperty('RANGE_PAUSE_ROW', String(r));
      var __sec = Math.round(RANGE_RESUME_DELAY_MS / 1000);
      if (typeof logEvent_ === 'function') {
        logEvent_('range-pause', { detail: `row=${r}, processed=${processed}, sleep≈${__sec}–120s` });
      }
      SpreadsheetApp.getActive().toast(`Пауза (≈${__sec}–120 с): обработано ${processed}, продолжу автоматически`, 'Range', 5);

      lock.releaseLock();
      return;
    }

    // «В работе»
    const total = fileIds.length;
    sh.getRange(r, COL.Status).setValue(`range: trying [${i+1}/${total}]`);
    if (typeof logEvent_ === 'function') logEvent_('range-try', {fileId, name, detail: mime});
    SpreadsheetApp.flush();

    const sizeBytes = sizeMB ? Math.round(Number(sizeMB) * 1024 * 1024) : 0;

    // HEAD → TAIL(2MB) → TAIL(8MB)
    const dbg = [];

    let durationSec = probeDurationByRange_(fileId, 'head', sizeBytes, RANGE_HEAD_BYTES, dbg);
    let where = 'head';

    if (!durationSec) {
      durationSec = probeDurationByRange_(fileId, 'tail', sizeBytes, RANGE_TAIL_BYTES_STEP1, dbg);
      where = durationSec ? 'tail(2MB)' : '';
    }
    if (!durationSec) {
      durationSec = probeDurationByRange_(fileId, 'tail', sizeBytes, RANGE_TAIL_BYTES_STEP2, dbg);
      where = durationSec ? 'tail(8MB)' : '';
    }

    if (durationSec) {
      sh.getRange(r, COL.DurationSec).setValue(durationSec);

      const mbpmNum  = (sizeMB && durationSec) ? sizeMB * (60 / durationSec) : '';
      const mbpmDisp = (mbpmNum !== '' ? round1_(mbpmNum) : '');
      sh.getRange(r, COL.MBperMin).setValue(mbpmDisp);

      const h   = Number(sh.getRange(r, COL.Height).getValue() || 0);
      const rec = recommendProfile_(h, (mbpmNum === '' ? '' : Number(mbpmNum)), sizeMB, durationSec);
      const why = explainWhy_(h, (mbpmNum === '' ? '' : Number(mbpmNum)), sizeMB, durationSec, rec);
      const need= (rec === 'skip') ? '' : 'Y';
      const est = estimateNewSizeMB_(rec, durationSec);
      const save= (est !== '' && sizeMB) ? Math.max(0, round2_(sizeMB - est)) : '';

      sh.getRange(r, COL.NeedCompress).setValue(need);
      sh.getRange(r, COL.Recommend).setValue(rec);
      sh.getRange(r, COL.Why).setValue(why);
      sh.getRange(r, COL.EstNewSizeMB).setValue(est);
      sh.getRange(r, COL.EstSavingsMB).setValue(save);

      if (isRangeWHEnabled_()) {
        try {
          var curW = Number(sh.getRange(r, COL.Width).getValue() || 0);
          var curH = Number(sh.getRange(r, COL.Height).getValue() || 0);
          var needWH = (!curW || !curH);
          var gotWH = false;
          if (needWH && Array.isArray(dbg)) {
            var whMsg = dbg.find(function(s){ return (typeof s === 'string') && s.indexOf('wh=') === 0; });
            if (whMsg) {
              var m = whMsg.match(/^wh=(\d+)x(\d+)$/);
              if (m) {
                var ww = Number(m[1]), hh = Number(m[2]);
                if (ww > 0 && hh > 0) {
                  sh.getRange(r, COL.Width).setValue(ww);
                  sh.getRange(r, COL.Height).setValue(hh);
                  gotWH = true;
                  if (typeof logEvent_ === 'function') logEvent_('wh-range', { fileId: fileId, name: name, detail: ww + 'x' + hh });
                }
              }
            }
          }
          if (needWH && !gotWH && typeof logEvent_ === 'function') {
            logEvent_('wh-range-miss', { fileId: fileId, name: name, detail: 'no WH via Range @' + where });
          }
        } catch(_) {}
      }
      

      sh.getRange(r, COL.Status).setValue('range: mvhd@' + where);

      if (typeof logEvent_ === 'function') logEvent_('range-ok', {fileId, name, detail: 'mvhd@'+where});
    } else {
      const detail = dbg.join(', ');
      sh.getRange(r, COL.Status).setValue('range: not found [' + detail + ']');
      if (typeof logEvent_ === 'function') logEvent_('range-miss', {fileId, name, detail: detail});
    }

    processed++;
    if (processed % 5 === 0) SpreadsheetApp.flush();
    if (processed % 20 === 0) SpreadsheetApp.getActive().toast(`Обработано ${processed}`, 'Range', 3);
    Utilities.sleep(RANGE_SLEEP_MS);
  }

  // Всё обработано
  props.deleteProperty(PROP_RANGE_ROW);
  props.deleteProperty(PROP_RANGE_SCHEDULED);
  deleteTriggersByHandler_('cmdProbeDurationsRange');
  SpreadsheetApp.getActive().toast(`Готово: обработано ${processed}`, 'Range', 5);
  if (typeof logEvent_ === 'function') logEvent_('range-done', {detail: 'processed='+processed});
  lock.releaseLock();
}

// HTTP Range fetch (абсолютные диапазоны)
function driveV3RangeFetch_(fileId, rangeKind, sizeBytes, tailBytes) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId)
  + '?alt=media&supportsAllDrives=true';

  let rangeHeader = '';
  if (rangeKind === 'head') {
    rangeHeader = 'bytes=0-' + (RANGE_HEAD_BYTES - 1);
  } else if (rangeKind === 'tail') {
    if (!sizeBytes || !tailBytes) throw new Error('tail: need sizeBytes & tailBytes');
    const start = Math.max(0, sizeBytes - tailBytes);
    const end   = sizeBytes - 1;
    rangeHeader = 'bytes=' + start + '-' + end;
  } else {
    throw new Error('bad range kind');
  }

  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
      'Range': rangeHeader,
      'Accept': '*/*'
    },
    followRedirects: true,
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code === 206 || code === 200) return resp.getContent();
  throw new Error('HTTP ' + code + ' for ' + rangeHeader);
}

  // Обёртка: head/tail → попытка извлечь duration + лёгкий debug
// Обёртка: head/tail → попытка извлечь duration + лёгкий debug
function probeDurationByRange_(fileId, which, sizeBytes, tailBytes, dbg) {
  try {
    const bytes = driveV3RangeFetch_(fileId, which, sizeBytes, tailBytes);
    if (dbg) {
      dbg.push(`${which}: ok ${bytes.length}B`);
      if (which === 'head') {
        const brand = parseFtypBrand_(bytes);
        if (brand) dbg.push(`brand=${brand}`);
      }
    }
    return parseMp4Duration_(bytes, dbg); // ← передаём dbg внутрь парсера
  } catch (e) {
    if (dbg) dbg.push(`${which}: ERR ${String(e && e.message || e)}`);
    return null;
  }
}



/** ---- MP4/MOV parsers ---- */
function _b(bytes, i){ return (bytes[i] + 256) % 256; } // 0..255
function be32_(b, o){ return (_b(b,o)<<24) | (_b(b,o+1)<<16) | (_b(b,o+2)<<8) | _b(b,o+3); }
function be64_(b, o){ const hi = be32_(b,o)>>>0, lo = be32_(b,o+4)>>>0; return hi * 4294967296 + lo; }
function type4_(b, o){ return String.fromCharCode(_b(b,o), _b(b,o+1), _b(b,o+2), _b(b,o+3)); }

// Helpers to get Width/Height from moov (tkhd + hdlr)
function parseHdlrType_(bytes, start, end) {
  if (start + 12 > end) return '';
  var off = start + 8;
  if (off + 4 > end) return '';
  return type4_(bytes, off); // 'vide', 'soun', ...
}

function parseTkhdWH_(bytes, start, end) {
  if (start + 4 > end) return null;
  var version = _b(bytes, start), off = start + 4;
  try {
    if (version === 1) { off += 8 + 8; off += 4; off += 4; off += 8; }
    else               { off += 4 + 4; off += 4; off += 4; off += 4; }
    off += 8; off += 2 + 2; off += 2 + 2; off += 36;
    if (off + 8 > end) return null;
    var wFixed = be32_(bytes, off); off += 4;
    var hFixed = be32_(bytes, off); off += 4;
    var w = Math.round(wFixed / 65536), h = Math.round(hFixed / 65536);
    if (w > 0 && h > 0) return { w: w, h: h };
  } catch(_) {}
  return null;
}

function parseTrakForWH_(bytes, start, end) {
  var off = start, gotWH = null, isVideo = false;
  while (off + 8 <= end) {
    var size = be32_(bytes, off), type = type4_(bytes, off + 4), hdr = 8;
    if (size === 1) { if (off + 16 > end) break; size = be64_(bytes, off + 8); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;

    if (type === 'tkhd' && !gotWH) {
      var r = parseTkhdWH_(bytes, off + hdr, off + size);
      if (r) gotWH = r;
    } else if (type === 'mdia') {
      var o2 = off + hdr, e2 = off + size;
      while (o2 + 8 <= e2) {
        var s2 = be32_(bytes, o2), t2 = type4_(bytes, o2 + 4), h2 = 8;
        if (s2 === 1) { if (o2 + 16 > e2) break; s2 = be64_(bytes, o2 + 8); h2 = 16; }
        else if (s2 === 0) s2 = e2 - o2;
        if (s2 < h2 || o2 + s2 > e2) break;
        if (t2 === 'hdlr') { var htype = parseHdlrType_(bytes, o2 + h2, o2 + s2); if (htype === 'vide') isVideo = true; break; }
        o2 += s2;
      }
    }
    off += size;
  }
  return (isVideo && gotWH) ? gotWH : null;
}

function parseMoovForWH_(bytes, start, end) {
  var off = start;
  while (off + 8 <= end) {
    var size = be32_(bytes, off), type = type4_(bytes, off + 4), hdr = 8;
    if (size === 1) { if (off + 16 > end) break; size = be64_(bytes, off + 8); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;
    if (type === 'trak') { var r = parseTrakForWH_(bytes, off + hdr, off + size); if (r) return r; }
    off += size;
  }
  return null;
}

// === Поиск бокса по сигнатуре "type" в любом месте буфера (resync) ===
function scanForAtom_(bytes, start, end, type) {
  // Ищем 4-символьный тип на любой позиции, проверяем валидный size перед ним
  for (let p = start; p + 8 <= end; p++) {
    if (type4_(bytes, p + 4) !== type) continue;

    // читаем size (32/64)
    let size = be32_(bytes, p);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) continue;
      size = be64_(bytes, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p; // до конца буфера
    }
    if (size < hdr) continue;
    if (p + size > end) continue;

    return { off: p, hdr: hdr, size: size, payloadStart: p + hdr, atomEnd: p + size };
  }
  return null;
}

// Вытащить majorBrand из ftyp (если head начинается с начала файла)
function parseFtypBrand_(bytes) {
  if (!bytes || bytes.length < 16) return '';
  const size = be32_(bytes, 0);
  const type = type4_(bytes, 4);
  if (type !== 'ftyp' || size < 16 || size > bytes.length) return '';
  return type4_(bytes, 8); // major_brand
}


function parseMp4Duration_(bytes, dbg) {
  if (!bytes || !bytes.length) return null;

  // --- 1) Нормальный структурный проход по верхним атомам ---
  const len = bytes.length; 
  let off = 0;
  while (off + 8 <= len) {
    let size = be32_(bytes, off);
    const type = type4_(bytes, off + 4);
    let hdr = 8;

    if (size === 1) { 
      if (off + 16 > len) break;
      size = be64_(bytes, off + 8); 
      hdr = 16; 
    } else if (size === 0) {
      size = len - off;
    }
    if (size < hdr || off + size > len) break;

    if (type === 'moov') {
      if (isRangeWHEnabled_()) {
        try {
          var wh1 = parseMoovForWH_(bytes, off + hdr, off + size);
          if (wh1 && dbg) dbg.push('wh=' + wh1.w + 'x' + wh1.h);
        } catch(_) {}
      }
      
      const d = parseMoovForDuration_(bytes, off + hdr, off + size);
      if (d) return d;
    } else if (type === 'mvhd') {
      const d = parseMvhd_(bytes, off + hdr, off + size);
      if (d) return d;
    }
    off += size;
  }

  // --- 2) RESYNC: ищем moov "в середине" буфера ---
  const moov = scanForAtom_(bytes, 0, len, 'moov');
  if (moov) {
    if (isRangeWHEnabled_()) {
      try {
        var wh2 = parseMoovForWH_(bytes, moov.payloadStart, moov.atomEnd);
        if (wh2 && dbg) dbg.push('wh=' + wh2.w + 'x' + wh2.h);
      } catch(_) {}
    }
    
    const d = parseMoovForDuration_(bytes, moov.payloadStart, moov.atomEnd);
    if (d) {
      if (dbg) dbg.push(`resync moov@+${Math.round(moov.off/1024)}KB`);
      return d;
    }
  }

  // --- 3) RESYNC: прямой поиск mvhd ---
  const mvhd = scanForAtom_(bytes, 0, len, 'mvhd');
  if (mvhd) {
    const d = parseMvhd_(bytes, mvhd.payloadStart, mvhd.atomEnd);
    if (d) {
      if (dbg) dbg.push(`resync mvhd@+${Math.round(mvhd.off/1024)}KB`);
      return d;
    }
  }

  // --- 4) RESYNC: прямой поиск mdhd (внутри mdia) ---
  const mdhd = scanForAtom_(bytes, 0, len, 'mdhd');
  if (mdhd) {
    const d = parseMdhd_(bytes, mdhd.payloadStart, mdhd.atomEnd);
    if (d) {
      if (dbg) dbg.push(`resync mdhd@+${Math.round(mdhd.off/1024)}KB`);
      return d;
    }
  }

  // Ничего не нашли
  return null;
}


function parseMoovForDuration_(bytes, start, end) {
  let off = start;
      if (isRangeWHEnabled_()) {
    try {
      const wh = parseMoovForWH_(bytes, start, end);
      if (wh && dbg) dbg.push(`wh=${wh.w}x${wh.h}`);
    } catch (_){ /* non-fatal */ }   
  }

  while (off + 8 <= end) {
    let size = be32_(bytes, off);
    const type = type4_(bytes, off + 4);
    let hdr = 8;
    if (size === 1) { if (off + 16 > end) break; size = be64_(bytes, off + 8); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;

    if (type === 'mvhd') {
      const d = parseMvhd_(bytes, off + hdr, off + size);
      if (d) return d;
    } else if (type === 'trak') {
      const d2 = parseTrakForMdhd_(bytes, off + hdr, off + size);
      if (d2) return d2;
    }
    off += size;
  }
  return null;
}

function parseTrakForMdhd_(bytes, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = be32_(bytes, off);
    const type = type4_(bytes, off + 4);
    let hdr = 8;
    if (size === 1) { if (off + 16 > end) break; size = be64_(bytes, off + 8); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;

    if (type === 'mdia') {
      let o2 = off + hdr, e2 = off + size;
      while (o2 + 8 <= e2) {
        let s2 = be32_(bytes, o2);
        const t2 = type4_(bytes, o2 + 4);
        let h2 = 8;
        if (s2 === 1) { if (o2 + 16 > e2) break; s2 = be64_(bytes, o2 + 8); h2 = 16; }
        else if (s2 === 0) s2 = e2 - o2;
        if (s2 < h2 || o2 + s2 > e2) break;

        if (t2 === 'mdhd') {
          const d = parseMdhd_(bytes, o2 + h2, o2 + s2);
          if (d) return d;
        }
        o2 += s2;
      }
    }
    off += size;
  }
  return null;
}

function parseMvhd_(bytes, start, end) {
  if (start + 4 > end) return null;
  const version = _b(bytes, start);
  let off = start + 4;
  try {
    if (version === 1) {
      off += 8 + 8;
      const timescale = be32_(bytes, off); off += 4;
      const duration  = be64_(bytes, off); off += 8;
      if (!timescale) return null;
      return Math.round(Number(duration) / Number(timescale));
    } else {
      off += 4 + 4;
      const timescale = be32_(bytes, off); off += 4;
      const duration  = be32_(bytes, off); off += 4;
      if (!timescale) return null;
      return Math.round(duration / timescale);
    }
  } catch (_) { return null; }
}

function parseMdhd_(bytes, start, end) {
  if (start + 4 > end) return null;
  const version = _b(bytes, start);
  let off = start + 4;
  try {
    if (version === 1) {
      off += 8 + 8;
      const timescale = be32_(bytes, off); off += 4;
      const duration  = be64_(bytes, off); off += 8;
      if (!timescale) return null;
      return Math.round(Number(duration) / Number(timescale));
    } else {
      off += 4 + 4;
      const timescale = be32_(bytes, off); off += 4;
      const duration  = be32_(bytes, off); off += 4;
      if (!timescale) return null;
      return Math.round(duration / timescale);
    }
  } catch (_) { return null; }
}

/** ---------- Оформление ---------- */
function setupFormattingAndValidation_(sh){
  const widths = [280,420,260,140,90,110,110,70,70,160,110,130,110,220,160,120,120,160,240];
  for (let i=0;i<widths.length;i++) sh.setColumnWidth(i+1, widths[i]);

  sh.setFrozenRows(1);
  ensureFilter_(sh, COL.Status);

  // Валидации
  const ruleY = SpreadsheetApp.newDataValidation().requireValueInList(['Y','']).setAllowInvalid(true).build();
  sh.getRange('R2:R').setDataValidation(ruleY); // MarkDeleteRevisions

  const ruleAction = SpreadsheetApp.newDataValidation()
    .requireValueInList(['none','compress_normal','compress_aggressive'], true)
    .setAllowInvalid(true).build();
  sh.getRange('O2:O').setDataValidation(ruleAction);

  // Подсветки
  const rules = [];

  // NeedCompress (K) — жёлтый
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Y').setBackground('#FFF3CD')
    .setRanges([sh.getRange(2, COL.NeedCompress, Math.max(0, sh.getLastRow()-1), 1)]).build());

  // HasOldRevisions (L) — розовый
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Y').setBackground('#F8D7DA')
    .setRanges([sh.getRange(2, COL.HasOldRevisions, Math.max(0, sh.getLastRow()-1), 1)]).build());

  // Recommend (M)
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('aggressive').setBackground('#F5C6CB')
    .setRanges([sh.getRange(2, COL.Recommend, Math.max(0, sh.getLastRow()-1), 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('normal').setBackground('#FFE8CC')
    .setRanges([sh.getRange(2, COL.Recommend, Math.max(0, sh.getLastRow()-1), 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('skip').setBackground('#D4EDDA')
    .setRanges([sh.getRange(2, COL.Recommend, Math.max(0, sh.getLastRow()-1), 1)]).build());

  const lrAll = sh.getLastRow();
  if (lrAll > 1) {
    const statusColLetter = toA1Col_(COL.Status);
    const rowRange = sh.getRange(2, 1, lrAll - 1, COL.Status);

    // в процессе (жёлтый)
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=REGEXMATCH($${statusColLetter}2,"^range: trying")`)
        .setBackground('#FFF3CD')
        .setRanges([rowRange]).build()
    );
    // успех (зелёный)
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=REGEXMATCH($${statusColLetter}2,"^range: mvhd@")`)
        .setBackground('#D4EDDA')
        .setRanges([rowRange]).build()
    );
    // не найдено или ошибка (красный)
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=OR(REGEXMATCH($${statusColLetter}2,"^range: not found"), REGEXMATCH($${statusColLetter}2,"^range ERR:"))`)
        .setBackground('#F8D7DA')
        .setRanges([rowRange]).build()
    );

    // + Пустой DurationSec → мягкая голубая подсветка всей строки
    const durColLetter = toA1Col_(COL.DurationSec);
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=$${durColLetter}2=""`)
        .setBackground('#E8F4FF')
        .setRanges([rowRange]).build()
    );

  }

  sh.setConditionalFormatRules(rules);
}

/** ---------- Legacy helper ---------- */
function decideNeedCompress_(height, mbPerMin, sizeMB, durSec) {
  // Решение — по MB/мин; высота сама по себе не триггерит необходимость
  if (mbPerMin!=='' && Number(mbPerMin) >= MBPM_NORMAL_MIN) return true;

  // Если длительность неизвестна — используем пороги по размеру
  if ((!durSec || durSec==='') && sizeMB){
    if (Number(sizeMB) >= UNKNOWN_SIZE_THRESHOLD_NORMAL_MB) return true;
  }
  return false;
}
