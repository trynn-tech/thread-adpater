// background.js
console.log("🌌 Yuko Background Proxy Agent initialized.");

// 1. Correct port to match FastAPI router (9091)
const BASE_URL = "http://127.0.0.1:9091";
const MCP_ENDPOINT = `${BASE_URL}/mcp/v1`;
const POLL_ENDPOINT = `${BASE_URL}/internal/next-payload`;
const RESOLVE_ENDPOINT = `${BASE_URL}/internal/resolve-payload`;

// ========================================================
//  VECTOR 1: Inbound Capture & Verification Loop (/mcp/v1)
// ========================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "INGEST_PAYLOAD") {
    console.log("🚀 Background proxy received package. Marshalling down to FastAPI...");
    const originTabId = sender.tab ? sender.tab.id : null;
    const currentUrl = message.data.url || (sender.tab ? sender.tab.url : "");

    const jsonRpcPayload = {
      jsonrpc: "2.0",
      method: "ingest_browser_thread",
      params: {
        title: message.data.title || "Active Session",
        url: currentUrl,
        tabId: originTabId,
        blocks_captured: message.data.blocks.length,
        blocks: message.data.blocks
      },
      id: Date.now()
    };

    fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonRpcPayload)
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then((rpcResponse) => {
        console.log("📦 Background proxy received routing response from FastAPI:", JSON.stringify(rpcResponse));
        const result = rpcResponse.result;
        sendResponse({ reply: result || { status: "Processed" } });
      })
      .catch((err) => {
        console.error("❌ Background link broken to local daemon:", err);
        sendResponse({
          reply: { action: "drop", message: "Failed linking to local Python Adapter daemon instance." }
        });
      });
    return true; // Keep channel open for async response
  }
});

// ========================================================
//  VECTOR 2: Long-Poll Queue Automation Engine
// ========================================================
function executeDaemonPoll() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      setTimeout(executeDaemonPoll, 1000);
      return;
    }

    const activeTab = tabs[0];
    const tabId = activeTab.id;
    const currentUrl = activeTab.url || "";

    // Skip polling if not on Claude or target web app
    if (!currentUrl.includes("claude.ai") && !currentUrl.includes("chatgpt.com")) {
      setTimeout(executeDaemonPoll, 1500);
      return;
    }

    const urlParams = `?tabId=${tabId}&url=${encodeURIComponent(currentUrl)}`;

    fetch(`${POLL_ENDPOINT}${urlParams}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Poll status returned: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data.action === "inject_and_execute") {
          console.log(`🤖 Command received for TX: ${data.tx_id}. Injecting down to tab ${tabId}.`);
          
          chrome.storage.local.set(
            {
              yuko_latch_status: "LATCHED",
              yuko_turn_origin: "AUTOMATED",
              active_tx_id: data.tx_id,
              secured_tab_id: tabId
            },
            () => {
              chrome.tabs.sendMessage(tabId, {
                type: "EXECUTE_INJECTION",
                prompt: data.prompt,
                tx_id: data.tx_id
              });
            }
          );
        }

        const delay = data.action === "idle" || data.reason ? 1000 : 300;
        setTimeout(executeDaemonPoll, delay);
      })
      .catch((err) => {
        setTimeout(executeDaemonPoll, 2000);
      });
  });
}

executeDaemonPoll();

// ========================================================
//  VECTOR 3: MVC Orchestration Controller
// ========================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "DISPATCH_PAYLOAD") {
    fetch(RESOLVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.data)
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ status: "success", server_response: data }))
      .catch((err) => sendResponse({ status: "error", message: err.toString() }));
    return true;
  }
});
