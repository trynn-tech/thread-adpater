# core/protocol.py
import time
import uuid
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field


# --- ChatML / Wire Protocol ---
class ChatMessage(BaseModel):
    role: str
    content: str
    timestamp: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: str = "yuko-browser-bridge"
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.7
    stream: Optional[bool] = False
    target_tab_id: Optional[int] = None
    target_url_contains: Optional[str] = None


class ChatCompletionResponseChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex[:12]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[ChatCompletionResponseChoice]
    usage: Dict[str, int] = Field(
        default_factory=lambda: {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }
    )


# --- Extension Bus JSON-RPC Models ---
class IngestParams(BaseModel):
    tabId: Optional[int] = None
    url: Optional[str] = ""
    title: Optional[str] = ""
    blocks: List[ChatMessage] = Field(default_factory=list)
    blocks_captured: Optional[int] = 0
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)


class JSONRPCRequest(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    method: Optional[str] = "ingest"
    params: Union[IngestParams, Dict[str, Any]]
    id: Optional[Union[str, int]] = 1


class JSONRPCResponse(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    id: Optional[Union[str, int]] = 1


# --- Internal Engine Telemetry Schemas ---
class InternalChannelState(BaseModel):
    action: str  # "idle" | "inject_and_execute" | "operator_input_required"
    tx_id: Optional[str] = None
    prompt: Optional[str] = None
    raw_payload: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None
