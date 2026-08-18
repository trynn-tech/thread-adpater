#!/usr/bin/env python3
# client/console.py
import os
import select
import sys
import time
import requests

SERVER_BASE_URL = "http://127.0.0.1:9091"

CLEAR_SCREEN = "\033[H\033[2J"
CURSOR_HOME = "\033[H"
BOLD_MAGENTA = "\033[1;35m"
BOLD_CYAN = "\033[1;36m"
COLOR_RESET = "\033[0m"


def draw_dashboard(status: str, tx_id: str):
    sys.stdout.write(CURSOR_HOME)
    sys.stdout.write(
        f"{BOLD_MAGENTA}🔮 YUKO EXOCOGNITION TELEMETRY CONSOLE{COLOR_RESET}\n"
    )
    sys.stdout.write("=" * 75 + "\n")
    sys.stdout.write(
        f"Channel Status: {BOLD_CYAN}{status:<25}{COLOR_RESET} Active TX: {tx_id}\n"
    )
    sys.stdout.write(
        "Commands: [r] Force Reset Channel | [q] Quit Console\n"
    )
    sys.stdout.write("-" * 75 + "\n")
    sys.stdout.flush()


def fetch_next_payload():
    try:
        res = requests.get(
            f"{SERVER_BASE_URL}/internal/next-payload", timeout=2.0
        )
        if res.status_code == 200:
            return res.json()
    except requests.RequestException:
        return {"action": "server_unreachable", "tx_id": "None"}
    return {"action": "idle", "tx_id": "None"}


def resolve_transaction(tx_id: str, payload: dict):
    try:
        requests.post(
            f"{SERVER_BASE_URL}/internal/resolve-payload",
            json={"tx_id": tx_id, "payload": payload},
            timeout=2.0,
        )
    except requests.RequestException as e:
        print(f"\n❌ Error resolving transaction {tx_id}: {e}")


def reset_server_channel():
    try:
        requests.post(f"{SERVER_BASE_URL}/internal/reset-channel", timeout=2.0)
    except requests.RequestException as e:
        print(f"\n❌ Error resetting server channel: {e}")


def main():
    sys.stdout.write(CLEAR_SCREEN)
    sys.stdout.flush()

    last_state = ""

    while True:
        try:
            data = fetch_next_payload()
            action = data.get("action", "idle")
            tx_id = data.get("tx_id") or "None"
            prompt = data.get("prompt", "")

            draw_dashboard(action.upper(), tx_id)

            if action == "operator_input_required":
                if last_state != "operator_input_required":
                    last_state = "operator_input_required"
                    print(
                        f"\n🚨 {BOLD_MAGENTA}[INTERCEPT]{COLOR_RESET} Manual Input Required!"
                    )
                    print("-" * 60)
                    print(f"Prompt Context:\n{prompt}")
                    print("-" * 60)
                    sys.stdout.write(
                        "Enter response (or leave blank to drop): "
                    )
                    sys.stdout.flush()

                if select.select([sys.stdin], [], [], 0.2)[0]:
                    reply = sys.stdin.readline().strip()
                    payload = (
                        {"action": "reply", "message": reply}
                        if reply
                        else {"action": "drop"}
                    )
                    resolve_transaction(tx_id, payload)
                    sys.stdout.write(CLEAR_SCREEN)
                    last_state = "idle"

            else:
                if last_state == "operator_input_required":
                    sys.stdout.write(CLEAR_SCREEN)
                    last_state = "idle"

                if select.select([sys.stdin], [], [], 0.1)[0]:
                    cmd = sys.stdin.readline().strip().lower()
                    if cmd == "r":
                        reset_server_channel()
                        sys.stdout.write(CLEAR_SCREEN)
                    elif cmd == "q":
                        print("\n👋 Exiting telemetry console.")
                        break

            time.sleep(0.1)

        except KeyboardInterrupt:
            print("\n👋 Signal received. Terminating console.")
            break


if __name__ == "__main__":
    main()
