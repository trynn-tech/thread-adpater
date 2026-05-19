# server/router.py
import asyncio
import uuid
import time
from fastapi import FastAPI, HTTPException, Request  # Changed APIRouter to FastAPI
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional

app = FastAPI()
router = app  # This alias ensures all your existing @router.post and @router.get routes work without editing!

# --- Memory Space Allocations ---
ACTIVE_TRANSACTIONS: Dict[str, Dict[str, Any]] = {}

# System-wide thread lock to force serial execution of inbound cURL/API requests
SYSTEM_EXECUTION_LOCK = asyncio.Lock()

# State variables for tab targeting channel lock
SECURED_TAB_ID: Optional[int] = None
SECURED_URL_PATTERN: Optional[str] = None

# ==========================================
#      OPENAI WIRE PROTOCOL SCHEMAS
# ==========================================
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str = "yuko-browser-bridge"
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.7
    stream: Optional[bool] = False
    # Custom non-standard extension parameters for explicit routing overrides
    target_tab_id: Optional[int] = None
    target_url_contains: Optional[str] = None

class ChatCompletionResponseChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str = "stop"

class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4()}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[ChatCompletionResponseChoice]
    usage: Dict[str, int] = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
    }

# ==========================================#
#     OPENAI COMPATIBLE INBOUND API         #
# ==========================================#

@router.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def open_ai_compat_completions(payload: ChatCompletionRequest):
    """
    Exposes a unified queue gate. If an external agent chains multiple cURL operations, 
    this lock forces them to stand in line, resolving them sequentially as the 
    browser tab finishes each generation cycle.
    
    UPGRADE: Intercepts manual sync packets immediately without checking the mutex lock.
    """
    if not payload.messages:
        raise HTTPException(status_code=400, detail="Inbound message array cannot be empty.")
    
    latest_user_message = payload.messages[-1].content
    global SECURED_TAB_ID, SECURED_URL_PATTERN

    # 🛡️ POPUP INTERCEPTOR FAST-PATH
    # Catch structural sync envelopes early, apply channel binding metrics, 
    # and exit cleanly before entering the serialization mutex.
    if latest_user_message == "MANUAL_CHANNEL_INITIALIZATION":
        if payload.target_tab_id is not None:
            SECURED_TAB_ID = payload.target_tab_id
        if payload.target_url_contains:
            SECURED_URL_PATTERN = payload.target_url_contains
        
        print(f"🎯 [Manual Mount] Hard channel lock bound explicitly via Popup to Tab ID: {SECURED_TAB_ID}")
        
        # Return a standard structured completion shape to satisfy the client fetch loop
        return ChatCompletionResponse(
            model=payload.model,
            choices=[
                ChatCompletionResponseChoice(
                    index=0,
                    message=ChatMessage(role="assistant", content="CHANNEL_BOUND"),
                    finish_reason="stop"
                )
            ]
        )

    # --- Standard Serialized Execution Loop Resumes Downward ---
    tx_id = str(uuid.uuid4())
    print(f"📥 [/v1/chat/completions] Request queued in system buffer. ID: {tx_id}")
    
    # FORCE MUTEX LOCK: Subsequent automation requests block right here
    async with SYSTEM_EXECUTION_LOCK:
        print(f"🔓 [Lock Acquired] Processing transaction thread: {tx_id}")
        
        # Keep runtime automated overrides functional if passed via cURL script
        if payload.target_tab_id is not None:
            SECURED_TAB_ID = payload.target_tab_id
        if payload.target_url_contains:
            SECURED_URL_PATTERN = payload.target_url_contains
                
        ACTIVE_TRANSACTIONS[tx_id] = {
            "event": asyncio.Event(),
            "prompt": latest_user_message,
            "response_data": None,
            "status": "PENDING",
            "raw_payload": {"blocks": [{"role": "user", "content": latest_user_message}]}
        }
        
        # Block indefinitely until browser execution finishes and calls back
        await ACTIVE_TRANSACTIONS[tx_id]["event"].wait()
        
        resolved_node = ACTIVE_TRANSACTIONS.pop(tx_id)
        final_output_text = resolved_node.get("response_data", "")
        
        print(f"🔒 [Lock Released] Finished transaction thread: {tx_id}")
        
    return ChatCompletionResponse(
        model=payload.model,
        choices=[
            ChatCompletionResponseChoice(
                message=ChatMessage(role="assistant", content=final_output_text)
            )
        ]
    )
