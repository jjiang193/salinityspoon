"""Live fan-out and meal segmentation."""

import asyncio
import json
from datetime import datetime
from typing import Any, Optional

from fastapi import WebSocket

from . import store

# A meal is a run of bites with no gap longer than this.
MEAL_GAP_MINUTES = 20.0


class Hub:
    """Fans every event out to every connected dashboard."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self.last_sample: Optional[dict[str, Any]] = None
        self.last_bite: Optional[dict[str, Any]] = None

    async def register(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.add(ws)

    async def unregister(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        text = json.dumps(message)
        async with self._lock:
            targets = list(self._clients)

        dead = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                # A dashboard tab closing mid-send is normal, not an error.
                dead.append(ws)

        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)


class MealTracker:
    """Groups bites into meals.

    Nobody wants to press Start before eating. The first bite after a long gap
    opens a meal; subsequent bites join it. Meals close lazily — on the next
    bite that falls outside the window, or explicitly via the API.
    """

    def __init__(self, hub: Hub) -> None:
        self.hub = hub
        self.meal_id: Optional[int] = None
        self._last_bite_at: Optional[datetime] = None

    async def assign(self, bite: dict[str, Any]) -> int:
        ts = datetime.fromisoformat(bite["ts_utc"])

        gap_exceeded = (
            self._last_bite_at is not None
            and (ts - self._last_bite_at).total_seconds() > MEAL_GAP_MINUTES * 60
        )

        if self.meal_id is None or gap_exceeded:
            if self.meal_id is not None:
                store.close_meal(self.meal_id)
                await self.hub.broadcast(
                    {"type": "meal_ended", "meal_id": self.meal_id}
                )
            self.meal_id = store.start_meal(bite["device_id"])
            await self.hub.broadcast({"type": "meal_started", "meal_id": self.meal_id})

        self._last_bite_at = ts
        return self.meal_id

    async def force_close(self) -> Optional[int]:
        """Manual override for when the demo needs a clean break."""
        if self.meal_id is None:
            return None
        closed = self.meal_id
        store.close_meal(closed)
        self.meal_id = None
        self._last_bite_at = None
        await self.hub.broadcast({"type": "meal_ended", "meal_id": closed})
        return closed
