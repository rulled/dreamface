# Reviewer Notes

## Single purpose

This extension batch-manages audio uploads and result collection for the DreamFace website.

## Where the extension works

The extension runs only on these DreamFace hosts:
- `https://dreamfaceapp.com/*`
- `https://www.dreamfaceapp.com/*`
- `https://tools.dreamfaceapp.com/*`

## Why these permissions are required

- `storage`
  - stores local settings and temporary run state
  - allows the popup and background/offscreen contexts to stay in sync

- `offscreen`
  - keeps local audio normalization and queue execution alive while the popup is closed
  - required for bundled FFmpeg processing in a stable extension context

- host permissions on DreamFace domains
  - scan DreamFace pages for character/video cards
  - upload user-selected files to the currently open DreamFace tab
  - monitor queue completion and check ready results on the Creations page

## What the extension does not do

- no remote code loading
- no developer analytics
- no ads
- no cookie access
- no history access
- no downloads permission
- no communication with a developer-controlled backend

## Local file handling

The user explicitly selects local audio files. Those files are temporarily stored in local browser storage/IndexedDB so the queue can continue even if the popup closes. Audio normalization is done locally with bundled FFmpeg assets shipped inside the extension package.

## Network behavior

The extension only interacts with DreamFace pages/endpoints that are part of the user-requested workflow. It does not send data to any server owned by the extension developer.

## Suggested manual review flow

1. Open a supported DreamFace page.
2. Open the extension popup.
3. Click scan to detect available character/video cards.
4. Add one group and attach local audio files.
5. Start the batch.
6. Observe progress in the popup monitor.
7. Open a DreamFace Creations page and verify result checking/downloading flow.
