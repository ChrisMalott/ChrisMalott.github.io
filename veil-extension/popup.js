const box = document.getElementById("enabled");
chrome.storage.sync.get({ enabled: true }, (s) => { box.checked = s.enabled; });
box.addEventListener("change", () => chrome.storage.sync.set({ enabled: box.checked }));
