# dreamface

Chrome extension for batching DreamFace audio generation tasks from the site UI.

## What it does

- Scans available DreamFace video presets on the current page
- Lets you build multiple audio-to-video batches in the popup
- Queues uploads and submits tasks one by one
- Waits out server-side queue limits and keeps a simple progress monitor

## Install locally

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this repository folder

## Release

Run the packaging script to build a clean zip archive:

```powershell
.\scripts\build-release.ps1
```

The archive is created in `dist/` and is ready to attach to a GitHub release.
