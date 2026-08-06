# DreamFace Bulk API — Research Notes

> Сессия от 2026-08-05. Получено через Chrome CDP (remote-debugging-port=9222) + puppeteer-core
> Network-монитор: `C:\Users\rulled\AppData\Local\Temp\opencode\df-cdp\net.jsonl`
> Полные тела запросов: `...\df-cdp\report2.txt` (834 строки)
> Скрипты: `...\df-cdp\df-mon.mjs` (слушатель), `...\df-cdp\df-drive.mjs` (управление).

## Контекст

Проект: Chrome-расширение `DreamFace Batch Assistant` (`C:\Users\rulled\Downloads\dreamface_final`).
Сейчас расширение работает на странице `https://www.dreamfaceapp.com/avatar` и перехватывает
`POST /task/v2/submit` (1 запрос = 1 работа AVATAR_VIDEO). Патчит body добавляя `no_water_mark:1`
(см. `injected.js:81` `addNoWatermarkToAvatarSubmit`, `injected.js:587` перехват fetch).

Цель: перевести пайплайн на bulk-страницу `https://www.dreamfaceapp.com/avatar-bulk` →
`POST /dw-server/face/animate_image_batch` (1 запрос = N работ).

## Реальные ID из логов (аккаунт пользователя на момент сессии)

- user_id: `b13d4ba42f3e754e4d96f6e577888b20`
- account_id: `69a8188f5151ec0007293df0`
- avatar_id (результат /df-server/avatar/add): `6a73b3894b19790007587b8c`
- batch_config preset id ("Список Скриптов 03"): `6a699b6de4210142487e678f`
- template_id (Dynamic Avatar / avatar.1): `6606889f54e4e700070db4b1`
- audio_id голоса Thomas (для pt_infos): `0c7f1002c2924806a042c52dcb71f2ce`, voice_engine_id: `onyx-all`
- 3 work_id после bulk-генерации: `6a73b3ae2ef75a47c1e7b012`, `...b014`, `...b016`
- OSS-домен: `uss3.dreamfaceapp.com` (видео: `/web/animate/material/<uuid>.mp4`, аудио: `/web/avatar/audio/<uuid>.mp3`, обложки: `/web/common/material/<uuid>.jpg`)

## Сравнение /avatar vs /avatar-bulk

| | `/avatar` (single) | `/avatar-bulk` (bulk) |
|---|---|---|
| file input | `accept:"image/*, video/*"`, `multiple:false` | `accept:".mp3,.wav,.ogg,.aac,.flac,.webm,.mp4"`, `multiple:true` |
| UI | 1 аватар + 1 аудио | 1 аватар × N аудио (лимит "Video Limit 0/30") |
| Запуск генерации | `POST /task/v2/submit` | `POST /dw-server/face/animate_image_batch` |
| Гранулярность | 1 запрос → 1 работа | 1 запрос → N работ (`success_count`/`fail_count`) |
| no_water_mark | патчится расширением в body | уже в payload (`no_water_mark:1`) |
| Квота | weekly credits (60) | + отдельная `get_batch_times` (`total_times`/`remaining_times`) |
| Загрузка face-видео | `/df-server/avatar/add` | **тот же `/df-server/avatar/add`** |

## Полный bulk-флоу (зафиксированный: 1 видео + 3 аудио → 3 работы)

### A. Инициализация страницы
- `POST /df-server/avatar/list` `{user_id, account_id, name:"", themes:["DEFAULT"]}` — список аватаров
- `POST /df-server/audio/v2/get_animate_audio_list` `{code:"en"}` — встроенные голоса (большой список, ~144KB)
- `GET /dw-server/work/get_user_running_works/{account_id}` — running works (массив work_id)
- `POST /dw-server/batch_task/v1/list_avatar_batch_config` `{account_id, config_type:"SCRIPT"}` и `config_type:"AVATAR"` — пресеты (SCRIPT=аудио-списки, AVATAR=аватар-списки)
- `POST /dw-server/batch_task/v1/get_avatar_batch_config_detail` `{id}` — детали пресета: `{id,name,type,avatar_configs:[],script_configs:[]}`
- `GET /dw-server/face/get_batch_times?user_id=&account_id=&work_type=AVATAR_VIDEO` → `{total_times:1, remaining_times:1}` — **квота batch** (не уменьшилась после запуска — требует уточнения)
- `POST /dw-server/work/is_new_user` `{account_id, work_type:"AVATAR_VIDEO"}` → `{data:false}`
- `POST /df-server/pt/get_pt_video_info` `{user_id, account_id, app_version:"4.7.1"}` — список шаблонов (`template_list`), из него берётся `template_id`

