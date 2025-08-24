# CODE_MAPPING.md — ориентир по коду (Apps Script + Workflows)

Документ для ассистента/разработчика: где что лежит, какие функции вызывать, куда смотреть при доработках.

> Репозиторий: **Afanasiev-Oleg/drive-compress** → `appsscript/`  
> Таблица: листы **Config / Videos / Log / Help**  
> Workflows: `.github/workflows/apps_script_deploy.yml`, `drive_compress.yml`

---

## 1) Файлы в `appsscript/` и их роли

### `config.gs` — **константы и схемы**
- **Колонки листа `Videos`**: объект `COL` (`1`-based индексы). Логика кода опирается на `COL.*`, а **не** на текст шапки.
  - Состав: `FileId, Path, Name, MimeType, SizeMB, DurationSec, MBperMin, Width, Height, ModifiedTime, NeedCompress, HasOldRevisions, Recommend, Why, Action, EstNewSizeMB, EstSavingsMB, MarkDeleteRevisions, Status`
  - В таблице заголовки человекочитаемые: `File ID | ... | Duration Sec | MBperMin | ...` (см. `bootstrap.gs` / `audit.gs`).
- **Диапазоны/паузы Range**:  
  `RANGE_ALLOWED_MIME = ['video/mp4','video/quicktime']` (только MP4/QuickTime)  
  `RANGE_SLEEP_MS = 120` — лёгкий троттлинг между строками Range  
  `RANGE_RESUME_DELAY_MS = 60000` — автопауза на 60–120с (используется в таймере и тосте)
- **Пороги и параметры Recommend**: целевые MB/мин (normal≈10, aggressive≈7), правила отсечки, мин. экономия (≥20% и ≥5MB).
- **Строковые константы меню/сообщений**, имена листов, лимиты батча (обычно `BATCH_LIMIT = 20`), GitHub repo owner/name при необходимости.

> Где править пороги: **только здесь** (в `config.gs`).

---

### `bootstrap.gs` — **инициализация таблицы и Help**
- Функция `bootstrap()` — создаёт листы `Config`, `Videos`, `Log`, `Help` если их нет; пишет **шапку листа `Videos`** (человекочитаемую) и справку на `Help`.
- Хелпер `getOrCreate_(ss, name)` — получить/создать лист.  
- В шапке предусмотрена центровка/заморозка первой строки, фильтр по `Status`.

> Используется при первом разворачивании или при ручном вызове. Для замены заголовков при **первом создании** листа — править массив в `appendRow([...])` здесь.

---

### `audit.gs` — **меню и вся прикладная логика**
**Точки входа (пункты меню):**
- `onOpen()` — регистрирует пункты меню с точными названиями:
  - **Обновить список (v3 list)** → `cmdRefresh()`
  - **Добрать длительность (v3 get — быстрый)** → `cmdProbeDurationsGet()`
  - **Добрать длительность (Range — надёжный)** → `cmdProbeDurationsRange()`
  - **Автомаркировка Recommend** → `cmdAutoRecommend()`
  - **Применить Recommend → Action** → `cmdApplyRecommendToAction()`
  - **Проверить ревизии / Удалить отмеченные ревизии** → `cmdCheckRevisions()` / `cmdDeleteMarkedRevisions()`
  - **Экспортировать задачи (CSV)** → `cmdExportTasksCSV()` (или аналог)
  - **Очистить логи / Сбросить курсор Range** → `cmdClearLogs()` / `cmdResetRangeCursor()`
  - *(если реализовано)* **Отправить задачи в GitHub Actions** → `cmdRepositoryDispatchBatch()`

