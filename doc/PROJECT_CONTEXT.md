# Drive Video Compressor — Контекст проекта (PROMPT/ONBOARDING)

Этот документ — «контекст всего проекта», который удобно передавать ассистенту/IDE и использовать как справочник для следующих сессий. Держи его в репозитории (например, `PROJECT_CONTEXT.md` в корне).

---

## 0) Репозиторий и ветка

- Репозиторий: **Afanasiev-Oleg/drive-compress**
- Основная ветка: **main**
- RAW-база (HEAD): `https://raw.githubusercontent.com/Afanasiev-Oleg/drive-compress/refs/heads/main/`
- Целевой проект Apps Script: `SCRIPT_ID` (секрет GitHub Actions)
- Service Account (пример): `drive-compressor@drive-video-compressor.iam.gserviceaccount.com`

---

## 1) Цель проекта

Автоматизировать выявление «тяжёлых» видео в Google Drive, выставлять рекомендации на сжатие и по возможности **запускать батч-сжатие** через бесплатные инструменты (GitHub Actions + ffmpeg). Экономить место на Диске без покупки доп.квоты. Работать **без установки Drive for desktop** и без платных GCP‑сервисов.

---

## 2) Текущее состояние: компоненты

### Google Таблица (лист **Videos** и др.)
- Листы: **Config, Videos, Log, Help**.
- **Videos** колонки (человекочитаемые; *MBperMin остаётся технической*):
  - File ID | Path | Name | MIME Type | Size MB | Duration Sec | **MBperMin** | Width | Height | Modified Time | Need Compress | Has Old Revisions | Recommend | Why | Action | Est. New Size MB | Est. Savings MB | Delete Old Revisions (Y/N) | Status
- **Config**: в колонке A — FolderId целевых папок (из URL после `/folders/`).  
- **Log**: события range-start / range-resume / range-try / range-pause / range-ok / range-miss / range-done и др.
- **Help**: справка и порядок действий.

### Apps Script проект (папка `appsscript/`)
- `config.gs` — константы/колонки/настройки (RANGE_ALLOWED_MIME, пороги, и т.п.).  
  - `RANGE_ALLOWED_MIME = ['video/mp4','video/quicktime']`
  - `RANGE_SLEEP_MS = 120` (легкий троттлинг между строками Range)
  - `RANGE_RESUME_DELAY_MS = 60000` (1 мин; автопауза с таймером; текст тоста «≈60–120 с»)
- `bootstrap.gs` — первичная инициализация листов/шапок/Help.
- `audit.gs` — меню и команды: v3 list/get, Range-проба длительности, логика паузы, логирование.
- `dispatch_github.gs` — формирование батча и отправка `repository_dispatch` в GitHub.
- `appsscript.json` — манифест (`oauthScopes`, timezone, advanced services). Обязательно:  
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive`
  - `https://www.googleapis.com/auth/script.external_request`
  - `https://www.googleapis.com/auth/script.scriptapp`

### GitHub Workflows (`.github/workflows/`)
- `apps_script_deploy.yml` — деплой кода из папки `appsscript/` в проект Apps Script (через Service Account и Apps Script API).
- `drive_compress.yml` — пакетное сжатие видео (rclone + ffmpeg) по событию `repository_dispatch` (тип `drive_compress`).

---

## 3) Меню и команды (точные названия)

- **Обновить список (v3 list)**
- **Добрать длительность (v3 get — быстрый)**
- **Добрать длительность (Range — надёжный)** ← с «ё»
- **Автомаркировка Recommend**
- **Применить Recommend → Action**
- **Проверить ревизии / Удалить отмеченные ревизии**
- **Экспортировать задачи (CSV)**
- **Очистить логи / Сбросить курсор Range**

Индикаторы в ячейках:
- v3 get: во время запроса DurationSec отображает «⏳ get…» (мягкая жёлтая); по завершении очищается.
- Range: при автопаузе пишет в `Duration Sec` «⏸ Пауза (≈60–120 с)» и мягко подсвечивает; после возобновления очищает.

---

## 4) Методы определения длительности

