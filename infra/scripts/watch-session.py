#!/usr/bin/env python3
"""Watch a patient's live session, the way the dashboard will.

    python3 infra/scripts/watch-session.py [patientId]

Opens the WebSocket, prints each bite as it lands, and leaves the socket open
until Ctrl-C. Run it, then pour a bite (or `infra/scripts/publish-test-bite.sh`
from another terminal) and it should appear in about a second.

Needs `websocket-client` (pip install websocket-client) and the `natrack`
profile. The URL comes from the stack, so there is nothing to paste.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

try:
    import websocket  # type: ignore
except ImportError:
    sys.exit("pip install websocket-client")

PATIENT = sys.argv[1] if len(sys.argv) > 1 else "demo-1"
STACK = os.environ.get("STACK", "natrack")
PROFILE = os.environ.get("AWS_PROFILE", "natrack")
REGION = os.environ.get("AWS_REGION", "us-east-1")


def stack_output(key: str) -> str:
    out = subprocess.run(
        ["aws", "cloudformation", "describe-stacks", "--stack-name", STACK,
         "--query", f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue",
         "--output", "text", "--profile", PROFILE, "--region", REGION],
        capture_output=True, text=True, check=True)
    return out.stdout.strip()


def on_message(_ws, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        print(f"  {raw}")
        return
    if msg.get("type") != "bite":
        print(f"  {msg}")
        return

    b = msg["data"]
    now = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{now}] bite #{b.get('bite_id')}  {b.get('weightGrams')} g  "
          f"{b.get('salinityIndex')} mS/cm at {b.get('tempC')} C  "
          f"-> {b.get('sodiumEstimate')} mg sodium "
          f"({b.get('sodium_mg_low')}-{b.get('sodium_mg_high')})")
    if b.get("flags"):
        print(f"           flags {b['flags']}  quality {b.get('quality')}"
              f"  tipped {b.get('pour_tilt_deg')} deg")


url = f"{stack_output('SessionUrl')}?patientId={PATIENT}"
print(f"watching {PATIENT} on {url}\nCtrl-C to stop\n")

websocket.WebSocketApp(
    url,
    on_open=lambda _ws: print("connected, waiting for bites..."),
    on_message=on_message,
    on_error=lambda _ws, e: print(f"error: {e}"),
    on_close=lambda _ws, code, msg: print(f"closed ({code} {msg})"),
).run_forever(ping_interval=240)
