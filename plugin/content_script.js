// content_script.js
console.log("🧬 Yuko ExoCognition content pipeline active.");

// 1. Permanent Log: Blocks historical items from re-triggering the pipeline during scrolls
let masterDataMap = new Set();

// 2. Transient Lock: Blocks concurrent mutation spam while a single turn is solidifying
let processedTurnsPending = new Set(); 

// Initialize global T-Flip-Flop state inside tracking storage area
chrome.storage.local.set({ yuko_latch_status: "IDLE", yuko_turn_origin: "MANUAL" });

const observer = new MutationObserver(() => {
    const isStillGenerating = document.querySelector('button[aria-label="Stop generating"], .streaming, [aria-busy="true"]');
    if (isStillGenerating) return;

    const conversationTurns = document.querySelectorAll('[data-turn="assistant"], [data-testid^="conversation-turn-"]');
    if (conversationTurns.length === 0) return;

    const latestTurnContainer = conversationTurns[conversationTurns.length - 1];            

    const turnId = latestTurnContainer.getAttribute('data-turn-id') || 
                   latestTurnContainer.getAttribute('data-testid') || 
                   latestTurnContainer.innerText.slice(0, 30) + conversationTurns.length;

    // =========================================================================
    // 🛡️ CRITICAL SYNCHRONOUS ENTRY GATE
    // Check both scopes immediately before any async storage lookups are fired.
    // =========================================================================
    if (masterDataMap.has(turnId) || processedTurnsPending.has(turnId)) {
        return; 
    }

    // Immediately claim the lock frame in memory
    processedTurnsPending.add(turnId);

    chrome.storage.local.get(['yuko_latch_status', 'yuko_turn_origin'], (res) => {
        const currentLatch = res.yuko_latch_status || "IDLE";
        const currentOrigin = res.yuko_turn_origin || "MANUAL";

        const shouldProcess = (currentLatch === "IDLE" || currentOrigin === "AUTOMATED");
                               
        if (!shouldProcess) {
            // Drop transient lock if system state rules it out
            processedTurnsPending.delete(turnId);
            return;
        }

        if (currentLatch === "IDLE") {
            chrome.storage.local.set({ yuko_latch_status: "LATCHED" });
        }
                    
        console.log(`🚨 Target turn element isolated [Origin: ${currentOrigin}]. Starting stabilization check...`);
        let lastTextLength = 0;
        let stabilityTicks = 0;
        let checkAttempts = 0;
                    
        const stabilizationInterval = setInterval(() => {
            const currentText = latestTurnContainer.innerText || "";
            checkAttempts++;

            if (currentText.length === lastTextLength) {
                stabilityTicks++;
            } else {
                stabilityTicks = 0;
                lastTextLength = currentText.length;
                console.log(`⏳ Buffer rendering in progress... Current Length: ${lastTextLength}`);
                return;
            }

            // Enforce a tight 4-tick (600ms) silence requirement at 150ms intervals
            if (stabilityTicks >= 4 || checkAttempts > 80) {
                clearInterval(stabilizationInterval);
                console.log("🎯 DOM layout fully stabilized. Extracting unabridged payload...");
                
                // Hand-off control to compilation core
                executePayloadCompilation(latestTurnContainer, turnId);
                
                // Release the transient lock so subsequent mutations are allowed *after* completion
                processedTurnsPending.delete(turnId);
            }
        }, 150); 
    });
});

