"""Records every ingested event to JSONL so a session can be replayed.

This is demo insurance. A recorded session replays through the identical
pipeline, so if the hardware dies ten minutes before judging, the demo still
runs and nobody can tell the difference. It is also how you tune thresholds
without standing over a bowl.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

RECORDINGS_DIR = Path(__file__).resolve().parent.parent / "recordings"


class Recorder:
    def __init__(self) -> None:
        self._path: Optional[Path] = None
        self._count = 0

    @property
    def active(self) -> bool:
        return self._path is not None

    @property
    def path(self) -> Optional[str]:
        return str(self._path) if self._path else None

    @property
    def count(self) -> int:
        return self._count

    def start(self, label: str = "session") -> str:
        RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in label)
        self._path = RECORDINGS_DIR / f"{stamp}-{safe}.jsonl"
        self._count = 0
        self._path.touch()
        return str(self._path)

    def stop(self) -> Optional[str]:
        done, self._path = self._path, None
        self._count = 0
        return str(done) if done else None

    def write(self, payload: dict[str, Any]) -> None:
        if not self._path:
            return
        # Wall clock at ingest, so replay can reproduce the original pacing.
        line = {"recorded_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "event": payload}
        with self._path.open("a") as f:
            f.write(json.dumps(line) + "\n")
        self._count += 1

    @staticmethod
    def list_recordings() -> list[dict[str, Any]]:
        if not RECORDINGS_DIR.exists():
            return []
        out = []
        for p in sorted(RECORDINGS_DIR.glob("*.jsonl"), reverse=True):
            try:
                lines = sum(1 for _ in p.open())
            except OSError:
                lines = 0
            out.append({
                "name": p.name,
                "path": str(p),
                "events": lines,
                "size_bytes": p.stat().st_size,
            })
        return out
