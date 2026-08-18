/**
 * Context-Aware Browser Scraper & Ingestion Pipeline
 * Features: Turn Isolation, Pre-Injection Snapshotting, Length-Stabilization, 
 * and Multi-Turn Autonomous RPC Loop support.
 */

console.log("🧬 Pipeline active: Scraper & Ingestion Bridge loaded.");

// State Tracking
const masterDataMap = new Set();
const processedTurnsPending = new Set();
let activeAutomationTxId = null;
let stabilizationTimer = null;

// Configuration Defaults
const CONFIG = {
  STABILITY_TICKS_REQUIRED: 5,  // 5 consecutive checks with no text length change
  STABILITY_INTERVAL_MS: 150,   // Polling frequency (5 * 150ms = 750ms quiet window)
  MAX_CHECK_ATTEMPTS: 100,      // Fallback escape hatch (~15 seconds)
};

// Intialize Default Extension Storage
chrome.storage.local.set({ latch_status: "IDLE", turn_origin: "MANUAL" });

/**
 * 1. ASSISTANT TURN ISOLATION
 * Extract only assistant nodes, filtering out user inputs and headers.
 */
function getAssistantTurns() {
  // Claude Assistant Turns
  const claudeTurns = Array.from(
    document.querySelectorAll('div[role="article"], .font-claude-response, [data-is-streaming]')
  ).filter((el) => {
    return !el.querySelector('[data-is-user="true"]') && !el.innerText.startsWith("You\n");
  });

  // ChatGPT Assistant Turns
  const gptTurns = Array.from(
    document.querySelectorAll('[data-message-author-role="assistant"]')
  );

  // Fallback Selector
  const genericTurns = Array.from(document.querySelectorAll('[data-turn="assistant"]'));

  return [...claudeTurns, ...gptTurns, ...genericTurns];
}

/**
 * 2. UNIQUE TURN FINGERPRINTING
 * Generates an immutable key for any message turn in the DOM.
 */
function generateTurnId(turnNode, index) {
  const datasetId = turnNode.getAttribute("data-turn-id") || 
                    turnNode.getAttribute("data-message-id");
  if (datasetId) return datasetId;

  const snippet = (turnNode.innerText || "").slice(0, 40).replace(/\s+/g, "_");
  return `turn_${index}_${snippet}`;
}

/**
 * 3. PRE-INJECTION SNAPSHOTTING
 * Marks all existing assistant messages in the DOM as "seen" 
 * so only new completions trigger ingestion.
 */
function snapshotExistingTurns() {
  const currentTurns = getAssistantTurns();
  currentTurns.forEach((node, index) => {
    const turnId = generateTurnId(node, index);
    masterDataMap.add(turnId);
  });
  console.log(`📸 Snapshotted ${currentTurns.length} pre-existing turn(s).`);
}

/**
 * 4. STREAMING STATE DETECTION
 */
function isModelGenerating() {
  // 1. Standard stop button / streaming class checks
  const activeStopButton = document.querySelector(
    'button[aria-label*="Stop"], .streaming, [aria-busy="true"], [data-is-streaming="true"], button[data-testid*="stop-button"]'
  );
  if (activeStopButton) return true;

  // 2. Claude Search/Tool Execution in-flight check
  // Checks if search pill/status is currently expanding or active
  const activeToolState = document.querySelector(
    '[role="status"][aria-live="polite"], .group\\/status[aria-expanded="true"]'
  );
  if (activeToolState && activeToolState.innerText.includes("Searching")) return true;

  return false;
}

/**
 * 5. LENGTH-STABILIZATION LOOP & PAYLOAD COMPILATION
 * Polls the candidate turn element until text length remains flat.
 */
function stabilizeAndExtract(latestTurnNode, turnId) {
  let lastTextLength = 0;
  let stabilityTicks = 0;
  let checkAttempts = 0;

  if (stabilizationTimer) clearInterval(stabilizationTimer);

  stabilizationTimer = setInterval(() => {
    const currentText = latestTurnNode.innerText || "";
    checkAttempts++;

    if (currentText.length > 0 && currentText.length === lastTextLength) {
      stabilityTicks++;
    } else {
      stabilityTicks = 0;
      lastTextLength = currentText.length;
    }

    // Require 5 consecutive stable ticks (750ms total flatline)
    if (stabilityTicks >= CONFIG.STABILITY_TICKS_REQUIRED || checkAttempts > CONFIG.MAX_CHECK_ATTEMPTS) {
      clearInterval(stabilizationTimer);
      console.log("🎯 DOM layout fully stabilized. Compiling full payload...");
      
      executePayloadCompilation(latestTurnNode, turnId);
      processedTurnsPending.delete(turnId);
    }
  }, CONFIG.STABILITY_INTERVAL_MS);
}

/**
 * 6. DISPATCH INGESTION
 */