**Основные функции:**
- `cmdRefresh()` (**v3 list**) — сканирует папки из листа `Config(A2..A)`, наполняет `Videos` метаданными Drive (Path, Name, SizeMB, ModifiedTime, MimeType и т.п.), сбрасывает курсор Range. Переустанавливает **шапку** при необходимости (важно для синхронизации с человекочитаемыми заголовками).
- `cmdProbeDurationsGet()` (**v3 get — быстрый**) — метаданные Duration/Width/Height напрямую из Drive (там, где доступны). Во время запроса ставит индикатор «⏳ get…» в `DurationSec` текущей строки.
- `cmdProbeDurationsRange()` (**Range — надёжный**) — пакетный проход, частично читает файл (**head ~512KB, tail 2MB→8MB**), парсит `moov/mvhd/mdhd` и извлекает **только длительность**. 
  - Поддержка только **`video/mp4`/`video/quicktime`** (`RANGE_ALLOWED_MIME`).
  - Логирование: `range-start`, `range-try`, `range-pause`, `range-resume`, `range-ok`, `range-miss`, `range-done`.
  - Автопауза: при приближении к лимиту времени ставит таймер на **`RANGE_RESUME_DELAY_MS`** и пишет в ячейку `DurationSec`: «⏸ Пауза (≈60–120 с)» (после возобновления очищается).
  - Статусы по строке: `range: trying […]` → `range: mvhd@head|tail(2MB|8MB)` или `range: not found […]`.
- `cmdAutoRecommend()` — выставляет `Recommend` и `Why` на основе `MBperMin` и `Height` (правила из `config.gs`).
- `cmdApplyRecommendToAction()` — переносит `Recommend` в `Action` (с учётом skip).
- `cmdCheckRevisions()` / `cmdDeleteMarkedRevisions()` — поиск и удаление старых ревизий (кроме последней), ориентир на `MarkDeleteRevisions`.
- `cmdExportTasksCSV()` — экспорт минимального CSV: `fileId,action,recommend,estNewSizeMB,why`.
- `cmdRepositoryDispatchBatch()` — собирает батч из строк с `Action ∈ {normal,aggressive}`, ограничивает до 20, вызывает отправку в GitHub (см. `dispatch_github.gs`).

**Утилиты (типично):**
- `logEvent_(type, obj)` — пишет JSON-события в `Log`.
- `ensureFilter_(sh, col)` — включает фильтр по колонке.
- `round1_ / round2_` — округления для отображения.
- `recommendProfile_(h, mbpm, sizeMB, durSec)` / `explainWhy_(...)` / `estimateNewSizeMB_(rec, durSec)` — расчёты Recommend/Why/Est*.
- Вспомогательные парсеры Range (поиск `mvhd`, чтение head/tail, resync).

> Где править шапку **после обновления списка**: массив `appendRow([...])` в `cmdRefresh()` (или соответствующая конструкция).

---

### `dispatch_github.gs` — **батч-отправка в GitHub Actions**
- Источник токена: **Script Properties → `GH_PAT`** (создаётся вручную в Apps Script: *Project properties → Script properties*).
- Основная функция: `sendRepositoryDispatchBatch_(files)` — отправляет **один** POST на  
  `https://api.github.com/repos/Afanasiev-Oleg/drive-compress/dispatches` с телом:
  ```json
  { "event_type": "drive_compress", "client_payload": { "files": [ ... ] } }
  ```
- Обёртка-меню: `cmdRepositoryDispatchBatch()` — собирает массив `files[]` из листа `Videos` (поля: `fileId, action, recommend, estNewSizeMB, why`), ограничивает до `20`, логирует `dispatch-batch` и вызывает `sendRepositoryDispatchBatch_()`.
- Обработка ответов GitHub API: тосты/логи, статусы строк.

---

### `appsscript.json` — **манифест проекта**
- `timeZone`, `exceptionLogging`, `oauthScopes` (обязательно наличие `https://www.googleapis.com/auth/script.scriptapp` для `ScriptApp.getProjectTriggers()`), Advanced Services (Drive).  
- Пример основных скоупов:
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive`
  - `https://www.googleapis.com/auth/script.external_request`
  - `https://www.googleapis.com/auth/script.scriptapp`

---

## 2) Workflows в `.github/workflows/`

### `apps_script_deploy.yml` — деплой кода в Apps Script
- **on:** `push` в `main` (или `paths: appsscript/**`).
- Использует секреты: `SCRIPT_ID`, `GCP_SA_JSON`.
- Шаги: checkout → получить OAuth токен из SA JSON → **Apps Script API `projects.updateContent`** → заливка `appsscript/*.gs` и `appsscript.json` в проект.

