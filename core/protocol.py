# core/protocol.py
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field

class ChatBlock(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    timestamp: Optional[str] = None

class IngestParams(BaseModel):
    title: str
    url: str
    blocks: List[ChatBlock]
    blocks_captured: int
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)

class JSONRPCRequest(BaseModel):
    jsonrpc: str = Field(default="2.0", frozen=True)
    method: str
    params: Union[IngestParams, Dict[str, Any]]
    id: Optional[Union[str, int]] = None

class JSONRPCResponse(BaseModel):
    jsonrpc: str = Field(default="2.0", frozen=True)
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    id: Optional[Union[str, int]] = None