function executePayloadCompilation(containerNode, turnId) {
  // Bridge gaps created by tool execution pills (e.g. "Searched the web")
  const contentBlocks = Array.from(
    containerNode.querySelectorAll('.font-claude-response-body, .markdown p, [class*="markdown"] p')
  );

  let rawText = "";

  if (contentBlocks.length > 0) {
    // Collect all paragraph texts in order, ignoring tool headers
    rawText = contentBlocks
      .map((el) => el.innerText.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
  } else {
    // Fallback to container innerText
    rawText = containerNode.innerText.trim();
  }

  // Strip residual UI header artifacts & search status labels
  rawText = rawText
    .replace(/^Claude\n|^ChatGPT\n|^Assistant\n/, "")
    .replace(/^Searched the web\n/g, "")
    .trim();

  chrome.storage.local.get(["turn_origin"], (storageRes) => {
    const currentOrigin = storageRes.turn_origin || "MANUAL";

    const extractedPayload = {
      title: document.title || "Active Web Stream",
      url: window.location.href,
      origin: currentOrigin,
      tx_id: activeAutomationTxId,
      blocks: [{ role: "assistant", content: rawText }]
    };

    masterDataMap.add(turnId);

    console.log(`🚚 Dispatching payload over internal bus [TX: ${activeAutomationTxId}]...`);

    chrome.runtime.sendMessage({ type: "INGEST_PAYLOAD", data: extractedPayload }, (response) => {
      activeAutomationTxId = null;
      chrome.storage.local.set({
        latch_status: "IDLE",
        turn_origin: "MANUAL"
      });
    });
  });
}


/**
 * 7. MUTATION OBSERVER
 */
const observer = new MutationObserver(() => {
  // Guard 1: Abort if model is actively generating tokens
  if (isModelGenerating()) return;

  const assistantTurns = getAssistantTurns();
  if (assistantTurns.length === 0) return;

  // Target exclusively the final/newest assistant message turn
  const latestTurnIndex = assistantTurns.length - 1;
  const latestTurnContainer = assistantTurns[latestTurnIndex];
  const turnId = generateTurnId(latestTurnContainer, latestTurnIndex);

  // Guard 2: Skip if already processed or undergoing stabilization
  if (masterDataMap.has(turnId) || processedTurnsPending.has(turnId)) {
    return;
  }

  // Guard 3: Latch state check
  chrome.storage.local.get(["latch_status", "turn_origin"], (res) => {
    const currentLatch = res.latch_status || "IDLE";
    const currentOrigin = res.turn_origin || "MANUAL";

    const shouldProcess = currentLatch === "IDLE" || currentOrigin === "AUTOMATED";
    if (!shouldProcess) return;

    processedTurnsPending.add(turnId);

    if (currentLatch === "IDLE") {
      chrome.storage.local.set({ latch_status: "LATCHED" });
    }

    console.log(`🚨 New assistant turn detected [Origin: ${currentOrigin}, TX: ${activeAutomationTxId}]. Stabilizing...`);
    stabilizeAndExtract(latestTurnContainer, turnId);
  });
});

// Attach observer to DOM tree
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

/**
 * 8. INJECTION ROUTINES
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "EXECUTE_INJECTION") {
    console.log(`⚡ Injection trigger received for TX: ${request.tx_id}`);

    activeAutomationTxId = request.tx_id;
    chrome.storage.local.set({ turn_origin: "AUTOMATED", latch_status: "LATCHED" });

    // Snapshot existing turns so we don't accidentally re-ingest past messages
    snapshotExistingTurns();

    const injected = injectIntoClaudeOrChatGPT(request.prompt);
    if (injected) {
      sendResponse({ status: "SUCCESS" });
    } else {
      console.error("❌ Prompt input field could not be located in DOM.");
      sendResponse({ status: "FAILED", reason: "Input container not found" });
    }
  }
});

function injectIntoClaudeOrChatGPT(text) {
  // Claude ProseMirror Field
  const claudeInput =
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('div[contenteditable="true"]');

  if (claudeInput) {
    claudeInput.focus();
    while (claudeInput.firstChild) claudeInput.removeChild(claudeInput.firstChild);

    const p = document.createElement("p");
    p.textContent = text;
    claudeInput.appendChild(p);

    claudeInput.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
    );

    setTimeout(() => {
      const sendButton =
        document.querySelector('button[aria-label*="Send"]') ||
        document.querySelector('button[type="submit"]');
      if (sendButton && !sendButton.disabled) {
        sendButton.click();
      } else {
        triggerEnterFallback(claudeInput);
      }
    }, 300);
    return true;
  }

  // ChatGPT Textarea Field
  const chatGptInput = document.querySelector('#prompt-textarea');
  if (chatGptInput) {
    chatGptInput.focus();
    chatGptInput.value = text;
    chatGptInput.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(() => {
      const gptSendBtn = document.querySelector('button[data-testid="send-button"]');
      if (gptSendBtn) gptSendBtn.click();
    }, 300);
    return true;
  }

  return false;
}

function injectTextIntoPromptField(text) {
  const textarea =
    document.querySelector('div[contenteditable="true"]') ||
    document.getElementById("prompt-textarea") ||
    document.querySelector("textarea");

  if (!textarea) return;

  textarea.focus();
  if (textarea.tagName === "TEXTAREA") {
    textarea.value = "";
  } else {
    textarea.innerHTML = "";
  }

  document.execCommand("insertText", false, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));

  setTimeout(() => {
    const submitButton =
      document.querySelector('button[aria-label="Send Message"]') ||
      document.querySelector('[data-testid="send-button"]') ||
      textarea.closest("form")?.querySelector('button[type="submit"]');

    if (submitButton && !submitButton.disabled) {
      submitButton.click();
    } else {
      triggerEnterFallback(textarea);
    }
  }, 300);
}

function triggerEnterFallback(element) {
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
    })
  );
}
