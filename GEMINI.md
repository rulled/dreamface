# DreamFace Batch Assistant — Project Memory & Instructions

## Project Overview

**DreamFace Batch Assistant** (v1.3.1) is a Manifest V3 Chrome Extension designed for operators running bulk avatar video generation across multiple DreamFace accounts. It automates local audio normalization/padding, job dispatch across accounts, status tracking, and result video downloading with chapter markers.

- **Design Philosophy**: Quiet, direct, utilitarian. Shows clear workflow states (generating, downloading, completed, failed) rather than low-level implementation details.
- **Repository Type**: Vanilla JavaScript (ES Modules + Classic Extension Scripts) with zero external runtime npm dependencies.

---

## Architecture & Core Modules

```
DreamFace/
├── manifest.json            # MV3 configuration (background, offscreen, content scripts, permissions)
├── background.js            # Background service worker: session capture, storage, alarms, downloads
├── offscreen.html / .js     # Offscreen document: FFmpeg WASM audio normalization, engine runner
├── content_script.js        # Content script: page scraping, download hooks, sync creations snapshot
├── injected.js              # MAIN-world script: fetch interception, watermark bypass, avatar discovery
├── popup.html / popup.js    # Operator UI: batch builder, avatar selection, live queue progress
├── setup-state.js           # UI state persistence (metadata in chrome.storage.local, audio blobs in IndexedDB)
├── dreamface-api.js         # Pure API client bound to account credentials (OSS upload, avatar add, batch animate)
├── queue-policy.js          # Pure dispatch policy: LPT (longest audio first), multi-account ranking, plan simulation
├── account-health.js        # Multi-account health ledger: quotas, cooldowns, exponential backoff, drain metrics
├── features.js              # Feature flags for progressive rollout / rollback
├── trace.js / trace-store.js# Structured NDJSON event tracing into IndexedDB
├── popup-trace.js           # Trace export UI & controls
├── package-release.ps1      # Release packaging script (validates allowlist, outputs to dist/)
├── vendor/                  # Bundled dependencies (ffmpeg WASM)
└── tests/                   # Node.js built-in test suite (pure logic, policy, health, packaging)
```

---

## Key Domain Logic & Workflows

### 1. Multi-Account Management & Quotas
- **Identity**: Accounts are identified by `userId`, `accountId`, `clientId`, and `token`.
- **Quotas**: Queried via `/dw-server/face/get_batch_times`. Premium accounts report sentinel `1/1`, while metered accounts have limited `remaining_times`.
- **Health & Backoff** (`account-health.js`):
  - *Quota exhausted*: Account is paused without penalizing health score until reset.
  - *Rejection under load* (running works > 0): Short backoff (60s), no streak escalation.
  - *Unexplained rejection*: Exponential backoff cooldown up to 2 hours.
  - *Drain rate*: Accounts are dynamically tiered by turnaround speed (`msPerWork`).

### 2. Dispatch Policy & Scheduling (`queue-policy.js`)
- **LPT (Longest Processing Time)**: Longest audio units are dispatched first to minimize the long-tail wait time.
- **Candidate Ranking**: Accounts are ranked by tier (fresh vs backlogged), quota type (free/unlimited prioritized over metered reserve), and turnaround speed.

### 3. Audio Transformation
- **Audio Normalization**: Handled in `offscreen.js` via FFmpeg WASM (sample rate, loudness, format conversion).

### 4. Popup State Persistence (`setup-state.js`)
- Chrome destroys the extension popup DOM when focus is lost.
- Metadata is serialized to `chrome.storage.local` under `bulkSetupState`.
- Large audio binary data is stored in IndexedDB (`dreamface-setup-db`) to prevent hitting `chrome.storage` quotas.
- Avatar selections are tracked by video identity (URL path) rather than grid index so re-ordering on DreamFace does not corrupt selections.

---

## Developer Commands & Verification

### Running Tests
The project uses the native Node.js test runner:
```powershell
npm test
# Or directly with node:
node --test "tests/*.test.mjs"
```
Or with specific test files:
```powershell
node --test tests/queue-policy.test.mjs tests/account-health.test.mjs
```

### Building Release Package
Create release zip with:
```powershell
powershell -ExecutionPolicy Bypass -File .\package-release.ps1
```
The script stages files, verifies the runtime whitelist, ensures no sensitive files/dumps (`Users_*.js`, `AVATAR_BULK_RESEARCH.md`) leak into the archive, and writes to `dist/dreamface-batch-assistant-v<version>.zip`.

---

## Coding Standards & Constraints

- **Manifest V3 Isolation**:
  - Service worker (`background.js`) has no DOM access.
  - Offscreen document (`offscreen.js`) has no direct `chrome.storage` access; communicate with background via `callBackground()`.
  - Content scripts inject `injected.js` into `MAIN` world for fetch interception and use `dataset` or custom events for bridge communication.
- **Pure Functions**: Keep queue policies, health calculations, and serializers pure and deterministic to allow seamless unit testing in Node.js.
- **No External Runtime Dependencies**: Do not introduce npm packages to the extension runtime; all modules must run natively in Chrome MV3.
- **Comments & Documentation**: Preserve domain comments explaining reverse-engineered endpoints and calibrations.