- **v3 get — быстрый**: читает метаданные duration/width/height там, где Drive их отдаёт. Дешёво и быстро.
- **Range — надёжный**: частично читает видео (**head ~512KB; tail 2MB → 8MB**), извлекает **только длительность** (width/height в Range отключены ради скорости; можно дополнительно подтянуть WH из dbg).  
  - Поддерживаемые контейнеры Range: **`video/mp4`, `video/quicktime`** (MP4/QuickTime).  
    MKV/WebM/AVI не трогаем, для них полагаемся на v3 get.  
  - Паузы:
    - короткая между строками: `RANGE_SLEEP_MS = 120` мс;
    - **автопауза** при приближении к лимиту Apps Script: ставим time‑trigger + тост «Пауза (≈60–120 с)».  
      Используем единый `RANGE_RESUME_DELAY_MS = 60000` для таймера и текста.

События Range в логе: range-start / range-resume / range-try / range-pause / range-ok / range-miss / range-done.  
Статусы: `range: trying […]`, `range: mvhd@head|tail(2MB|8MB)`, `range: not found […]` и т.п.

---

## 5) Автомаркировка и профили сжатия

Цель — экономия ≥20% и ≥5 MB.

Базовые целевые «битрейты» (HEVC/H.265, cap=720p):
- **normal**: ~10 MB/мин
- **aggressive**: ~7 MB/мин
- Аудио: AAC 96k, fps — copy (по умолчанию)

Правила (сводка):
- Коротыши `< 20s` или очень маленькие `< 4MB` → **skip**.
- Если `Height ≥ 1080` или неизвестна, но `MB/мин > 14` → минимум **normal** (даунскейл до 720p).
- Если `Height 720–1079`:
  - `MB/мин > 18` → **normal**
  - `MB/мин > 25` → **aggressive**
  - иначе **skip**
- Если `Height < 720` или высота отсутствует:
  - `MB/мин > 15` → **normal**
  - `MB/мин > 22` → **aggressive**
  - иначе **skip**
- Оценка экономии: `EstNewSizeMB = длительность_мин * таргет`. Если экономия `<20%` или `<5MB` — понижаем до **skip**.

Поля:
- **MBperMin** (техническое имя оставляем без пробелов; логика построена на `COL.*`, а не на текст шапки)

---

## 6) Экспорт/батч‑отправка в GitHub Actions

**CSV (минимальный):** `fileId,action,recommend,estNewSizeMB,why`

**Repository Dispatch (батч):**
- **event_type:** `"drive_compress"`
- **client_payload.files:** массив объектов ср. вида:
  ```json
  { "fileId": "xxx", "action": "normal|aggressive", "estNewSizeMB": 9.8, "recommend": "normal|aggressive|skip", "why": "MB/min high; 1080p->720p" }
  ```
- Верхний предел размера батча: **20** файлов.
- Отправка из `dispatch_github.gs`: POST `https://api.github.com/repos/Afanasiev-Oleg/drive-compress/dispatches` с заголовками:
  - `Authorization: token <GH_PAT>` (Script Properties в Apps Script)
  - `Accept: application/vnd.github+json`

---

## 7) GitHub Workflows

### `apps_script_deploy.yml` — деплой Apps Script
- **on:** `push` в `main` (и/или `paths: appsscript/**` + ручной `workflow_dispatch`).
- Чек-аут репо → получение токена по `GCP_SA_JSON` → `projects.updateContent` (Apps Script API) для `SCRIPT_ID`.
- После успешного ранa: код из папки `appsscript/` развёрнут в Apps Script.

**Требуемые секреты (Repo → Settings → Actions → Secrets):**
- `SCRIPT_ID` — ID Apps Script проекта
- `GCP_SA_JSON` — полный JSON ключа Service Account

**Требуемые настройки:**
- В Apps Script включить **Advanced Google Services → Drive API**.
- В GCP включить **Apps Script API** у проекта SA.
- Проект Apps Script расшарить SA (Editor).

### `drive_compress.yml` — пакетное сжатие видео
- **on:** `repository_dispatch: { types: [drive_compress] }`
- Получает `client_payload.files[]`, для каждого файла:
  - скачивание (rclone + SA JSON);
  - `ffmpeg` профиль:
    - **normal:** `-c:v libx265 -crf 28 -preset medium -vf "scale='min(1280,iw)':-2" -c:a aac -b:a 96k -movflags +faststart`
    - **aggressive:** `-c:v libx265 -crf 30 -preset medium -vf "scale='min(1280,iw)':-2" -c:a aac -b:a 96k -movflags +faststart`
  - загрузка поверх того же `fileId` (ревизия).  
