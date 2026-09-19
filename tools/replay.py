#!/usr/bin/env python3
"""Replays a recorded session through the live pipeline.

Demo insurance. A recording plays back through the identical ingest path, so if
the hardware dies ten minutes before judging the demo still runs and nobody can
tell. It is also how you tune thresholds without standing over a bowl.

    # record while the real spoon (or the mock) runs
    curl -X POST localhost:8000/api/recording/start -d '{"label":"broth"}' \
         -H 'Content-Type: application/json'
    # ... take some bites ...
    curl -X POST localhost:8000/api/recording/stop

    python tools/replay.py backend/recordings/2026...-broth.jsonl

    --speed 2.0     play back at double speed
    --loop          repeat forever, for an unattended demo screen
    --keep-times    do NOT shift timestamps (see below)

Timestamps are shifted to now by default. Without that, replayed bites land in
the past: "today's intake" misses them, meal segmentation sees one enormous gap,
and the (deviceId, timestamp, bite_id) uniqueness guard silently drops the second
replay as a duplicate. Shifting fixes all three.
"""

import argparse
import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import websockets


def load(path: Path) -> list[dict]:
    events = []
    with path.open() as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"  skipping malformed line {n}")
    return events


def shift_timestamps(events: list[dict], device_suffix: str | None) -> list[dict]:
    """Move the whole session so it ends now, preserving internal spacing."""
    if not events:
        return events

    stamps = [datetime.fromisoformat(e["recorded_at"]) for e in events]
    offset = datetime.now(timezone.utc) - stamps[-1]

    out = []
    for e, original in zip(events, stamps):
        ev = dict(e["event"])
        if "timestamp" in ev:
            ts = datetime.fromisoformat(ev["timestamp"].replace("Z", "+00:00")) + offset
            ev["timestamp"] = ts.isoformat(timespec="milliseconds")
        if device_suffix and "deviceId" in ev:
            ev["deviceId"] = f"{ev['deviceId']}{device_suffix}"
        out.append({"recorded_at": (original + offset).isoformat(), "event": ev})
    return out


async def play(args: argparse.Namespace) -> None:
    path = Path(args.recording)
    if not path.exists():
        raise SystemExit(f"no such recording: {path}")

    raw = load(path)
    if not raw:
        raise SystemExit("recording is empty")

    bites = sum(1 for e in raw if e["event"].get("schema") == "bite/v1")
    span = (datetime.fromisoformat(raw[-1]["recorded_at"])
            - datetime.fromisoformat(raw[0]["recorded_at"])).total_seconds()
    print(f"{path.name}: {len(raw)} events, {bites} bites, {span:.0f}s "
          f"(replaying at {args.speed}x)")

    url = f"ws://{args.host}:{args.port}/ws/ingest"

    while True:
        events = raw if args.keep_times else shift_timestamps(raw, args.device_suffix)

        async with websockets.connect(url) as ws:
            prev = None
            sent = 0
            for e in events:
                now = datetime.fromisoformat(e["recorded_at"])
                if prev is not None:
                    gap = (now - prev).total_seconds() / args.speed
                    if gap > 0:
                        await asyncio.sleep(min(gap, args.max_gap))
                prev = now

                await ws.send(json.dumps(e["event"]))
                sent += 1
                if e["event"].get("schema") == "bite/v1":
                    b = e["event"]
                    print(f"  bite #{b['bite_id']}: {b['salinity_g_l']:.2f} g/L, "
                          f"{b['sodiumEstimate']:.1f} mg Na")

            print(f"  replayed {sent} events")

        if not args.loop:
            return
        print("  looping...")
        await asyncio.sleep(args.loop_pause)


def main() -> None:
    p = argparse.ArgumentParser(description="Replay a recorded spoon session")
    p.add_argument("recording", help="path to a .jsonl recording")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--speed", type=float, default=1.0, help="playback rate multiplier")
    p.add_argument("--loop", action="store_true", help="repeat forever")
    p.add_argument("--loop-pause", type=float, default=3.0)
    p.add_argument("--max-gap", type=float, default=5.0,
                   help="cap any single pause, so idle stretches do not stall a demo")
    p.add_argument("--keep-times", action="store_true",
                   help="do not shift timestamps to now (see module docstring)")
    p.add_argument("--device-suffix", default="-replay",
                   help="appended to deviceId so replays are distinguishable")
    args = p.parse_args()

    try:
        asyncio.run(play(args))
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