### `drive_compress.yml` — батч-сжатие видео
- **on:** `repository_dispatch: { types: [drive_compress] }`
- Читает `github.event.client_payload.files` → для каждого `fileId`:
  - `rclone` (c SA JSON) скачивает исходник,
  - `ffmpeg` применяет профиль:
    - **normal:** `libx265 -crf 28 ... -vf "scale='min(1280,iw)':-2" -c:a aac 96k -movflags +faststart`
    - **aggressive:** `libx265 -crf 30 ... -vf "scale='min(1280,iw)':-2" -c:a aac 96k -movflags +faststart`
  - загружает обратно по тому же `fileId` (ревизии).

---

## 3) Быстрые ориентиры для доработок

- **Заменить заголовки в шапке (читабельные):**  
  - при **первичном создании** — `bootstrap.gs` (`appendRow([...])` в блоке `if (sh.getLastRow() === 0)`),  
  - при **v3 list** — `audit.gs` (`cmdRefresh()` — конструкция, которая записывает шапку).
- **Поменять лимит батча:** `config.gs` (например, `BATCH_LIMIT = 20`) и проверка в `dispatch_github.gs`.
- **Править пороги Recommend:** `config.gs` (табличка порогов и целевых профилей).
- **Поставить/изменить автопаузу:** `config.gs` → `RANGE_RESUME_DELAY_MS`; убедиться, что используется и в таймере, и в тексте тоста (см. `cmdProbeDurationsRange()`).
- **Шаблон CSV:** `audit.gs` → `cmdExportTasksCSV()`.
- **События лога:** `audit.gs` (`logEvent_()`), список событий см. выше.

---

## 4) Карта событий и статусов

- **Log события (лист `Log`):** `range-start`, `range-resume`, `range-try`, `range-pause`, `range-ok`, `range-miss`, `range-done`, `dispatch-batch`, `dispatch-error`.
- **Статусы строк (лист `Videos`):**
  - В процессе: `range: trying [...]`
  - Успех: `range: mvhd@head | mvhd@tail(2MB|8MB)`
  - Не найдено: `range: not found [..]`
  - Диспетчеризация: `dispatched` (или текущее проектное значение)

---

## 5) Примечания по контейнерам и производительности

- Range обрабатывает **только** `video/mp4`, `video/quicktime`.  
  MKV/WebM/AVI — пропускаем в Range, рассчитываем на `v3 get`. Это ускоряет и упрощает парсер.
- Межстрочный троттлинг `RANGE_SLEEP_MS = 120` мс.  
- Автопауза/возобновление — типичный интервал **60–120 с** (по Apps Script).

---

## 6) Контрольные списки

**Перед деплоем из репозитория:**
- Secrets: `SCRIPT_ID`, `GCP_SA_JSON` (валидный JSON).
- Проект Apps Script расшарен на Service Account (Editor).
- В GCP проекта SA включён **Apps Script API**.
- В Apps Script включён **Drive API** (Advanced Services).

**Перед отправкой батча из таблицы:**
- В `Script Properties` указан `GH_PAT`.
- В колонках `Action` стоят `normal/aggressive`, есть `FileId` и `EstNewSizeMB`.
- Суммарно ≤ 20 файлов в выборке (или включён слайсинг).

---

## 7) Быстрые команды для ассистента (подсказки)

- «Поменяй пороги Recommend …» → правка `config.gs`.
- «Сделай заголовки колонок читабельными и не откатывай их в v3 list» → `bootstrap.gs` и `audit.gs` (массивы `appendRow([...])`).
- «Добавь батчевую отправку в GitHub» → `dispatch_github.gs` (`cmdRepositoryDispatchBatch()` + `sendRepositoryDispatchBatch_()`).
- «Увеличь паузу между автозапусками Range до 90с» → `RANGE_RESUME_DELAY_MS` в `config.gs` + использование в `audit.gs`.
- «Исправь дублирующийся лог mvhd@tail» → проверка двойных `if (durationSec)` в `cmdProbeDurationsRange()`.

---

> Если ассистент генерирует патч — формировать **git-format patch** по RAW `main` (не blob) с понятным commit message.