### B0. Загрузка face-видео в OSS (presigned) — ЗАКРЫТО
- `POST /dw-server/oss/put_url` JSON: `{user_id, file_name:"dic_3.mp4", content_type:"video/mp4", dir:"WEB_ANIMATE_MATERIAL"}`
- Ответ: `data.put_url` (signed, домен `dreamface-resource.oss-us-east-1.aliyuncs.com`, query: `x-oss-date`, `x-oss-expires=300`, `x-oss-signature-version=OSS4-HMAC-SHA256`, `x-oss-credential`, `x-oss-signature`) + `data.file_url` (публичный CDN: `https://uss3.dreamfaceapp.com/web/animate/material/<uuid32hex>.mp4`) + `data.content_type`
- `PUT <put_url>` с телом = бинарный файл, заголовок `Content-Type: video/mp4` (ОБЯЗАТЕЛЕН — иначе подпись невалидна)
- В дальнейших API используется `file_url` (uss3-домен), НЕ `put_url`.
- ⚠️ В логах CDP этот PUT помечен `net::ERR_ABORTED` — артефакт перехвата (сайт делает PUT через fetch). Реально сервер принимает файл. В расширении: `fetch(put_url, {method:'PUT', body:file, headers:{'Content-Type':contentType}})`.

### B1. Загрузка аудио в OSS (multipart через API, НЕ presigned) — ЗАКРЫТО
- `POST /dw-server/phone_file/upload_audio_with_dir` — multipart/form-data:
  - `file` = бинарный mp3 (filename = оригинальное имя, Content-Type: audio/mpeg)
  - `userId` = user_id
  - `ossDir` = `AVATAR_AUDIO`
- Ответ: `data.file_path` = `https://uss3.dreamfaceapp.com/web/avatar/audio/<uuid>.mp3`

### B2. Регистрация face-видео → avatar_id
- `POST /df-server/avatar/add` — **multipart/form-data**:
  - `user_id`, `account_id`
  - `url` = `file_url` из B0 (`https://uss3.dreamfaceapp.com/web/animate/material/<uuid>.mp4`)
  - `type` = `VIDEO`
  - `support_multi_face` = `true`
  - Ответ: `avatar.id`, `type:"VIDEO"`, `path`, `cover_path`, `face_count`, `human_count`, `face_infos:[{face_box,age,gender,face_config:{1440:{photo_file_path,face_data:[{face_location:{left_upper_x,...},five_lands}]}}}]`, `width`, `height`, `name:"Uploaded Avatar"`
- `avatar_id` из ответа используется в `animate_image_batch` (photo_info_list + pt_infos).

### C. Сохранение/обновление batch-конфига (пресет)
- `POST /dw-server/batch_task/v1/update_avatar_batch_config`:
```json
{
  "id": "6a699b6de4210142487e678f",
  "account_id": "69a8188f5151ec0007293df0",
  "type": "SCRIPT",
  "script_configs": [
    {"type":"AUDIO","audio_config":{"file_name":"004__...mp3","audio_url":"https://uss3.dreamfaceapp.com/web/avatar/audio/<uuid>.mp3","audio_start_time":0,"audio_end_time":40575.034}},
    {"type":"AUDIO","audio_config":{... 006__...mp3 ...}},
    {"type":"AUDIO","audio_config":{... 008__...mp3 ...}}
  ]
}
```
→ `{status_code:"THS12140000000", status_msg:"Success"}`

### D. Проверка текста (для TTS; для аудио — пустой)
- `POST /dw-server/batch_task/v1/batch_check_text` `{texts:[]}` → `{status_msg:"Success","data":[]}`