function executePayloadCompilation(container, turnId) {
    const sender = container.getAttribute('data-turn') || "assistant";
        
    // Deep sub-node extraction specifically within our verified assistant container
    const markdownContainer = container.querySelector('.markdown, [class*="markdown"]');
    let rawText = "";
    if (markdownContainer) {
        rawText = markdownContainer.innerText.trim();
    } else {
        const textNodes = container.querySelectorAll('p, ol, ul, pre, li');
        if (textNodes.length > 0) {
            let nodeTexts = [];
            textNodes.forEach(node => nodeTexts.push(node.innerText.trim()));
            rawText = nodeTexts.join("\n\n");
        } else {
            rawText = container.innerText.trim();
        }
    }

    // Scrub generic host title headers safely
    rawText = rawText.replace(/^You\n|^ChatGPT\n|^Claude\n/, '').trim();

    // Capture entire historical context for fallback storage and verification
    const allTurns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    let conversationHistoryText = "";
    allTurns.forEach((turn, index) => {
        conversationHistoryText += `Turn ${index + 1}:\n${turn.innerText}\n\n`;
    });

    chrome.storage.local.get(['yuko_turn_origin'], (storageRes) => {
        const currentOrigin = storageRes.yuko_turn_origin || "MANUAL";
        
        const extractedPayload = {
            title: document.title || "Active Web Stream",
            url: window.location.href,
            origin: currentOrigin,
            tx_id: activeAutomationTxId, // 🛡️ Pass the exact transaction tracking key back up
            blocks: [{ role: sender, content: rawText }],
            rawTurnsDump: conversationHistoryText
        };
    
        masterDataMap.add(turnId);
        chrome.storage.local.set({ last_captured_packet: extractedPayload });
        console.log(`🚚 Dispatching finalized [${currentOrigin}] package over internal bus...`);
    
        chrome.runtime.sendMessage({ type: "INGEST_PAYLOAD", data: extractedPayload }, (response) => {

            if (!response) {
                console.error("❌ No response received from background pipe. Releasing latch.");
                injectVisualOverlay("Pipeline timeout: Local daemon did not reply.", true);
                chrome.storage.local.set({ yuko_latch_status: "IDLE", yuko_turn_origin: "MANUAL" });
                return;
            }

            const rpcResult = response.reply; 
            if (rpcResult) {
                console.log("📦 [YUKO-DEBUG] Raw RPC Result intercepted:", JSON.stringify(rpcResult));
                
                let payloadData;
                // Defensive normalization for raw strings or legacy structures
                if (typeof rpcResult === "string") {
                    payloadData = { action: "reply", message: rpcResult };
                } else {
                    payloadData = rpcResult.payload ? rpcResult.payload : rpcResult;
                }
                
                const action = payloadData.action || payloadData.status;
                const message = payloadData.message;
                
                // Route manual operator interferences cleanly
                if (action === "reply" && message) {
                    console.log("📥 Valid operator reply received. Injecting into chat interface...");
                    injectTextIntoPromptField(message);
                } else if (action === "drop" || action === "dropped" || action === "success") {
                    console.log("⚠️ Transaction complete or intentionally dropped. No text injection required.");
                    if (action === "drop" || action === "dropped") {
                        injectVisualOverlay("Payload execution explicitly dropped by console operator.", true);
                    }
                } else {
                    console.warn(`❓ Received unhandled action state: "${action}".`, payloadData);
                }
            } else if (response.error) {
                console.error("❌ JSON-RPC Error returned from server:", response.error.message);
                injectVisualOverlay(`System Exception: ${response.error.message}`, true);
            }

            activeAutomationTxId = null; 
            chrome.storage.local.set({ 
                yuko_latch_status: "IDLE",
                yuko_turn_origin: "MANUAL"
            }, () => {
                console.log("🔓 Latch barriers cleared back to [IDLE]. Channel ready for next turn.");
            });
        });
    });                   
}

// ==========================================
//   🛡️ REFACTOR POINT: INBOUND CONTROLLER
// ==========================================

// Track the active transaction globally in the content script memory space
let activeAutomationTxId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "EXECUTE_INJECTION" && message.prompt) {
        console.log(`⚡ [YUKO-CORE] Inbound automated execution received [TxID: ${message.tx_id}]. Triggering insertion pipeline...`);
        
        // Lock the origin state machine to automated tracking before injecting text
        activeAutomationTxId = message.tx_id;
        chrome.storage.local.set({ 
            yuko_latch_status: "LATCHED", 
            yuko_turn_origin: "AUTOMATED" 
        }, () => {
            injectTextIntoPromptField(message.prompt);
        });

        if (sendResponse) sendResponse({ status: "injection_initiated", tx_id: message.tx_id });
    }
});

