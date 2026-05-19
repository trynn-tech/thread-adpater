# client/console.py
#!/usr/bin/env python3
import requests
import time
import sys
import os

SERVER_URL = "http://127.0.0.1:9091"

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def administrative_reset():
    """Administrative override to force drop state deadlocks on the backend server."""
    try:
        res = requests.post(f"{SERVER_URL}/internal/reset-channel")
        if res.status_code == 200:
            print("\n♻️  [SYSTEM] Channels successfully reset. Target locks set back to IDLE.")
        else:
            print(f"\n❌ [ERROR] Server refused administrative wipe: {res.status_code}")
    except Exception as e:
        print(f"\n❌ [ERROR] Could not communicate with server daemon: {e}")
    time.sleep(1.5)

def inspect_active_buffer():
    """Reads the current full reply text or operational payload variables if present on server."""
    try:
        # Poking next-payload allows structural tracking without mutating state status strings
        res = requests.get(f"{SERVER_URL}/internal/next-payload")
        if res.status_code == 200:
            data = res.json()
            clear_screen()
            print("👁️  [YUKO COGNITIVE BUFFER INSPECTION]")
            print("=" * 60)
            print(f"Action State: {data.get('action')}")
            print(f"Associated TxID: {data.get('tx_id', 'None')}")
            print("-" * 60)
            print("Prompt Payload:")
            print(data.get('prompt', '[Empty or Idle Buffer]'))
            print("=" * 60)
        else:
            print("❌ Failed reaching internal tracking arrays.")
    except Exception as e:
        print(f"❌ Read failure: {e}")
    input("\nPress Enter to return to telemetry stream...")

def telemetry_stream_loop():
    """Primary tracking screen showing real-time operator state changes."""
    clear_screen()
    print("🔮 Yuko ExoCognition Terminal Operator Interface Enabled.")
    print("Commands: [r] Force Reset Channel | [i] Inspect Buffer | [q] Terminate Console")
    print("-" * 75)
    
    import select
    
    while True:
        try:
            # Non-blocking terminal input evaluation path for system management
            if sys.stdin in select.select([sys.stdin], [], [], 0.1)[0]:
                cmd = sys.stdin.readline().strip().lower()
                if cmd == 'r':
                    administrative_reset()
                    clear_screen()
                    print("🔮 Telemetry loop active. Context cleared.")
                    print("-" * 75)
                elif cmd == 'i':
                    inspect_active_buffer()
                    clear_screen()
                    print("🔮 Telemetry loop active. Monitoring data bus...")
                    print("-" * 75)
                elif cmd == 'q':
                    print("\n👋 Operator session detached.")
                    break
            
            # Poll state vector safely
            res = requests.get(f"{SERVER_URL}/internal/next-payload")
            if res.status_code == 200:
                status = res.json()
                action = status.get("action")
                
                if action == "operator_input_required":
                    tx_id = status.get("tx_id")
                    prompt = status.get("prompt")
                    
                    clear_screen()
                    print("🚨 [INTERCEPT] Manual Operator Authorization Demanded!")
                    print("=" * 60)
                    print(f"Inbound Text Thread Target:\n\n{prompt}")
                    print("=" * 60)
                    
                    reply = input("\nEnter response string (or leave blank to drop transaction): ").strip()
                    
                    if reply:
                        payload = {"action": "reply", "message": reply}
                    else:
                        payload = {"action": "drop", "message": "Rejected by terminal operator."}
                        
                    requests.post(f"{SERVER_URL}/internal/resolve-payload", json={
                        "tx_id": tx_id,
                        "payload": payload
                    })
                    
                    clear_screen()
                    print("🔮 Telemetry loop resumed. Monitoring bus updates...")
                    print("-" * 75)
                    
            time.sleep(1.0)
            
        except KeyboardInterrupt:
            print("\n👋 Operator interface terminated via signal.")
            break
        except Exception as e:
            # Silently throttle intermittent infrastructure drops during refreshes
            time.sleep(2.0)

if __name__ == "__main__":
    telemetry_stream_loop()