### E. ГЛАВНОЕ — bulk-запуск
- `POST /dw-server/face/animate_image_batch` (один запрос → N работ):
```json
{
  "aigc_img_no_save_flag": false,
  "template_id": "6606889f54e4e700070db4b1",
  "app_version": "4.7.1",
  "timestamp": 1785967534076,
  "user_id": "...",
  "account_id": "...",
  "no_water_mark": 1,
  "merge_by_server": false,
  "work_type": "AVATAR_VIDEO",
  "photo_info_list": [{
    "photo_path":"",
    "origin_face_locations":[{"left_upper_x":0,"left_upper_y":0,"right_width":1,"down_high":1}],
    "square_face_locations":[{"left_upper_x":0,"left_upper_y":0,"down_high":1,"right_width":1}],
    "five_lands":[[[1,1],[1,1],[1,1],[1,1],[1,1]]],
    "face_nums":1,
    "mask_path":"",
    "avatar_id":"6a73b3894b19790007587b8c",
    "is_default_avatar":false
  }],
  "play_types":["VIDEO","PT"],
  "pt_infos":[{
    "lan":"all",
    "audio_id":"0c7f1002c2924806a042c52dcb71f2ce",
    "context":"",
    "voice_engine_id":"onyx-all",
    "asset_id":"",
    "video_url":"https://uss3.dreamfaceapp.com/web/animate/material/<uuid>.mp4",
    "avatar_id":"6a73b3894b19790007587b8c",
    "resolution":720,
    "is_default_avatar":false
  }],
  "ext":{"track_info":"{}","sing_title":"","animate_channel":"dynamic"},
  "batch_config": {
    "id":"6a699b6de4210142487e678f",
    "name":"Список Скриптов 03",
    "type":"SCRIPT",
    "avatar_configs":[],
    "script_configs": [ ...3 audio_config из шага C... ]
  }
}
```
→ `{status_code:"THS12140000000", status_msg:"Success", data:{success_count:3, fail_count:0}}`

### F. Поллинг результата (расширение УЖЕ умеет — `injected.js`)
- `GET /dw-server/work/get_user_running_works/{account_id}` → `["...b012","...b014","...b016"]`
- `POST /dw-server/work/v2/get_recent_creation_list` `{user_id, account_id, page:1, size:30, is_web:true, app_version:"4.7.1"}` → список работ (`work_name`=audio file_name, `animate_id`, `web_work_status` 0→200, `work_type:"AVATAR_VIDEO"`)
- `POST /dw-server/work/batch_get_work_status` `{account_id, ids:[3 id]}` → `[{id, web_work_status}]`
- `POST /dw-server/work/get_batch_download_url` (расширение умеет) — финальные URL результатов

## Что уже есть в расширении (`C:\Users\rulled\Downloads\dreamface_final`)

- `injected.js` перехватывает `window.fetch`:
  - `addNoWatermarkToAvatarSubmit` (стр.81) — патчит `/task/v2/submit` body для AVATAR_VIDEO добавляя `no_water_mark:1`. Для bulk НЕ нужно (уже в payload).
  - `rememberRecentCreationsTemplate` (стр.119), `rememberBatchWorkStatusTemplate` (стр.136), `rememberSubmitContext` (стр.153), `rememberRunningWorksTemplate` (стр.197) — кэшируют шаблоны запросов с реальными headers/cookies.
  - `fetchRecentCreationsPage` (стр.239), `fetchBatchWorkStatus` (стр.287), `fetchBatchDownloadUrls` (стр.345), `fetchRunningWorks` (стр.381) — готовые функции поллинга. **bulk-пайплайн может их переиспользовать.**
- `content_script.js` — оркестрация: загрузка аудио в input, клик Generate, обработка `DreamFaceTaskSuccess`, поллинг running works (стр.1330-1378, 3607-3653).
- `offscreen.js` — нормализация аудио + pre-loop + очередь задач (стр.1046-1458).
- `popup.js` — UI батчей (`batches`, `selectedIndices`).

## План перевода пайплайна на bulk

