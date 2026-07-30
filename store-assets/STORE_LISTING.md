# Chrome Web Store Listing

## Primary language
Russian

## Extension name
DreamFace Batch Assistant

## Short description
Пакетная загрузка аудио в DreamFace, локальная нормализация длительности и проверка готовых результатов в Creations.

## Detailed description
DreamFace Batch Assistant помогает запускать большие партии аудио-to-avatar задач прямо из интерфейса DreamFace без ручной рутины на каждом файле.

Что делает расширение:
- сканирует доступные карточки персонажей и видео на страницах DreamFace
- позволяет собрать несколько групп персонажей для разных пакетов аудио
- принимает локальные аудиофайлы пачкой
- локально обрабатывает аудио перед отправкой
- поддерживает режимы лимита 180 и 600 секунд
- автоматически добивает слишком короткие файлы тишиной
- нарезает слишком длинные файлы на допустимые части
- умеет добавлять overlap при нарезке
- запускает очередь последовательно и показывает живой прогресс
- сохраняет состояние очереди при закрытии popup
- помогает проверить готовность результатов на странице Creations и скачать готовые файлы

Для кого:
- для операторов, которые массово запускают озвучку в DreamFace
- для команд, которые готовят большие пакеты дикторских аудио
- для пользователей, которым нужна предсказуемая подготовка длинных и коротких файлов перед отправкой

Важно:
- расширение работает только на страницах DreamFace
- расширение не отправляет данные на собственный сервер разработчика
- аудио обрабатывается локально внутри браузера
- загрузка файлов в DreamFace происходит только после явного действия пользователя

## Single purpose statement
Batch-manage DreamFace audio uploads, local audio normalization, and Creations result downloads from the DreamFace website.

## Category
Productivity

## Store contact URLs
- Homepage URL: `https://github.com/rulled/dreamface`
- Support URL: `https://github.com/rulled/dreamface/issues`
- Privacy policy URL:
  - preferred: hosted public page with the contents of `store-assets/privacy-policy.html`
  - fallback: a public repository page that shows the policy text

## Included store assets
- screenshots:
  - `store-assets/screenshots/01-builder.png`
  - `store-assets/screenshots/02-monitor.png`
  - `store-assets/screenshots/03-creations.png`
  - `store-assets/screenshots/04-audio-mode.png`
- small promo tile:
  - `store-assets/graphics/small_promo_tile_440x280.png`
- marquee promo tile:
  - `store-assets/graphics/marquee_1400x560.png`

## Data disclosure draft
- Does the extension collect or transmit user data to the developer or third parties for purposes unrelated to core functionality: `No`
- Is data sold: `No`
- Is data used for advertising or profiling: `No`
- Is data used only for the core functionality described in the listing: `Yes`
- Is data handled only on DreamFace pages and only after user action: `Yes`

## Sensitive permissions explanation
- `storage`: keeps local settings and temporary run state between popup sessions
- `offscreen`: runs local FFmpeg processing and queue orchestration while the popup is closed
- host permissions for `dreamfaceapp.com`, `www.dreamfaceapp.com`, and `tools.dreamfaceapp.com`: needed to scan DreamFace pages, upload files to the currently open DreamFace tab, and check Creations results
