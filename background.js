let extensionEnabled = false;

chrome.storage.local.get('extensionEnabled', (data) => {
  extensionEnabled = data.extensionEnabled !== false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionEnabled) {
    extensionEnabled = changes.extensionEnabled.newValue;
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'newTabOpened' }).catch(() => {});
    }
  });
});