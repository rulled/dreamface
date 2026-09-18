// Phase 0 trace UI: record counter, NDJSON export, clear.
// Kept out of popup.js (classic script) so the shared trace modules can stay ES modules.
// The log lives in IndexedDB, shared with the offscreen document that writes it.

import { clearTrace, readTrace, toJsonl } from './trace.js';

const exportBtn = document.getElementById('traceExportBtn');
const clearBtn = document.getElementById('traceClearBtn');
const statusEl = document.getElementById('traceStatus');
const REFRESH_MS = 2000;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(2)} МБ`;
}

function renderText(text) {
  if (statusEl) statusEl.textContent = text;
}

async function renderStatus() {
  if (!statusEl) return;
  try {
    const { lines, dropped, seq, bytes, lastError } = await readTrace();
    if (lines.length === 0 && !seq) {
      renderText('трассировка фазы 0: пусто');
      return;
    }
    const parts = [`${lines.length} записей`];
    if (dropped > 0) parts.push(`вытеснено ${dropped}`);
    parts.push(formatBytes(bytes));
    if (lastError) parts.push(`ошибка записи: ${lastError}`);
    renderText(`трассировка фазы 0: ${parts.join(' · ')}`);
  } catch (error) {
    renderText(`трассировка фазы 0: ошибка чтения (${error?.message || String(error)})`);
  }
}

async function exportTrace() {
  const { lines } = await readTrace();
  if (lines.length === 0) {
    renderText('трассировка фазы 0: нечего скачивать');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([toJsonl(lines)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: `dreamface-phase0-${stamp}.jsonl`, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

exportBtn?.addEventListener('click', () => {
  exportTrace().catch((error) => {
    renderText(`трассировка фазы 0: ошибка выгрузки (${error?.message || String(error)})`);
  });
});

clearBtn?.addEventListener('click', () => {
  clearTrace().then(renderStatus).catch(() => {});
});

void renderStatus();
setInterval(() => { void renderStatus(); }, REFRESH_MS);
