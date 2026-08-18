# server/router.py
import asyncio
import time
import uuid
from typing import Any, Dict, Optional
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from core.protocol import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionResponseChoice,
    ChatMessage,
    InternalChannelState,
    JSONRPCRequest,
    JSONRPCResponse,
)

app = FastAPI(title="Yuko Exocognition Bridge Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared memory & synchronization primitives
ACTIVE_TRANSACTIONS: Dict[str, Dict[str, Any]] = {}
SECURED_TAB_ID: Optional[int] = None
SECURED_URL_PATTERN: Optional[str] = None


@app.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def open_ai_compat_completions(payload: ChatCompletionRequest):
    global SECURED_TAB_ID, SECURED_URL_PATTERN

    if not payload.messages:
        raise HTTPException(
            status_code=400, detail="Inbound message array cannot be empty."
        )

    latest_user_message = payload.messages[-1].content

    # Intercept popup manual sync
    if latest_user_message == "MANUAL_CHANNEL_INITIALIZATION":
        if payload.target_tab_id is not None:
            SECURED_TAB_ID = payload.target_tab_id
        if payload.target_url_contains:
            SECURED_URL_PATTERN = payload.target_url_contains
        return ChatCompletionResponse(
            model=payload.model,
            choices=[
                ChatCompletionResponseChoice(
                    message=ChatMessage(
                        role="assistant", content="CHANNEL_BOUND"
                    )
                )
            ],
        )

    # Context setup
    if payload.target_tab_id is not None:
        SECURED_TAB_ID = payload.target_tab_id
    if payload.target_url_contains:
        SECURED_URL_PATTERN = payload.target_url_contains

    tx_id = f"tx-{uuid.uuid4().hex[:8]}"
    event = asyncio.Event()

    # Create transaction in PENDING state without holding global locks across await
    ACTIVE_TRANSACTIONS[tx_id] = {
        "event": event,
        "prompt": latest_user_message,
        "response_data": None,
        "status": "PENDING",
        "raw_payload": {
            "blocks": [{"role": "user", "content": latest_user_message}]
        },
    }

    try:
        # Wait up to 60s for the extension to inject, run, and ingest the answer
        await asyncio.wait_for(event.wait(), timeout=60.0)
    except asyncio.TimeoutError:
        ACTIVE_TRANSACTIONS.pop(tx_id, None)
        raise HTTPException(
            status_code=504,
            detail="Browser extension response timed out.",
        )

    resolved_node = ACTIVE_TRANSACTIONS.pop(tx_id, {})
    final_output_text = resolved_node.get("response_data", "")

    if isinstance(final_output_text, dict):
        final_output_text = final_output_text.get(
            "message", str(final_output_text)
        )

    return ChatCompletionResponse(
        model=payload.model,
        choices=[
            ChatCompletionResponseChoice(
                message=ChatMessage(
                    role="assistant", content=str(final_output_text)
                )
            )
        ],
    )


@app.post("/mcp/v1")
async def handle_mcp_ingest(request: JSONRPCRequest):
    global SECURED_TAB_ID, SECURED_URL_PATTERN

    req_id = getattr(request, "id", 1)
    params = request.params

    incoming_tab_id = getattr(params, "tabId", getattr(params, "tab_id", None))
    incoming_url = getattr(params, "url", "")
    target_tx_id = getattr(params, "tx_id", getattr(params, "txId", None))
    blocks = getattr(params, "blocks", [])

    # Extract text content cleanly
    captured_text = ""
    if blocks and isinstance(blocks, list):
        last_block = blocks[-1]
        if isinstance(last_block, dict):
            captured_text = last_block.get("content", "")
        else:
            captured_text = getattr(last_block, "content", str(last_block))

    captured_text = captured_text.strip()

    # Reject empty payload frames
    if not captured_text:
        return JSONRPCResponse(
            id=req_id,
            result={"status": "ignored", "reason": "Empty payload content"},
        )

    # Context Guard: Tab ID validation
    if SECURED_TAB_ID is None and incoming_tab_id is not None:
        SECURED_TAB_ID = incoming_tab_id

    # 🎯 Match Mode A: Direct TX ID match
    if target_tx_id and target_tx_id in ACTIVE_TRANSACTIONS:
        tx = ACTIVE_TRANSACTIONS[target_tx_id]
        if tx["status"] in ("IN_FLIGHT", "PENDING"):
            tx["response_data"] = captured_text
            tx["status"] = "COMPLETED"
            tx["event"].set()  # Unblock curl!
            print(f"✅ Successfully matched and closed transaction {target_tx_id}")
            return JSONRPCResponse(
                id=req_id, result={"status": "success", "action": "acknowledged"}
            )

    # 🎯 Match Mode B: Fallback to any active transaction in flight
    for tx_id, tx in list(ACTIVE_TRANSACTIONS.items()):
        if tx["status"] in ("IN_FLIGHT", "PENDING"):
            tx["response_data"] = captured_text
            tx["status"] = "COMPLETED"
            tx["event"].set()  # Unblock curl!
            print(f"✅ Fallback matched and closed transaction {tx_id}")
            return JSONRPCResponse(
                id=req_id, result={"status": "success", "action": "acknowledged"}
            )

    # If all transactions are already COMPLETED, log active transaction states for debugging
    print(f"⚠️ Ingest rejected. Current active tx store: {list(ACTIVE_TRANSACTIONS.keys())}")
    return JSONRPCResponse(
        id=req_id,
        result={"status": "ignored", "reason": "No active transaction in flight"},
    )


@app.get("/internal/next-payload")
async def get_next_payload(
    tabId: Optional[int] = None, url: Optional[str] = None
):
    global SECURED_TAB_ID

    if SECURED_TAB_ID is None and tabId is not None:
        SECURED_TAB_ID = tabId

    if SECURED_TAB_ID is not None and tabId is not None and tabId != SECURED_TAB_ID:
        return InternalChannelState(
            action="idle",
            reason="Channel locked to alternative target context.",
        )

    # Return next pending completion task
    for tx_id, data in list(ACTIVE_TRANSACTIONS.items()):
        if data["status"] == "PENDING":
            data["status"] = "IN_FLIGHT"
            return InternalChannelState(
                action="inject_and_execute",
                tx_id=tx_id,
                prompt=data["prompt"],
                raw_payload=data["raw_payload"],
            )

    for tx_id, data in list(ACTIVE_TRANSACTIONS.items()):
        if data["status"] == "INTERCEPTED":
            return InternalChannelState(
                action="operator_input_required",
                tx_id=tx_id,
                prompt=data["prompt"],
                raw_payload=data["raw_payload"],
            )

    return InternalChannelState(action="idle")


@app.post("/internal/resolve-payload")
async def resolve_payload(data: dict):
    tx_id = data.get("tx_id")
    payload = data.get("payload", {})

    if tx_id not in ACTIVE_TRANSACTIONS:
        raise HTTPException(
            status_code=404,
            detail="Transaction reference key missing or already closed.",
        )

    target_node = ACTIVE_TRANSACTIONS[tx_id]
    action = payload.get("action")

    if action == "reply":
        target_node["response_data"] = {
            "status": "reply",
            "message": payload.get("message", ""),
        }
    elif action == "saved_to_disk":
        target_node["response_data"] = {
            "status": "committed",
            "message": "Changes written to storage engine.",
        }
    else:
        target_node["response_data"] = {
            "status": "dropped",
            "message": "Transaction discarded by operator.",
        }

    target_node["event"].set()
    return {"status": "acknowledged"}


@app.post("/internal/reset-channel")
async def reset_channel():
    global SECURED_TAB_ID, SECURED_URL_PATTERN

    for tx_id, transaction in list(ACTIVE_TRANSACTIONS.items()):
        transaction["response_data"] = {
            "status": "dropped",
            "message": "Channel reset triggered.",
        }
        transaction["event"].set()

    ACTIVE_TRANSACTIONS.clear()
    SECURED_TAB_ID = None
    SECURED_URL_PATTERN = None
    return {"status": "cleared"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9091)
