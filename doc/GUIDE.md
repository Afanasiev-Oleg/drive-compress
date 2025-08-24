# Drive-Compress — Guide по GitHub Workflow’ам и деплою Apps Script

Этот файл описывает, **как работает автоматизация в репозитории** и что нужно для стабильной работы:
- деплой кода Google Apps Script из репозитория;
- батч‑запуск сжатия видео через GitHub Actions по `repository_dispatch`.

> TL;DR: Делаем изменения → PR → merge в `main` → **Deploy Apps Script** выкачивает содержимое папки `appsscript/` в проект Apps Script.  
> В таблице Google запускаем «Экспорт/Отправить задачи» → Apps Script шлёт `repository_dispatch` с батчем файлов → **drive_compress** скачивает/сжимает/заливает обратно.

---

## 1) Структура репозитория

```
appsscript/
  appsscript.json     # манифест Apps Script (scopes/таймзона/advanced services)
  audit.gs            # v3 list/get, Range-проба длительности, меню и логика таблицы
  bootstrap.gs        # первичное создание листов/шапок/Help
  config.gs           # константы, колонки, пороги, диапазоны
  dispatch_github.gs  # формирование батча и отправка в GitHub (repository_dispatch)

.github/workflows/
  apps_script_deploy.yml  # деплой на Apps Script при изменениях в appsscript/*
  drive_compress.yml      # пакетное сжатие видео (rclone + ffmpeg) по событию repository_dispatch
```

---

## 2) Секреты репозитория (Settings → Secrets and variables → Actions → **New repository secret**)

**Обязательные** для работы обоих пайплайнов:

- `SCRIPT_ID` — ID проекта Apps Script, куда деплоится код  
  (в Apps Script: **Project Settings → Script ID**).
- `GCP_SA_JSON` — **полный JSON** сервисного аккаунта (Service Account), у которого есть доступ **Editor** к проекту Apps Script *и* разрешён **Apps Script API** в его GCP‑проекте.

> Для отправки батчей из самой таблицы (Apps Script → GitHub) **в Script Properties** проекта Apps Script должен быть прописан `GH_PAT` (Personal Access Token с правами `repo:write` для этого репозитория). Это **не секрет GitHub‑Actions**, он хранится в Apps Script (File → Project properties → Script properties).

**Опционально (если используете OAuth вместо сервисного аккаунта для деплоя):**
- `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_REFRESH_TOKEN` — если ваш `apps_script_deploy.yml` авторизуется как пользователь. Обычно **не требуется**, рекомендуем вариант с Service Account выше.

---

## 3) Деплой Apps Script из GitHub (workflow `apps_script_deploy.yml`)

**Триггер:** `push` в ветку `main` (и/или изменения в `appsscript/**`).  
**Что делает пайплайн:**
1. `actions/checkout` — забирает репозиторий.
2. Пишет секрет `GCP_SA_JSON` во временный файл и получает токен через JWT.
3. Скрипт‑пушер (Node) собирает содержимое `appsscript/*.gs` + `appsscript.json` и вызывает **Apps Script API → `projects.updateContent`** для `SCRIPT_ID`.
4. На выходе в логах видно: `✅ Updated Apps Script project <SCRIPT_ID>`.  

**Предварительные условия, без которых деплой не пройдёт:**
- Проект Apps Script расшарен сервисному аккаунту (кнопка **Share** → добавить `…@…iam.gserviceaccount.com` с ролью **Editor**).
- В **GCP проекта** сервисного аккаунта включён **Apps Script API**:  
  *Google Cloud Console → APIs & Services → Library → Apps Script API → Enable*.
- В самом редакторе Apps Script включены необходимые **Advanced Google Services** (пазл‑иконка): **Drive API** (версия, доступная в редакторе).  
  В `appsscript.json` должны быть соответствующие `oauthScopes` (они уже указаны в этом репо).

**Как пользоваться:**
- Любая правка в папке `appsscript/` → PR → Merge → пайплайн зальёт код в связанный проект Apps Script.  
- После успешного деплоя команды в меню таблицы становятся доступными автоматически (перезапускать руками проект не требуется).
- Рекурсивный обход при «Обновить список (v3 list)» настраивается в листе Config: колонка C — “Recursive Scan (Y/N)”; по умолчанию N (только указанная папка), Y — обход с подпапками.

---

## 4) Запуск сжатия — workflow `drive_compress.yml`

**Триггер:** `repository_dispatch` c типом **`drive_compress`**.  
Событие отправляет скрипт `dispatch_github.gs` из таблицы (батч до **20** файлов).

