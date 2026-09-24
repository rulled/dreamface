# Privacy Policy for DreamFace Batch Assistant

*Last updated: September 24, 2026*

**DreamFace Batch Assistant** is a Manifest V3 browser extension designed for operators and creators running bulk avatar video generation tasks on the DreamFace website (`dreamfaceapp.com`).

---

## 1. Information the Extension Accesses and Processes

The extension processes only the data necessary to provide its core functionality:
- **Audio Files**: Audio files explicitly selected by the user from their local device for speech generation.
- **Video Selection**: Avatar video identifiers selected by the user on the DreamFace platform.
- **Account Session Tokens**: User session credentials (token, clientId, userId, accountId) captured from the user's active DreamFace web session to dispatch generation requests across the user's own accounts.
- **Generation Status**: Task identifiers (`workId`, `animate_id`) and status reports from DreamFace APIs to monitor progress and trigger downloads.

---

## 2. How Data Is Processed (Local Processing)

- **Local Audio Normalization**: All audio preparation, padding, format conversion, and duration checks are performed **100% locally** within the browser's sandbox using bundled WebAssembly (FFmpeg WASM).
- **No Third-Party Analytics or Developer Servers**: The extension **never** communicates with any developer-owned, third-party advertising, tracking, or telemetry servers. All network requests occur strictly between the user's browser and official DreamFace endpoints (`*.dreamfaceapp.com`, `*.aliyuncs.com`).
- **Local Storage**: User preferences, queue states, and temporary audio binary blobs are stored exclusively on the user's machine using `chrome.storage.local` and browser `IndexedDB`.

---

## 3. Permissions Justification

The extension requests only minimal permissions required for its features:
- **`alarms`**: Used to schedule periodic background monitoring of long-running video generation tasks and manage queue retry timers without continuous CPU polling.
- **`downloads`**: Used to automatically save finished avatar videos from DreamFace Creations directly to the user's device once rendering is complete.
- **`storage`**: Used to persist local operator settings, batch configurations, and account health data.
- **`offscreen`**: Used to host the sandboxed FFmpeg WebAssembly runtime for local audio transcoding without blocking browser UI threads.

---

## 4. Data Sharing and Sale

- **No Sale of Data**: We do not sell, rent, monetize, or trade user data under any circumstances.
- **No Advertising**: Data is never used for advertising, behavioral profiling, credit evaluation, or marketing.
- **Direct Service Communication Only**: Data is transmitted solely to DreamFace to fulfill the generation tasks initiated by the user.

---

## 5. Data Retention and Security

Temporary queue data and local audio blobs stored in IndexedDB are retained only for the duration of the batch processing job or until cleared by the user in the extension interface. Session tokens are stored in protected browser storage and are never exposed externally.

---

## 6. Contact and Source Code

The extension source code is open and verifiable.

- **Repository**: [https://github.com/rulled/dreamface](https://github.com/rulled/dreamface)
- **Issue Tracker**: [https://github.com/rulled/dreamface/issues](https://github.com/rulled/dreamface/issues)
