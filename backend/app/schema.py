"""Telemetry contract. See docs/telemetry-schema.md."""

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

SAMPLE_SCHEMA = "sample/v1"
BITE_SCHEMA = "bite/v1"

# Samples below this are charted but never counted toward a salinity estimate.
QUALITY_THRESHOLD = 0.6

Motion = Literal["still", "stirring", "moving", "unknown"]
DetectorState = Literal["IDLE", "WETTING", "CAPTURE", "CONFIRM", "LOG", "ABORT"]
Pace = Literal["green", "yellow", "red", "unknown"]


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
    device_id: str = "spoon-01"
    seq: int = 0
    uptime_ms: int = 0

    temp_c: Optional[float] = None
    temp_in_range: bool = False
    ec25_ms_cm: float = 0.0
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
    device_id: str = "spoon-01"
    bite_id: int
    ts_utc: str

    ec25_ms_cm: float
    temp_c: float
    salinity_g_l: float
    salinity_source: Literal["measured", "bowl_reference"] = "measured"
    dilution_factor: float = 1.0

    volume_ml: float
    volume_source: Literal["user_calibrated", "default"] = "default"

    sodium_mg: float
    sodium_mg_low: float
    sodium_mg_high: float

    quality: float = 0.0
    ec_sample_count: int = 0
    seconds_since_prev_bite: Optional[float] = None
    pace: Pace = "unknown"
    fw_version: str = "0.0.0"

    model_config = {"populate_by_name": True}


def utcnow_iso() -> str:
    """ISO-8601 UTC with milliseconds. Not epoch seconds — see the schema doc."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
