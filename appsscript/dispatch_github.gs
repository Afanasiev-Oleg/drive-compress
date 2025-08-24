/** === GitHub dispatch & SA perms ===
 * Читает колонку Action (compress_normal/aggressive), выдаёт SA доступ, диспатчит в GitHub.
 * Требуется: в Script Properties задан GH_PAT.
 * Требуется: Advanced Google Services → Drive API (для Permissions).
 */

function triggerGithubForMarked() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) throw new Error('Нет листа Videos');
  const lr = sh.getLastRow(); if (lr<2) return;

  if (typeof logEvent_ === 'function') logEvent_('dispatch-start');

  const data = sh.getRange(2,1,lr-1, COL.Status).getValues();
  const token = getGithubToken_();

  for (let i=0;i<data.length;i++){
    const row = data[i];
    const fileId = row[COL.FileId-1];
    const action = String(row[COL.Action-1]||'none');
    const name   = stripA1Link_(row[COL.Name-1]||'');

    if (!fileId) continue;
    if (action!=='compress_normal' && action!=='compress_aggressive') continue;

    const profile = (action==='compress_aggressive') ? 'aggressive' : 'normal';

    try {
      // 1) дать сервисному аккаунту доступ на файл
      Drive.Permissions.create(
        {role:'writer', type:'user', emailAddress: SA_EMAIL},
        fileId,
        {sendNotificationEmail:false}
      );
      if (typeof logEvent_ === 'function') logEvent_('dispatch-try', {fileId, name, action: profile});

      // 2) вызвать GitHub repository_dispatch
      const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`;
      const payload = { event_type: 'drive_compress', client_payload: { fileId: fileId, profile: profile } };
      const resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Accept':'application/vnd.github+json', 'Authorization': 'token ' + token },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const code = resp.getResponseCode();
      sh.getRange(2+i, COL.Status).setValue('Dispatched '+profile+' '+code);
      if (typeof logEvent_ === 'function') logEvent_('dispatch', {fileId, name, action: profile, detail: 'HTTP '+code});
    } catch(e){
      sh.getRange(2+i, COL.Status).setValue('ERR: '+e.message);
      if (typeof logEvent_ === 'function') logEvent_('dispatch-err', {fileId, name, action: profile, detail: String(e && e.message || e)});
    }
  }
}
/** === GitHub Dispatch (single batch) ===
 * Sends exactly one repository_dispatch with event_type="drive_compress".
 * files: array of objects { fileId, action, recommend, estNewSizeMB?, why }.
 */
function sendRepositoryDispatchBatch_(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files[] is empty');
  }

  // Get token from Script Properties
  var token = '';
  try {
    token = getGithubToken_();
  } catch (_) {
    token = PropertiesService.getScriptProperties().getProperty('GH_PAT');
  }
  if (!token) throw new Error('Нет Script Property GH_PAT');

  var url = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/dispatches';
  var body = {
    event_type: 'drive_compress',
    client_payload: { files: files }
  };

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ' ' + resp.getContentText());
  }
  return true;
}
// Снять доступ SA со всех файлов из списка
function cleanupSAPerms(){
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_VIDEOS);
  if (!sh) return;
  const lr = sh.getLastRow(); if (lr<2) return;
  const ids = sh.getRange(2, COL.FileId, lr-1, 1).getValues().map(r=>r[0]).filter(Boolean);
  ids.forEach(fileId=>{
    try{
      const perms = Drive.Permissions.list(fileId).items || [];
      perms.filter(p=>p.emailAddress===SA_EMAIL).forEach(p=>Drive.Permissions.remove(fileId, p.id));
    }catch(e){}
  });
}

// (опционально) Завести таймеры
function cmdSetupTriggers(){
  ScriptApp.newTrigger('cmdRefresh').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('cmdEnrichDurations').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('cmdAutoRecommend').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('cmdCheckRevisions').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('triggerGithubForMarked').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('cleanupSAPerms').timeBased().everyDays(1).create();
}
