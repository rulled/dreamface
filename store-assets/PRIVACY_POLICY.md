# Privacy Policy

Last updated: 2026-04-08

DreamFace Batch Assistant is a browser extension that helps users prepare and submit batches of audio tasks on the DreamFace website.

## What the extension processes

The extension can process:
- audio files explicitly selected by the user from the local device
- DreamFace page content needed to find character cards, file inputs, queue state, and Creations results
- local extension settings and temporary queue state stored in the browser

## How the extension uses data

The extension uses this data only to:
- build the queue requested by the user
- normalize audio locally inside the browser extension
- upload files to DreamFace after the user starts a batch
- monitor queue progress on DreamFace pages
- help the user check and download ready results from DreamFace Creations

## Local processing

Audio processing is performed locally inside the extension with bundled FFmpeg files. The extension does not upload files to a developer-controlled backend.

Temporary queue data and selected files may be stored locally in browser storage or IndexedDB only for the duration required to complete the current run or recovery flow.

## Data sharing

The extension does not sell user data.

The extension does not use user data for advertising, profiling, analytics, or unrelated tracking.

The extension does not transfer user data to any developer-controlled server.

When the user starts a batch, the extension interacts with DreamFace web pages and DreamFace endpoints as part of the core product flow requested by the user.

## Permissions and access

The extension is limited to:
- DreamFace website hosts required for scanning, uploading, and checking results
- local storage needed for settings and run state
- an offscreen document needed for local audio processing and resilient queue execution

The extension does not request cookies, history, downloads, identity, geolocation, microphone, camera, or clipboard permissions.

## Data retention

Temporary queue data is kept locally only as long as necessary for queue execution, recovery, and result checking. It is not retained on a developer server.

## Contact

Support and contact:
- Repository: `https://github.com/rulled/dreamface`
- Issues: `https://github.com/rulled/dreamface/issues`
