#!/usr/bin/env python3
"""Mock spoon — speaks the real protocol over the real WebSocket.

Exists so dashboard work never blocks on hardware. It is not a stub: it runs the
same bite-detection state machine the firmware does, with plausible noise, so
quality gating, the temperature interlock and meal segmentation all get
exercised properly.

    pip install websockets
    python tools/mock_spoon.py --salt 0.6

Options for driving a demo by hand:
    --salt 0.9          saltier liquid (% w/v)
    --temp 24           liquid temperature °C
    --temp 55           above the probe's 40 °C limit — watch bites get refused
    --pace 12           eat fast, to make the LED go red
    --noise 0.5         crank EC noise until the quality gate rejects bites
"""

import argparse
import asyncio
import json
import math
import random
import statistics
import time
from datetime import datetime, timezone

import websockets

SAMPLE_SCHEMA = "sample/v1"
BITE_SCHEMA = "bite/v1"
FW_VERSION = "mock-0.2.0"

COEFF_A = 0.49078
COEFF_B = 0.004608
SODIUM_FRACTION = 0.3934

PROBE_TEMP_MAX_C = 40.0
QUALITY_THRESHOLD = 0.6

DEFAULT_VOLUME_ML = 10.0
DEFAULT_VOLUME_SD_ML = 2.5


def g_per_litre_to_ec25(g_l: float) -> float:
    """Inverse of the quadratic fit: what EC would the probe read?"""
    if g_l <= 0:
        return 0.0
    disc = COEFF_A**2 + 4 * COEFF_B * g_l
    return (-COEFF_A + math.sqrt(disc)) / (2 * COEFF_B)


def ec_to_g_per_litre(ec: float) -> float:
    return COEFF_A * ec + COEFF_B * ec**2 if ec > 0 else 0.0


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class MockSpoon:
    """Runs the firmware's state machine against simulated sensors.

    One bite cycle: IDLE (between bites) → WETTING → CAPTURE → CONFIRM → LOG.
    """

    WETTING_MS = 150
    CAPTURE_MS = 500          # a real scoop is about half a second in the liquid
    CONFIRM_MS = 200
    MIN_EC_SAMPLES = 20

    def __init__(self, args: argparse.Namespace):
        self.target_g_l = args.salt * 10.0
        self.liquid_temp = args.temp
        self.ambient = args.ambient
        self.noise = args.noise
        self.pace_s = args.pace
        self.volume_mean = args.volume
        self.volume_sd = args.volume_sd

        self.seq = 0
        self.bite_id = 0
        self.t0 = time.time()
        self.state = "IDLE"
        self.state_since = time.time()
        self.ec_buffer: list[float] = []
        self.last_bite_at: float | None = None
        self.next_bite_due = time.time() + self.pace_s

    # --- helpers -----------------------------------------------------------
    def _enter(self, state: str) -> None:
        self.state = state
        self.state_since = time.time()
        if state == "WETTING":
            self.ec_buffer.clear()

    def _elapsed_ms(self) -> float:
        return (time.time() - self.state_since) * 1000

    @property
    def submerged(self) -> bool:
        return self.state in ("WETTING", "CAPTURE")

    # --- state machine -----------------------------------------------------
    def advance(self) -> dict | None:
        """Step the machine. Returns a bite event when one is logged."""
        now = time.time()

        if self.state == "IDLE":
            if now >= self.next_bite_due:
                self._enter("WETTING")
        elif self.state == "WETTING":
            if self._elapsed_ms() >= self.WETTING_MS:
                self._enter("CAPTURE")
        elif self.state == "CAPTURE":
            if self._elapsed_ms() >= self.CAPTURE_MS:
                self._enter("CONFIRM")
        elif self.state == "CONFIRM":
            if self._elapsed_ms() >= self.CONFIRM_MS:
                bite = self._log_bite()
                self._enter("IDLE")
                self.next_bite_due = now + self.pace_s * random.uniform(0.8, 1.2)
                return bite
        return None

    def _log_bite(self) -> dict | None:
        # The interlock. Out of range, no bite — the same rule the firmware and
        # the backend both enforce.
        if self.liquid_temp > PROBE_TEMP_MAX_C:
            print(f"  ABORT: {self.liquid_temp:.1f} °C exceeds the probe's 40 °C limit")
            return None

        if len(self.ec_buffer) < self.MIN_EC_SAMPLES:
            print(f"  ABORT: only {len(self.ec_buffer)} EC samples")
            return None

        sd = statistics.stdev(self.ec_buffer) if len(self.ec_buffer) > 1 else 0.0
        stability = 1.0 - min(max((sd - 0.05) / 0.45, 0.0), 1.0)
        quality = round(min(1.0, 0.5 + 0.5 * stability), 3)
        if quality < QUALITY_THRESHOLD:
            print(f"  ABORT: quality {quality:.2f} below threshold")
            return None

        # Median, not mean — one bubble must not move a sodium figure.
        ec25 = statistics.median(self.ec_buffer)
        g_l = ec_to_g_per_litre(ec25)

        now = time.time()
        gap = None if self.last_bite_at is None else round(now - self.last_bite_at, 1)
        self.last_bite_at = now
        self.bite_id += 1

        vol = self.volume_mean
        sodium = g_l * SODIUM_FRACTION * vol
        low = g_l * SODIUM_FRACTION * max(0.0, vol - self.volume_sd)
        high = g_l * SODIUM_FRACTION * (vol + self.volume_sd)

        return {
            "schema": BITE_SCHEMA,
            "device_id": "spoon-mock",
            "bite_id": self.bite_id,
            "ts_utc": utcnow_iso(),
            "ec25_ms_cm": round(ec25, 3),
            "temp_c": round(self.liquid_temp, 2),
            "salinity_g_l": round(g_l, 3),
            "salinity_source": "measured",
            "dilution_factor": 1.0,
            "volume_ml": round(vol, 2),
            "volume_source": "default",
            "sodium_mg": round(sodium, 2),
            "sodium_mg_low": round(low, 2),
            "sodium_mg_high": round(high, 2),
            "quality": quality,
            "ec_sample_count": len(self.ec_buffer),
            "seconds_since_prev_bite": gap,
            "pace": self.pace_for(gap),
            "fw_version": FW_VERSION,
        }

    @staticmethod
    def pace_for(gap: float | None) -> str:
        if gap is None:
            return "unknown"
        if gap > 30:
            return "green"
        if gap >= 15:
            return "yellow"
        return "red"

    # --- sampling ----------------------------------------------------------
    def sample(self) -> dict:
        self.seq += 1
        submerged = self.submerged

        if not submerged:
            ec25 = max(0.0, random.gauss(0.05, 0.03))       # in air, near zero
            temp = self.ambient + random.gauss(0, 0.1)
            gyro = [random.gauss(0, 0.05) for _ in range(3)]
            motion = "still"
        else:
            ec25 = g_per_litre_to_ec25(self.target_g_l)
            if self.state == "WETTING":
                ec25 *= random.uniform(0.3, 0.9)             # probe not yet wetted
            ec25 = max(0.0, ec25 + random.gauss(0, self.noise))
            temp = self.liquid_temp + random.gauss(0, 0.15)
            gyro = [random.gauss(0, 0.06) for _ in range(3)]
            motion = "still"
            if self.state == "CAPTURE":
                self.ec_buffer.append(ec25)

        if self.state == "CONFIRM":
            gyro = [random.gauss(0, 1.5) for _ in range(3)]  # the lift
            motion = "moving"

        accel = [random.gauss(0, 0.05), random.gauss(0, 0.05), 9.81 + random.gauss(0, 0.06)]

        return {
            "schema": SAMPLE_SCHEMA,
            "device_id": "spoon-mock",
            "seq": self.seq,
            "uptime_ms": int((time.time() - self.t0) * 1000),
            "temp_c": round(temp, 2),
            "temp_in_range": temp <= PROBE_TEMP_MAX_C,
            "ec25_ms_cm": round(ec25, 3),
            "salinity_g_l": round(ec_to_g_per_litre(ec25), 3),
            "imu": {
                "ax": round(accel[0], 3), "ay": round(accel[1], 3), "az": round(accel[2], 3),
                "gx": round(gyro[0], 4), "gy": round(gyro[1], 4), "gz": round(gyro[2], 4),
            },
            "motion": motion,
            "submerged": submerged,
            "state": self.state,
            "quality": round(0.9 if submerged and self.state == "CAPTURE" else 0.0, 3),
        }


