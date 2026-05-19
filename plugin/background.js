// background.js
console.log("🌌 Yuko Background Proxy Agent initialized.");

const MCP_ENDPOINT = "http://127.0.0.1:9091/mcp/v1";
const POLL_ENDPOINT = "http://127.0.0.1:9091/internal/next-payload";

// ========================================================
//  VECTOR 1: Inbound Capture & Verification Loop (/mcp/v1)
// ========================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "INGEST_PAYLOAD") {
        console.log("🚀 Background proxy received package. Marshalling down to FastAPI...");

        // Extract runtime location identities from the sender's frame context
        const originTabId = sender.tab ? sender.tab.id : null;
        const currentUrl = message.data.url || (sender.tab ? sender.tab.url : "");

        const jsonRpcPayload = {
            jsonrpc: "2.0",
            method: "ingest_browser_thread",
            params: {
                title: message.data.title,
                url: currentUrl,
                tabId: originTabId, // CRITICAL: Added for Tab Target Verification matching
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
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return res.json();
        })
        .then(rpcResponse => {
            console.log("📦 Background proxy received routing response from FastAPI:", JSON.stringify(rpcResponse));
            
            // Extract the result inner block safely
            const result = rpcResponse.result;

            if (result) {
                // Return the exact execution block back over the async port line
                sendResponse({ reply: result });
            } else {
                sendResponse({ status: "Processed" });
            }
        })
        .catch(err => {
            console.error("❌ Background link broken to local daemon:", err);
            sendResponse({ reply: { action: "drop", message: "Failed linking to local Python Adapter daemon instance." } });
        });

        return true; // Keep message channel open for async sendResponse closures
    }
});

// ========================================================
//  VECTOR 2: Long-Poll Queue Automation Engine (Chaining)
// ========================================================
function executeDaemonPoll() {
    // Isolate the currently selected window layout context
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
            // If browser is out of focus or minimized, back off execution and loop
            setTimeout(executeDaemonPoll, 1000);
            return;
        }

        const activeTab = tabs[0];
        const tabId = activeTab.id;
        const currentUrl = activeTab.url || "";

        // Build target-bound polling telemetry parameters
        const urlParams = `?tabId=${tabId}&url=${encodeURIComponent(currentUrl)}`;

        fetch(`${POLL_ENDPOINT}${urlParams}`)
            .then(res => {
                if (!res.ok) throw new Error(`Poll status returned: ${res.status}`);
                return res.json();
            })
	    .then(data => {
                if (data.action === "inject_and_execute") {
                    console.log(`🤖 Command received for TX: ${data.tx_id}. Injecting down to current tab.`);
                                        
                    // Commit tracking metrics into browser local cache to protect state barriers
                    chrome.storage.local.set({
                        yuko_latch_status: "LATCHED",
                        yuko_turn_origin: "AUTOMATED",
                        active_tx_id: data.tx_id,
                        secured_tab_id: tabId
                    }, () => {
                        // Forward injection event straight down into the content_script.js channel
                        chrome.tabs.sendMessage(tabId, {
                            type: "EXECUTE_INJECTION",
                            prompt: data.prompt,
                            tx_id: data.tx_id // 🛡️ Fixes the tracking leak down the bus line
                        });
                    });
                }
                
                // If system states report as IDLE or channel locked elsewhere, delay next check
                const delay = (data.action === "idle" || data.reason) ? 1000 : 200;
                setTimeout(executeDaemonPoll, delay);
            })
            .catch(err => {
                // Silent catch block to keep extension logs unpolluted if dev daemon cycles down
                console.log("🔮 Waiting for local FastAPI router connection...");
                setTimeout(executeDaemonPoll, 2000);
            });
    });
}

// Kickstart the long-polling execution chain lifecycle immediately on extension startup
executeDaemonPoll();
