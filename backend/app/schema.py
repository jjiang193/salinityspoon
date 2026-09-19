"""Telemetry contract. See docs/telemetry-schema.md.

NaTrack names are camelCase; fields NaTrack does not cover keep this repo's
snake_case. The casing is deliberate - it says whose field it is.
"""

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

SAMPLE_SCHEMA = "sample/v2"
BITE_SCHEMA = "bite/v2"

# Samples below this are charted but never counted toward a salinity estimate.
QUALITY_THRESHOLD = 0.6

Motion = Literal["still", "stirring", "moving", "unknown"]
DetectorState = Literal["IDLE", "WETTING", "CAPTURE", "CONFIRM", "LOG", "ABORT"]
Pace = Literal["green", "yellow", "red", "unknown"]
VolumeSource = Literal["load_cell", "user_calibrated", "default"]

# The `flags` vocabulary. Unknown flags are tolerated, not rejected: a newer
# firmware must not lose bites to an older backend.
FLAG_FAST = "fast"


class IMU(BaseModel):
    ax: float = 0.0
    ay: float = 0.0
    az: float = 0.0
    gx: float = 0.0
    gy: float = 0.0
    gz: float = 0.0


class Sample(BaseModel):
    """High-rate local telemetry. Never persisted beyond the session."""

    schema_name: str = Field(default=SAMPLE_SCHEMA, alias="schema")
    deviceId: str = "spoon-01"
    seq: int = 0
    uptime_ms: int = 0

    tempC: Optional[float] = None
    temp_in_range: bool = False
    salinityIndex: float = 0.0
    salinity_g_l: float = 0.0

    imu: IMU = Field(default_factory=IMU)
    motion: Motion = "unknown"
    submerged: bool = False
    state: DetectorState = "IDLE"
    quality: float = 0.0

    model_config = {"populate_by_name": True}

    @property
    def trustworthy(self) -> bool:
        return self.submerged and self.temp_in_range and self.quality >= QUALITY_THRESHOLD


class Bite(BaseModel):
    """The durable record. One per scoop."""

    schema_name: str = Field(default=BITE_SCHEMA, alias="schema")
    deviceId: str = "spoon-01"
    bite_id: int
    timestamp: str

    salinityIndex: float
    tempC: float
    salinity_g_l: float
    salinity_source: Literal["measured", "bowl_reference"] = "measured"
    dilution_factor: float = 1.0

    weightGrams: float
    volume_source: VolumeSource = "default"

    sodiumEstimate: float
    sodium_mg_low: float
    sodium_mg_high: float

    quality: float = 0.0
    ec_sample_count: int = 0
    biteIntervalSec: Optional[float] = None
    pace: Pace = "unknown"
    flags: list[str] = Field(default_factory=list)
    fw_version: str = "0.0.0"

    model_config = {"populate_by_name": True}


def utcnow_iso() -> str:
    """ISO-8601 UTC with milliseconds. Not epoch seconds — see the schema doc."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