# ==========================================
#      EXTENSION BUS PIPELINE CONTROL
# ==========================================
@router.post("/mcp/v1")
async def ingest_browser_thread(request: Request):
    """
    Invoked by background.js when text generation is fully finalized.
    """
    body = await request.json()
    params = body.get("params", body)
    blocks = params.get("blocks", [])
    captured_text = blocks[0].get("content", "") if blocks else ""
    
    # Track metadata passed up by the background agent loop
    browser_tab_id = params.get("tabId")
    browser_url = params.get("url", "")
    
    # ENFORCE CHANNEL GUARD: Drop the payload instantly if it originates from an untargeted window
    if SECURED_TAB_ID is not None and browser_tab_id != SECURED_TAB_ID:
        return {"jsonrpc": "2.0", "result": {"status": "ignored", "reason": "Tab ID mismatch"}, "id": body.get("id", 1)}
        
    if SECURED_URL_PATTERN and SECURED_URL_PATTERN not in browser_url:
        return {"jsonrpc": "2.0", "result": {"status": "ignored", "reason": "URL context mismatch"}, "id": body.get("id", 1)}
        
    # Automatic execution path routing matching an in-flight automation task
    for tx_id, transaction in ACTIVE_TRANSACTIONS.items():
        if transaction["status"] == "IN_FLIGHT":
            transaction["response_data"] = captured_text
            transaction["status"] = "COMPLETED"
            transaction["event"].set()
            return {"jsonrpc": "2.0", "result": {"status": "success", "action": "drop"}, "id": body.get("id", 1)}
            
    # Fallback to manual operator console path
    tx_id = str(uuid.uuid4())
    ACTIVE_TRANSACTIONS[tx_id] = {
        "event": asyncio.Event(),
        "prompt": captured_text,
        "response_data": None,
        "status": "INTERCEPTED",
        "raw_payload": params # Store complete parameters block containing title/url/blocks
    }
    
    await ACTIVE_TRANSACTIONS[tx_id]["event"].wait()
    response_payload = ACTIVE_TRANSACTIONS[tx_id]["response_data"]
    del ACTIVE_TRANSACTIONS[tx_id]
    
    return {"jsonrpc": "2.0", "result": response_payload, "id": body.get("id", 1)}

# ==========================================
#       INTERNAL DAEMON POLLING/MANAGEMENT
# ==========================================
@router.get("/internal/next-payload")
async def get_next_payload(tabId: Optional[int] = None, url: Optional[str] = None):
    """
    Polled continuously by console.py and background.js.
    """
    global SECURED_TAB_ID
    
    if SECURED_TAB_ID is None and tabId is not None:
        SECURED_TAB_ID = tabId
        print(f"🛡️ [Channel Secured] Base target tracking locked to Tab ID: {SECURED_TAB_ID}")
        
    if SECURED_TAB_ID is not None and tabId is not None and tabId != SECURED_TAB_ID:
        return {"action": "idle", "reason": "Channel locked to alternative target context."}
        
    for tx_id, data in ACTIVE_TRANSACTIONS.items():
        if data["status"] == "PENDING":
            data["status"] = "IN_FLIGHT"
            return {
                "action": "inject_and_execute",
                "tx_id": tx_id,
                "prompt": data["prompt"],
                "raw_payload": data["raw_payload"]
            }
            
    for tx_id, data in ACTIVE_TRANSACTIONS.items():
        if data["status"] == "INTERCEPTED":
            return {
                "action": "operator_input_required",
                "tx_id": tx_id,
                "prompt": data["prompt"],
                "raw_payload": data["raw_payload"]
            }
            
    return {"action": "idle"}

@router.post("/internal/resolve-payload")
async def resolve_payload(data: dict):
    """
    Explicit synchronization point allowing client/console.py to free blocked
    asynchronous request threads passing through the server cluster.
    """
    tx_id = data.get("tx_id")
    payload = data.get("payload", {})
    
    if tx_id not in ACTIVE_TRANSACTIONS:
        raise HTTPException(status_code=404, detail="Transaction reference key missing or already closed.")
        
    target_node = ACTIVE_TRANSACTIONS[tx_id]
    
    if payload.get("action") == "reply":
        target_node["response_data"] = {"status": "reply", "message": payload.get("message", "")}
    elif payload.get("action") == "saved_to_disk":
        target_node["response_data"] = {"status": "committed", "message": "Changes written to storage engine."}
    else:
        target_node["response_data"] = {"status": "dropped", "message": "Transaction discarded by operator."}
        
    target_node["event"].set()
    return {"status": "acknowledged"}

@router.post("/internal/reset-channel")
async def reset_channel():
    """
    Administrative clear hook to drop channel locking so another tab can claim it.
    """
    global SECURED_TAB_ID, SECURED_URL_PATTERN
    print("♻️ Releasing secured workspace channels.")
    SECURED_TAB_ID = None
    SECURED_URL_PATTERN = None
    return {"status": "cleared"}
