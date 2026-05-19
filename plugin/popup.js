// popup.js
const SERVER_URL = "http://127.0.0.1:9091";

document.addEventListener('DOMContentLoaded', () => {
  const secureBtn = document.getElementById('secure-btn');
  const tabDisplay = document.getElementById('tab-display');
  const urlDisplay = document.getElementById('url-display');

  // Sync UI state with local storage on popup opening
  chrome.storage.local.get(['secured_tab_id', 'secured_tab_url'], (res) => {
    if (res.secured_tab_id) {
      tabDisplay.textContent = `ID: ${res.secured_tab_id}`;
      tabDisplay.className = "accent";
      urlDisplay.textContent = res.secured_tab_url.substring(0, 30) + "...";
    }
  });

  secureBtn.addEventListener('click', async () => {
    // 1. Capture the active tab context in focus
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;

    const targetId = activeTab.id;
    const targetUrl = activeTab.url || "";

    // 2. Dispatch explicit registration envelope to FastAPI core router
    try {
      // Re-use your existing structures by passing routing parameters explicitly
      const response = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "channel-sync",
          messages: [{ role: "system", content: "MANUAL_CHANNEL_INITIALIZATION" }],
          target_tab_id: targetId,
          target_url_contains: targetUrl
        })
      });

      if (response.ok) {
        // 3. Commit state tokens locally on success layout path
        chrome.storage.local.set({ 
          secured_tab_id: targetId,
          secured_tab_url: targetUrl
        }, () => {
          tabDisplay.textContent = `ID: ${targetId}`;
          tabDisplay.className = "accent";
          urlDisplay.textContent = targetUrl.substring(0, 30) + "...";
          secureBtn.textContent = "✅ CHANNEL SECURED";
          secureBtn.style.background = "#9ece6a";
          secureBtn.style.color = "#1a1a24";
          
          setTimeout(() => {
            secureBtn.textContent = "🔒 SECURE CURRENT TAB";
            secureBtn.style.background = "#414868";
            secureBtn.style.color = "#c0caf5";
          }, 1500);
        });
      }
    } catch (err) {
      console.error("Failed linking connection context to adapter daemon:", err);
      tabDisplay.textContent = "DAEMON OFFLINE";
      tabDisplay.className = "warning";
    }
  });
});