async def run(args: argparse.Namespace) -> None:
    spoon = MockSpoon(args)
    url = f"ws://{args.host}:{args.port}/ws/ingest"
    interval = 1.0 / args.rate

    while True:
        try:
            async with websockets.connect(url) as ws:
                print(f"connected to {url}")
                print(f"  {args.salt}% salt, {args.temp} °C, a bite every ~{args.pace}s")
                if args.temp > PROBE_TEMP_MAX_C:
                    print(f"  NOTE: {args.temp} °C is above the probe's 40 °C limit — "
                          f"every bite will be refused by the interlock")
                while True:
                    await ws.send(json.dumps(spoon.sample()))
                    bite = spoon.advance()
                    if bite:
                        await ws.send(json.dumps(bite))
                        print(f"  bite #{bite['bite_id']}: "
                              f"{bite['salinity_g_l']:.2f} g/L, "
                              f"{bite['sodium_mg']:.1f} mg Na "
                              f"({bite['sodium_mg_low']:.0f}–{bite['sodium_mg_high']:.0f}), "
                              f"{bite['pace']}")
                    await asyncio.sleep(interval)
        except Exception as exc:
            print(f"connection lost ({exc}); retrying in 2s")
            await asyncio.sleep(2)


def main() -> None:
    p = argparse.ArgumentParser(description="Mock salinity spoon")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--rate", type=float, default=50.0, help="samples per second")
    p.add_argument("--salt", type=float, default=0.6, help="liquid salinity, %% w/v")
    p.add_argument("--temp", type=float, default=24.0, help="liquid temperature, C")
    p.add_argument("--ambient", type=float, default=22.0, help="room temperature, C")
    p.add_argument("--noise", type=float, default=0.08, help="EC noise sigma, mS/cm")
    p.add_argument("--pace", type=float, default=35.0, help="seconds between bites")
    p.add_argument("--volume", type=float, default=DEFAULT_VOLUME_ML)
    p.add_argument("--volume-sd", type=float, default=DEFAULT_VOLUME_SD_ML)
    args = p.parse_args()

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