1. **OSS upload видео** — `POST /dw-server/oss/put_url` → `PUT <put_url>` (Aliyun OSS presigned). Получить `file_url`. (См. B0.)
2. **`POST /df-server/avatar/add`** (multipart: user_id, account_id, url=file_url, type=VIDEO, support_multi_face=true) → `avatar.id`. (См. B2.)
3. **OSS upload N аудио** — `POST /dw-server/phone_file/upload_audio_with_dir` (multipart: file + userId + ossDir=AVATAR_AUDIO) → `data.file_path`. (См. B1.)
4. **`POST /dw-server/batch_task/v1/update_avatar_batch_config`** с `script_configs` (массив N audio_config) → обновить пресет. Достаточно ОДНОГО вызова с финальным списком.
5. **`POST /dw-server/face/animate_image_batch`** с `photo_info_list` (1 аватар) + `batch_config` (пресет) → `success_count=N`.
6. Поллинг — переиспользовать `fetchRunningWorks` + `fetchRecentCreationsPage` + `fetchBatchWorkStatus` + `fetchBatchDownloadUrls`.

## Незакрытые вопросы / TODO

- [x] **Presigned OSS upload** — ЗАКРЫТО. Видео: `POST /dw-server/oss/put_url` → `PUT <put_url>` (Aliyun OSS, подпись OSS4-HMAC-SHA256, TTL 300с, Content-Type обязателен). Аудио: `POST /dw-server/phone_file/upload_audio_with_dir` (multipart: file + userId + ossDir=AVATAR_AUDIO). См. разделы B0/B1.
- [ ] Уточнить квоту `get_batch_times` (`total_times`/`remaining_times`) — НЕ уменьшилась после ОБОИХ bulk-запусков (была `1/1` всегда). Похоже, это НЕ лимит на запуск batch, а что-то другое. Для пайплайна скорее некритично.
- [ ] `photo_info_list` со «странными» полями `[1,1]`/`0/1` — это «дефолтный аватар без трекинга лица», сайт шлёт именно так даже для freshly-uploaded видео. Для пайплайна копировать как-is (реальный `face_box` из `avatar/add` ответа НЕ используется в `animate_image_batch`).
- [ ] (Опц.) Для side-by-side поймать одиночный Generate на `/avatar` → реальный payload `/task/v2/submit`. Для перевода на bulk не обязательно — bulk полностью задокументирован.
- [ ] `batch_check_text` (`{texts:[]}`) — нужен только для TTS-сценария. Для аудио-пайплайна можно слать пустым (как делает сайт).
- [ ] `update_avatar_batch_config` сайт вызывает несколько раз подряд при UI-правках (добавил/удалил аудио). Для пайплайна — достаточно ОДНОГО вызова с финальным списком аудио перед `animate_image_batch`.

## Артефакты сессии

- Chrome profile: `C:\Users\rulled\AppData\Local\Temp\opencode\df-chrome-profile` (залогинен)
- CDP порт: 9222 (browser ws: `/devtools/browser/...`)
- df-mon.mjs / df-drive.mjs / report2.txt / report3.txt / net.jsonl: `C:\Users\rulled\AppData\Local\Temp\opencode\df-cdp\`
- Скачанные app-бандлы сайта (8/222): `C:\Users\rulled\AppData\Local\Temp\opencode\df_bundles\` (попытка реверса JS — прервана по таймауту)

## AUTH & MULTI-ACCOUNT (закрыто через CDP)

**Auth НЕ через cookies.** На dreamfaceapp.com всего 3 non-HttpOnly cookie (`_fbp`, `i18n_redirected`, `g_state`) — ни одна не auth. Auth = JWT-токен в localStorage.

- **localStorage key `49f290d6e8459c53f31f97de37921086`** = JSON-сессия: `{thirdPlatform, thirdId, accountId, userId, token, ...userRights}`. Это MD5-хэш имени (реальное имя скрыто приложением).
- **localStorage key `19fb90a3b8f09f14a91f48eee48c12af`** = `client-id` (32-hex), напр. `6217fbf0339dd843edbeb9a5e20c37d7`.
- **localStorage key `1d5d4096d2b4e7d671adcb4661b5725d`** = `userId` (`b13d4ba42f3e754e4d96f6e577888b20`).
- `token` — JWT HS256, payload `{exp, payload:{id, thirdPlatform, thirdId, password(хэш), thirdExt, ...}}`. **Токен экспарится** (exp в payload) → надо ре-капчурить аккаунт при истечении.
- **Заголовки каждого API-запроса** (зафиксированы через CDP Network на /avatar-bulk): `token: <JWT>`, `client-id: <32hex>`, `dream-face-web: dream-face-web`, `accept: application/json`, `content-type: application/json` (или multipart для загрузок), `Referer: https://www.dreamfaceapp.com/avatar-bulk`.