**Ожидаемый payload:**
```json
{
  "event_type": "drive_compress",
  "client_payload": {
    "files": [
      { "fileId": "xxx", "action": "normal",    "estNewSizeMB": 9.8, "recommend": "normal",    "why": "MB/min high; 1080p->720p" },
      { "fileId": "yyy", "action": "aggressive","estNewSizeMB": 7.2, "recommend": "aggressive","why": "short clip; high MB/min" }
    ]
  }
}
```

**Что делает пайплайн:**
1. Поднимает `ubuntu-latest`, ставит `rclone` и `ffmpeg`.
2. Авторизуется к Google Drive через **`GCP_SA_JSON`** (service account).
3. Для каждого элемента `files[]`:
   - скачивает оригинал по `fileId`;
   - применяет профиль:
     - **normal:** `-c:v libx265 -crf 28 -preset medium -vf "scale='min(1280,iw)':-2" -c:a aac -b:a 96k -movflags +faststart`
     - **aggressive:** `-c:v libx265 -crf 30 -preset medium -vf "scale='min(1280,iw)':-2" -c:a aac -b:a 96k -movflags +faststart`
   - загружает обратно **в тот же `fileId`** (через ревизии).
4. В логах шагов видны `fileId`, профиль и размеры до/после.

**Ручной тест (без таблицы):**
```bash
curl -H "Authorization: token <GH_PAT>" \
     -H "Accept: application/vnd.github+json" \
     -X POST https://api.github.com/repos/Afanasiev-Oleg/drive-compress/dispatches \
     -d '{"event_type":"drive_compress","client_payload":{"files":[{"fileId":"test","action":"normal","estNewSizeMB":9.8,"recommend":"normal","why":"test"}]}}'
```
`GH_PAT` здесь — персональный токен пользователя, у которого есть доступ на запись к репозиторию.

---

## 5) Как из таблицы отправляется батч (коротко)

В `dispatch_github.gs` формируется массив `files[]` из строк листа **Videos**, где:
- `Action ∈ {normal, aggressive}` и `FileId` не пустой;
- берутся `recommend`, `estNewSizeMB`, `why` из соответствующих колонок.

Затем выполняется POST на GitHub API `/repos/<owner>/<repo>/dispatches` с `event_type: "drive_compress"` и `client_payload.files`.  
Размер батча ограничен **20** файлами. В лист **Log** пишется событие `dispatch-batch`.

> Обязательно: в **Script Properties** проекта Apps Script должен быть ключ `GH_PAT` с токеном GitHub (scope `repo`, хватит `public_repo` для публичных).

---

## 7) Авто‑PR из dev в main

В репозитории настроен workflow `.github/workflows/auto_pr_from_dev.yml`, который:
- срабатывает на `push` в ветку `dev` и на ручной `workflow_dispatch`;
- проверяет, открыт ли уже PR с `head=dev` → `base=main`;
- если PR уже открыт — ничего не делает; если нет — создаёт PR с заголовком `Auto PR: dev → main`.

Права: достаточно встроенного `GITHUB_TOKEN` с `pull-requests: write`.

Как проверить:
1) Сделайте любой коммит в `dev` и выполните `git push`.
2) Откройте вкладку Actions — увидите запуск `auto_pr_from_dev`.
3) В Pull requests появится авто‑PR (если ранее не был открыт).

---

## 6) Типовые проблемы и их решение

- **403 Apps Script API / “User has not enabled the Apps Script API”**  
  Включить API здесь: https://script.google.com/home/usersettings (галочка “Enable Google Apps Script API”), под тем пользователем, от имени которого делаете вызов.  
  Для Service Account — включить **Apps Script API** в его GCP‑проекте.

- **403 при `projects.updateContent`**  
  Проект Apps Script не расшарен сервисному аккаунту. Нужен доступ **Editor** по email сервисного аккаунта.

- **Advanced service Drive v2/v3 в редакторе**  
  В редакторе Apps Script включите **Drive API** (версия в UI может отображаться как “v2/Drive”). На стороне облака параллельно включён Google Drive API.

- **Workflow не стартует после merge**  
  Проверь фильтры в `apps_script_deploy.yml` (раздел `on: push: paths:`) — должны охватывать `appsscript/**`.

- **`repository_dispatch` не приходит**  
  Проверить: (а) в таблице реально сформирован `files[]`; (б) в Script Properties есть `GH_PAT`; (в) `event_type` совпадает с `drive_compress` в YAML; (г) у токена есть доступ на запись к репозиторию.

---

## 8) Контакты/заметки

- Работает на бесплатных квотах GitHub Actions и Apps Script.
- Никаких платных GCP‑сервисов (Cloud Run и т.п.) не используется.
- При желании можно добавить fallback‑профиль `libx264` (по флагу) — это делается в `drive_compress.yml`.