- Секрет `GCP_SA_JSON` обязателен.

---

## 8) Права/скоупы и включаемые API

- `appsscript.json → oauthScopes` (обязательно включён `script.scriptapp` для `ScriptApp.getProjectTriggers()`).
- В редакторе Apps Script (иконка пазла) включить **Drive API**.
- В Google Cloud Console включить **Apps Script API** для GCP‑проекта SA.
- Доступ к файлам/папкам Drive — через расшаривание на Service Account (Viewer/Content/Editor по необходимости).

---

## 9) Сценарий использования («из коробки»)

1. **Обновить список (v3 list)** — базовое наполнение таблицы.
2. **Добрать длительность (v3 get — быстрый)** — вытащить duration/WH там, где отдаёт Drive.
3. **Добрать длительность (Range — надёжный)** — добить пустые `Duration Sec`. Автопауза с тостом «≈60–120 с».
4. **Автомаркировка Recommend** — на базе `MBperMin` и `Height` выставляет профили.
5. **Применить Recommend → Action** — переносит рекомендованный профиль в `Action`.
6. **Экспортировать задачи (CSV)** или **Отправить в GitHub (repository_dispatch)** — запуск пакетного сжатия.

Ревизии: команды «Проверить/Удалить отмеченные ревизии» экономят место (оставляют последнюю ревизию).

---

## 10) Критерии готовности проекта

- Листы созданы; меню доступно.
- v3 list наполняет таблицу; v3 get выдаёт duration/WH там, где можно.
- Range надёжно добивает длительность; пишет статусы и лог; работает пакетами с паузами.
- Автомаркировка/Применить выставляют `Action`; экспорт/dispatch формирует задачи на сжатие.
- Вся логика работает на бесплатных квотах; **без платного GCP**.

---

## 11) Политика патчей и коммит‑месседжи

- Предпочтительный формат: **git‑format patch** «под Clipboard» (начинается с `From … Mon Sep …`).  
  Для крупных правок — PR из ветки.
- Исторически был формат «якорных вставок» (/* INSERT START/END */), но сейчас основной путь — PR/patch.
- Примеры сообщений коммитов:
  - `audit: human-readable headers (keep MBperMin)`
  - `bootstrap/audit: human-readable column headers (keep MBperMin)`
  - `dispatch: batch repository_dispatch (event_type=drive_compress, up to 20 files)`
  - `config: add RANGE_RESUME_DELAY_MS=60000`
  - `range: pause indicator uses RANGE_RESUME_DELAY_MS`

---

## 12) Трблшутинг (частые вопросы)

- **Specified permissions are not sufficient… ScriptApp.getProjectTriggers** → добавь `https://www.googleapis.com/auth/script.scriptapp` в `appsscript.json` и повторно авторизуй в таблице.
- **“User has not enabled the Apps Script API”** → включи на https://script.google.com/home/usersettings (если используешь OAuth), и **Apps Script API** в GCP‑проекте SA (если используешь Service Account).
- **Workflow не стартует** → проверь `on.push.branches`/`paths` и что изменились файлы в `appsscript/**`.
- **repository_dispatch не стартует** → проверь `event_type`, наличие `GH_PAT` в Script Properties, и права токена на запись в репо.

---

## 13) Бэклог (возможные улучшения)

- Fallback профиль `libx264` по флагу (на случай несовместимости HEVC).
- Конфигурируемый размер батча (по умолчанию 20).
- Опция `-r 30` для агрессивного профиля по флагу.
- Автоматический даунскейл только при `Height ≥ 1080` (настраиваемый порог).
- Разделённые логи по шагам в `drive_compress.yml` (до/после размер).

---

## 14) Что важно запомнить ассистенту

- Репо и ветка: **Afanasiev-Oleg/drive-compress@main**; RAW‑база HEAD → формировать патчи по ней.
- Сохранять `MBperMin` как техническое имя колонки.
- Range работает только для `video/mp4` и `video/quicktime`.
- Автопауза — единая константа `RANGE_RESUME_DELAY_MS = 60000` («≈60–120 с»).
- `repository_dispatch` — **одним батчем** (до 20 файлов), `event_type="drive_compress"`.