**Multi-account MVP (один профиль):**
1. Пользователь логинится в аккаунт A в текущем Chrome-профиле → content_script читает localStorage-сессию (`49f290d...`, `19fb90a3...`) → сохраняет в `chrome.storage` под именем аккаунта A.
2. Повторяет для B, C, ... (логаут → логин → капчур).
3. Перед bulk-запуском: оркестратор выбирает наименее загруженный аккаунт (через `get_user_running_works`), content_script пишет его сессию в localStorage → injected.js читает свежий `token` из localStorage в момент вызова → API-запрос идёт от имени выбранного аккаунта.
4. При 401/expired — помечаем аккаунт невалидным, просим ре-капчур.

**Cookie-экспорт `www.dreamfaceapp.com_cookies.txt` — НЕ пригоден** (только 2 non-HttpOnly cookie, без JWT). Auth только через localStorage-токен.

## IMPLEMENTATION DESIGN

**Данные пользователя (manual grouping, confirmed):**
- Группа = { videos: [File...], audios: [File...] } — пользователь набирает вручную (как текущий batch-UI, но videos = локальные файлы, не скан страницы).
- Round-robin: audio[i] → video[i mod V]. Split по видео → V bulk-единиц (1 видео + N аудио каждая).
- Никакого авто-парсинга персонажей из имён — всё ручное.

**Архитектура (миграция на bulk):**

1. `injected.js` (MAIN world) — **API-слой bulk**:
   - Капчурит template'ы (headers с `token`/`client-id`/`dream-face-web` + URL + user_id/account_id/template_id) из init-запросов страницы.
   - Доб. функции: `bulkPutUrl`, `bulkPutOssFile`, `bulkUploadAudio`, `bulkAvatarAdd`, `bulkUpdateBatchConfig`, `bulkBatchCheckText`, `bulkAnimateImageBatch`, `bulkGetBatchTimes`, `bulkListBatchConfig`, `bulkGetPtVideoInfo`. Все через `originalFetch` + token читается из localStorage **в момент вызова** (для multi-account).
   - **Удалить** `addNoWatermarkToAvatarSubmit` + патч `/task/v2/submit` (authorized). Оставить polling helpers (recent_creations, batch_work_status, running_works, download_urls).
   - Event-интерфейс: `DreamFaceBulkRequest`/`Response` (request/response пары, как существующие).
2. `content_script.js` (isolated) — **мост**:
   - Relay bulk-запросов offscreen↔injected.js (offscreen не видит MAIN world).
   - Account-switch: read/write localStorage-сессии.
   - Оставить scan + creations-download.
   - **Удалить** DOM-драйвинг (load audio в input, click Generate) — больше не нужно.
3. `offscreen.js` — **bulk-движок**:
   - Audio normalization (оставить).
   - Run-loop: для каждой bulk-единицы → (relay→injected) put_url → PUT oss → upload audios → avatar/add → update_batch_config → animate_image_batch → success_count. Потом poll running_works → enqueue в dm.
   - Account selection: проверить running_works по аккаунтам, выбрать наименее загруженный, switch (через content_script localStorage write).
4. `background.js` — account storage (chrome.storage) + DownloadManager (оставить).
5. `popup.js/html` — новый UI: account management (capture/list/select) + manual groups (видео-файлы + аудио-файлы per group) + start. Убрать scan-based video grid.

**Динамические значения (НЕ хардкодить):** user_id, account_id, client-id, token — из localStorage. template_id — из `get_pt_video_info` (template_list, default "dynamic"). audio_id + voice_engine_id для pt_infos — placeholder (реальный звук = batch_config.script_configs.audio_url); использовать дефолт из voice list. batch_config.id — `list_avatar_batch_config` → переиспользовать существующий пресет (или создать).
