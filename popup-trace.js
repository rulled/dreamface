// Phase 0 trace UI: record counter, NDJSON export, clear.
// Kept out of popup.js (classic script) so the shared trace module can stay an ES module.

import { clearTrace, readTrace, toJsonl, TRACE_KEY } from './trace.js';

const exportBtn = document.getElementById('traceExportBtn');
const clearBtn = document.getElementById('traceClearBtn');
const statusEl = document.getElementById('traceStatus');

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(2)} МБ`;
}

async function renderStatus() {
  if (!statusEl) return;
  try {
    const { lines, dropped, seq, bytes } = await readTrace();
    if (lines.length === 0 && !seq) {
      statusEl.textContent = 'трассировка фазы 0: пусто';
      return;
    }
    const droppedNote = dropped > 0 ? `, вытеснено ${dropped}` : '';
    statusEl.textContent = `трассировка фазы 0: ${lines.length} записей${droppedNote} · ${formatBytes(bytes)}`;
  } catch (error) {
    statusEl.textContent = `трассировка фазы 0: ошибка чтения (${error?.message || String(error)})`;
  }
}

async function exportTrace() {
  if (!exportBtn) return;
  const { lines } = await readTrace();
  if (lines.length === 0) {
    if (statusEl) statusEl.textContent = 'трассировка фазы 0: нечего скачивать';
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
    if (statusEl) statusEl.textContent = `трассировка фазы 0: ошибка выгрузки (${error?.message || String(error)})`;
  });
});

clearBtn?.addEventListener('click', () => {
  clearTrace()
    .then(renderStatus)
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, TRACE_KEY)) {
    void renderStatus();
  }
});

void renderStatus();
