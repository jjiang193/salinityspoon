"""Live sessions and meal segmentation."""

import asyncio
import json
import time
from datetime import datetime
from typing import Any, Optional

from fastapi import WebSocket

from . import cohort, store

# A meal is a run of bites with no gap longer than this.
MEAL_GAP_MINUTES = 20.0


class Hub:
    """NaTrack's live session: one channel per patient.

    A socket opened at /session/{patientId} receives that patient's events and
    nothing else. Who is eating is health data, so a session is never told
    about another patient - only, anonymously, that the spoon is busy.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()
        # Held for whoever has the spoon, to prime a tab opened mid-meal.
        self.last_sample: Optional[dict[str, Any]] = None
        self.last_bite: Optional[dict[str, Any]] = None

    async def register(self, ws: WebSocket, patient_id: str) -> None:
        async with self._lock:
            self._sessions.setdefault(patient_id, set()).add(ws)

    async def unregister(self, ws: WebSocket, patient_id: str) -> None:
        async with self._lock:
            watchers = self._sessions.get(patient_id)
            if watchers:
                watchers.discard(ws)
                if not watchers:
                    del self._sessions[patient_id]

    async def patients(self) -> list[str]:
        async with self._lock:
            return list(self._sessions)

    async def send(self, patient_id: str, message: dict[str, Any]) -> None:
        """Push to everyone watching one patient."""
        text = json.dumps(message)
        async with self._lock:
            targets = list(self._sessions.get(patient_id, ()))

        dead = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                # A dashboard tab closing mid-send is normal, not an error.
                dead.append(ws)

        for ws in dead:
            await self.unregister(ws, patient_id)


class MealTracker:
    """Groups bites into meals, and knows who is holding the spoon.

    Nobody wants to press Start before eating. The first bite after a long gap
    opens a meal; subsequent bites join it. Meals close on the next bite that
    falls outside the window, explicitly via the API, or - for the ordinary end
    of a meal, where the spoon is put down and nothing is pressed - by
    close_if_idle, which main.py runs on a timer.

    Pressing Start is still allowed, and does two things the implicit path
    cannot: it says *whose* meal this is, and it lets a label claim be declared
    before the first bite rather than after it.

    Whose meal an unannounced bite belongs to comes from the device's pairing
    (POST /v1/devices/{id}/pair). Starting a meal from the patient portal pairs
    the spoon to that patient: handing someone the spoon and pairing it to them
    are the same act.
    """

    def __init__(self, hub: Hub) -> None:
        self.hub = hub
        self.meal_id: Optional[int] = None
        self.patient_id: str = store.DEFAULT_PATIENT_ID
        self.device_id: Optional[str] = None
        self._last_bite_at: Optional[datetime] = None
        # When the open meal was last started or fed, by this process's clock.
        # Bite timestamps are the device's, and a replayed recording carries
        # old ones; idleness is about how long the server has heard nothing.
        self._last_activity: Optional[float] = None

    # --- what each session is told about the spoon ---------------------------
    def spoon_state(self, patient_id: str) -> dict[str, Any]:
        holder = patient_id == self.patient_id
        # What is in the bowl is the holder's alone. Everyone else gets the
        # empty values, whether or not a meal is open.
        mine = self.meal_id if holder else None
        product_name, label_claim = store.get_meal_label(mine)
        return {
            "type": "spoon",
            "holder": holder,
            # Deliberately anonymous: see Hub.
            "busy": self.meal_id is not None and not holder,
            "mealId": mine,
            "product_name": product_name,
            "label_claim": label_claim,
            "label_check": cohort.live_label_check(mine),
        }

    async def announce(self) -> None:
        for patient_id in await self.hub.patients():
            await self.hub.send(patient_id, self.spoon_state(patient_id))

    # --- meals -----------------------------------------------------------------
    async def assign(self, bite: dict[str, Any]) -> int:
        ts = datetime.fromisoformat(bite["timestamp"].replace("Z", "+00:00"))

        gap_exceeded = (
            self._last_bite_at is not None
            and (ts - self._last_bite_at).total_seconds() > MEAL_GAP_MINUTES * 60
        )

        if self.meal_id is None or gap_exceeded:
            await self._close()
            # An unannounced meal belongs to whoever the spoon is paired with.
            self.patient_id = store.device_patient(bite["deviceId"]) or self.patient_id
            self.meal_id = store.start_meal(bite["deviceId"], self.patient_id)
            await self._opened()

        if self._last_bite_at is None:
            # First bite of the meal: now we know which spoon it is. A meal
            # started from the portal had no device, and so no pairing, until now.
            store.set_meal_device(self.meal_id, bite["deviceId"])
            store.pair_device(bite["deviceId"], self.patient_id)
        self.device_id = bite["deviceId"]
        self._last_bite_at = ts
        self._last_activity = time.monotonic()
        return self.meal_id

    async def start(self, patient_id: str) -> int:
        """Open a meal explicitly, for a named patient.

        Any meal already open is closed first: one spoon cannot be in two bowls.
        `_last_bite_at` is cleared so the first bite joins this meal however
        long the patient takes to sit down.
        """
        await self._close()
        self.patient_id = patient_id
        if self.device_id:
            store.pair_device(self.device_id, patient_id)
        self.meal_id = store.start_meal(self.device_id or "unassigned", patient_id)
        self._last_activity = time.monotonic()
        await self._opened()
        return self.meal_id

    async def hand_to(self, patient_id: str) -> None:
        """The spoon was paired to someone else. Their meals start now."""
        await self._close()
        self.patient_id = patient_id
        await self.announce()

    async def force_close(self) -> Optional[int]:
        """Manual override for when the demo needs a clean break."""
        closed = await self._close()
        await self.announce()
        return closed

    async def close_if_idle(self) -> Optional[int]:
        """Close a meal nobody has fed for MEAL_GAP_MINUTES.

        Without this a meal only ever closed on the *next* bite, so a patient
        who simply stopped eating stayed "in a meal" until tomorrow's breakfast
        - and every screen kept reporting a spoon gone silent mid-meal.
        """
        if self.meal_id is None or self._last_activity is None:
            return None
        if time.monotonic() - self._last_activity <= MEAL_GAP_MINUTES * 60:
            return None
        return await self.force_close()

    async def _opened(self) -> None:
        self.hub.last_bite = None
        await self.hub.send(
            self.patient_id,
            {"type": "meal_started", "mealId": self.meal_id, "patientId": self.patient_id},
        )
        await self.announce()

    async def _close(self) -> Optional[int]:
        if self.meal_id is None:
            return None
        closed = self.meal_id
        store.close_meal(closed)
        self.meal_id = None
        self._last_bite_at = None
        self._last_activity = None
        # The primer is for a tab opened mid-meal. Left in place, a tab opened
        # after the meal would be handed its last bite and show it as in progress.
        self.hub.last_bite = None
        await self.hub.send(
            self.patient_id,
            {"type": "meal_ended", "mealId": closed, "patientId": self.patient_id},
        )
        return closed
