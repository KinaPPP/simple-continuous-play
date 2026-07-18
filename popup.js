const toggle = document.getElementById('enabledToggle');

chrome.storage.sync.get({ enabled: true }, (data) => {
  toggle.checked = data.enabled !== false;
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
});
