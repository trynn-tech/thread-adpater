# tests/test_extension_flow.py
import pytest
import httpx
import asyncio

SERVER_URL = "http://127.0.0.1:8000"

@pytest.mark.asyncio
async def test_automated_agent_completion_flow():
    """
    Tests Phase 1: An external agent cuts a prompt request via the OpenAI wire 
    protocol layer, and the background extension intercept pulls and resolves it.
    """
    async with httpx.AsyncClient() as client:
        # 1. Reset the administrative channel block before executing test frames
        await client.post(f"{SERVER_URL}/internal/reset-channel")

        # 2. Spin up the inbound agent completion block concurrently (mimicking an active cURL)
        agent_payload = {
            "model": "yuko-browser-bridge",
            "messages": [{"role": "user", "content": "Generate an Astro/Tailwind build matrix profile"}],
            "target_tab_id": 42
        }
        
        # Dispatch the request into the async loop task queue
        agent_task = asyncio.create_task(
            client.post(f"{SERVER_URL}/v1/chat/completions", json=agent_payload, timeout=5.0)
        )
        
        # Yield execution control briefly to let the server mount the transaction state
        await asyncio.sleep(0.2)

        # 3. Simulate background.js continuous polling check
        poll_resp = await client.get(f"{SERVER_URL}/internal/next-payload?tabId=42")
        assert poll_resp.status_code == 200
        packet = poll_resp.json()
        
        assert packet["action"] == "inject_and_execute"
        tx_id = packet["tx_id"]
        assert packet["prompt"] == "Generate an Astro/Tailwind build matrix profile"

        # 4. Simulate the WebExtension returning the generated text block back via the MCP node
        mcp_payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "params": {
                "tabId": 42,
                "url": "https://github.com/trynn/hitsuzen",
                "blocks": [{"role": "assistant", "content": "Successfully generated spec payload."}]
            }
        }
        mcp_resp = await client.post(f"{SERVER_URL}/mcp/v1", json=mcp_payload)
        assert mcp_resp.status_code == 200
        assert mcp_resp.json()["result"]["status"] == "success"

        # 5. Await the final completion resolution of the original agent thread
        agent_response = await agent_task
        assert agent_response.status_code == 200
        response_json = agent_response.json()
        
        assert response_json["choices"][0]["message"]["content"] == "Successfully generated spec payload."


@pytest.mark.asyncio
async def test_manual_operator_intercept_flow():
    """
    Tests Phase 2: The browser encounters a raw context unrequested by an agent, 
    pushing it down to the terminal console loop for manual choice verification.
    """
    async with httpx.AsyncClient() as client:
        await client.post(f"{SERVER_URL}/internal/reset-channel")

        # 1. Simulate an unrequested browser hook hit pushing up from an open Firefox tab
        mcp_payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "params": {
                "tabId": 99,
                "url": "https://localhost:3000",
                "title": "Local Development Trace Workspace",
                "blocks": [{"role": "user", "content": "Critical stack trace captured in window console layer."}]
            }
        }
        
        # Dispatch the request concurrently because it blocks until the operator responds
        browser_task = asyncio.create_task(
            client.post(f"{SERVER_URL}/mcp/v1", json=mcp_payload, timeout=5.0)
        )
        await asyncio.sleep(0.2)

        # 2. Simulate console.py daemon loop picking up the manual interception packet
        console_poll = await client.get(f"{SERVER_URL}/internal/next-payload")
        assert console_poll.status_code == 200
        packet = console_poll.json()
        
        assert packet["action"] == "operator_input_required"
        tx_id = packet["tx_id"]
        assert packet["raw_payload"]["title"] == "Local Development Trace Workspace"

        # 3. Simulate the operator hitting option '(r)' and typing a reply string response
        resolve_payload = {
            "tx_id": tx_id,
            "payload": {
                "status": "intercepted",
                "action": "reply",
                "message": "Trace acknowledged. Proceeding to system refactor loop execution profile."
            }
        }
        resolve_resp = await client.post(f"{SERVER_URL}/internal/resolve-payload", json=resolve_payload)
        assert resolve_resp.status_code == 200

        # 4. Verify the blocked browser thread receives the interactive payload response packet back cleanly
        browser_response = await browser_task
        assert browser_response.status_code == 200
        browser_json = browser_response.json()
        
        assert browser_json["result"]["status"] == "reply"
        assert "Proceeding to system refactor" in browser_json["result"]["message"]
