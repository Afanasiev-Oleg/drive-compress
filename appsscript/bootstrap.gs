/** === BOOTSTRAP: создаёт листы и Help с инструкцией === */
function bootstrap() {
  const ss = SpreadsheetApp.getActive();

  // Help
  const help = getOrCreate_(ss, 'Help');
  help.clear();
  const txt = [
    'Drive Video Auditor — справка и пошаговое использование',
    '',
    'Задача страницы',
    '• Находит «тяжёлые» видео в Google Drive, определяет длительность (метаданные/Range), рекомендует профиль сжатия и помогает готовить задачи на перекодирование.',
    '• Сама таблица не сжимает файлы — вы лишь получаете список и (опционально) запускаете внешнюю обработку.',
    '',
    'Где указать, что сканировать',
    '• Лист Config → колонка A (FolderId). По одному ID папки в строке. Обход рекурсивный.',
    '• Как взять FolderId: откройте папку в браузере и скопируйте часть URL после /folders/…',
    '',
    'Настройки Range',
    '• Лист Config → колонка B: "Extract WH via Range (Y/N)".',
    '  – Если Y: в процессе Range дополнительно извлекаются Width/Height (когда удаётся найти их в moov).',
    '  – По умолчанию N (выключено) ради скорости и экономии трафика.',
    '',
    'Как работать (5 шагов)',
    '1) Обновить список (v3 list). Находит все видео, заполняет кликабельные Path/Name, размер, дату.',
    '2) Добрать длительность — сначала «(v3 get)». Это быстрый запрос метаданных Drive:',
    '   – плюсы: минимальный трафик; быстро;',
    '   – минусы: для части старых/неиндексированных файлов длительность может не вернуться.',
    '3) Если DurationSec осталась пустой — «Добрать длительность (Range)». Это частичное чтение файла:',
    '   – читаем head ~512KB и tail 2MB → при необходимости 8MB; поддержка video/mp4 и video/quicktime;',
    '   – встроенный resync-парсер ищет moov/mvhd/mdhd даже если кусок начинается в середине бокса;',
    '   – выполняется пакетами и автоматически продолжает с места остановки; порядок строгий: сверху вниз (A2→A3→…).',
    '   Рекомендация: всегда пробуйте v3 get, а Range включайте только для строк без DurationSec.',
    '4) Автомаркировка Recommend → Применить Recommend → Action.',
    '   – Recommend выставит skip / normal / aggressive и «Why».',
    '   – Применить перенесёт рекомендуемый профиль в колонку Action (можно отредактировать вручную).',
    '5) Экспортировать задачи (CSV) или внешний запуск сжатия (GitHub/другой пайплайн).',
    '',
    'Расшифровка статусов и подсветки',
    '• Status:',
    '  – range: trying […] — строка в работе (жёлтая).',
    '  – range: mvhd@head | mvhd@tail(2MB|8MB) — длительность найдена (зелёная).',
    '  – range: not found […] | range ERR: … — не найдено/ошибка (красная), в скобках краткая диагностика.',
    '• NeedCompress=Y — мягкая жёлтая подсветка в колонке.',
    '• «Assumed by size (40–60s)» — длительность не пришла из метаданных, оценка по размеру.',
    '',
    'Когда что использовать (v3 get vs Range)',
    '• (v3 get): всегда сначала. Это дешёвый метаданный путь. Если DurationSec есть — отлично.',
    '• (Range): включайте только для оставшихся пустых DurationSec. Трафик до ~8.5 MB/файл, но почти гарантированная длительность.',
    '',
    'Управление прогрессом',
    '• Обновить список (v3 list) — сбрасывает состояние Range; следующий запуск Range всегда начнётся с A2.',
    '• Автопауза: если Apps Script близок к лимиту времени, Range ставит паузу, логирует событие и автоматически продолжает.',
    '',
    'Логи',
    '• Лист Log: события range-start / range-resume / range-try / range-pause / range-ok / range-miss / range-done и др.',
    '• Apps Script → Executions (Запуски): системные логи/ошибки на каждый вызов.',
    '',
    'Ревизии и очистка места',
    '• Проверить ревизии — отметит файлы с более чем одной ревизией.',
    '• Удалить отмеченные ревизии — удалит все, кроме последней (если MarkDeleteRevisions=Y).',
    '',
    'Ограничения',
    '• Range требует право скачивания оригинала. Для Shared Drives используется supportsAllDrives=true.',
    '• Поддерживаемые контейнеры Range: video/mp4, video/quicktime.',
    '• Ширина/высота подтягиваются после успешной Range, если были пустыми.',
  ];

  help.getRange(1,1,txt.length,1).setValues(txt.map(t=>[t]));
  help.setColumnWidth(1, 980);
  help.setFrozenRows(1);
  help.getRange('A1').setFontWeight('bold').setFontSize(14);

  // Config
  const cfg = getOrCreate_(ss, 'Config');
  if (cfg.getLastRow() === 0) {
    cfg.getRange('A1').setValue('FolderId');
    cfg.getRange('A2').setNote('ID папок Drive для сканирования, по одному в строку');
  }
  cfg.setColumnWidths(1, 1, 520);

  // Добавим флаг конфигурации (B-колонка): извлекать Width/Height при Range (Y/N)
  cfg.getRange('B1').setValue('Extract WH via Range (Y/N)');
  if (!String(cfg.getRange('B2').getValue() || '').trim()) {
    cfg.getRange('B2').setValue('N');
  }

  // Videos
  const sh = getOrCreate_(ss, 'Videos');
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'File ID','Path','Name','MIME Type','Size MB','Duration Sec','MBperMin',
      'Width','Height','Modified Time','Need Compress','Has Old Revisions',
      'Recommend','Why','Action','Est. New Size MB','Est. Savings MB','Delete Old Revisions (Y/N)','Status'
    ]);
    sh.setFrozenRows(1);
    shVideos.getRange(1, 1, 1, COL.Status).setHorizontalAlignment('center');
    ensureFilter_(sh, COL.Status);
  }
}

// локальный helper для bootstrap
function getOrCreate_(ss, name){ return ss.getSheetByName(name) || ss.insertSheet(name); }