function injectTextIntoPromptField(text) {
    console.log("📥 [YUKO-TRACE] injectTextIntoPromptField invoked. Length of inbound payload:", text.length);

    // Hunt for any valid variation of the prompt box to protect against layout updates
    const textarea = document.getElementById("prompt-textarea") || 
                     document.querySelector('div[contenteditable="true"]') ||
                     document.querySelector('textarea');
                     
    if (!textarea) {
        console.error("❌ [YUKO-TRACE] CRITICAL: Could not locate the prompt input element in the active DOM tree.");
        injectVisualOverlay("Injection failure: Prompt text field could not be found.", true);
        return;
    }

    console.log("🔍 [YUKO-TRACE] Target text area successfully located. Element Tag:", textarea.tagName, "ID:", textarea.id);
    textarea.focus();
    console.log("🎯 [YUKO-TRACE] Element focus forced successfully.");
    
    // Clear any stub text currently residing in the composer
    if (textarea.tagName === "TEXTAREA") {
        textarea.value = "";
    } else {
        textarea.innerHTML = "";
    }
    console.log("🧹 [YUKO-TRACE] Prior element contents cleared.");

    // Natively inject text to maintain React/Svelte state internal bindings
    console.log("⚡ [YUKO-TRACE] Executing native document insertText command...");
    document.execCommand('insertText', false, text);
    
    console.log("🔄 [YUKO-TRACE] Dispatching artificial input event to force state synchronization...");
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    
    console.log("⏳ [YUKO-TRACE] Payload safely committed to DOM. Arming execution timer (300ms)...");

    // Give the UI engine a 300ms window to register the string change and enable submission layouts
    setTimeout(() => {
        console.log("👀 [YUKO-TRACE] Timer popped. Sweeping DOM for interactive submission elements...");
        
        const submitButton = document.getElementById('composer-submit-button') || 
                             document.querySelector('[data-testid="send-button"]') ||
                             document.querySelector('button[aria-label="Send prompt"]') ||
                             textarea.closest('form')?.querySelector('button[type="submit"]');
        
        if (submitButton) {
            console.log("Found submit element! Disabled attribute status:", submitButton.disabled);
            
            if (!submitButton.disabled) {
                console.log("🚀 [YUKO-TRACE] Button is active! Dispatching native .click() execution event.");
                submitButton.click();
                console.log("✅ [YUKO-TRACE] Click event successfully dispatched to target node.");
            } else {
                console.warn("⚠️ [YUKO-TRACE] Submit element found but it reports as DISABLED. UI state sync may be lagging. Falling back to keypress simulation...");
                triggerEnterFallback(textarea);
            }
        } else {
            console.warn("⚠️ [YUKO-TRACE] Target submit buttons completely missing from current DOM layout. Falling back to keypress simulation...");
            triggerEnterFallback(textarea);
        }
    }, 300);
}

function triggerEnterFallback(element) {
    console.log("⌨️ [YUKO-TRACE] Generating synthetic Enter KeyDown event object...");
    const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter', 
        code: 'Enter', 
        keyCode: 13, 
        which: 13, 
        bubbles: true, 
        cancelable: true
    });
    element.dispatchEvent(enterEvent);
    console.log("🚀 [YUKO-TRACE] Synthetic enter event dispatched directly to target input node.");
}

function injectVisualOverlay(text, isException = false) {
    let overlay = document.getElementById("yuko-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "yuko-overlay";
        document.body.appendChild(overlay);
    }

    overlay.style = "position: fixed; bottom: 20px; right: 20px; padding: 15px; border-radius: 8px; z-index: 99999; max-width: 320px; font-family: monospace; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: all 0.2s ease-in-out;";
    
    if (isException) {
        overlay.style.background = "#2d202a";
        overlay.style.border = "1px solid #f7768e";
        overlay.style.color = "#f7768e";
    } else {
        overlay.style.background = "#1a1a24";
        overlay.style.border = "1px solid #7aa2f7";
        overlay.style.color = "#a9b1d6";
    }

    overlay.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <strong>${isException ? "⚠️ Yuko System State" : "🔮 Yuko Core Response"}</strong>
            <span id="yuko-overlay-close" style="cursor: pointer; padding: 0 4px; font-weight: bold; color: #565f89;">×</span>
        </div>
        <div style="color: ${isException ? '#f7768e' : '#9ece6a'}; max-height: 150px; overflow-y: auto; white-space: pre-wrap; font-size: 11px;">${text}</div>
    `;

    document.getElementById("yuko-overlay-close").addEventListener("click", () => {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 200);
    });
}

// Attach mutation observer loop to document execution lifecycle
observer.observe(document.body, { childList: true, subtree: true });
