"""ingestBite - the cloud twin of backend/app/main.py:_handle_bite.

One bite/v2 message per SQS record (IoT Core -> rule -> queue). Validate it,
find whose spoon it came from, store it exactly once, then push it to anyone
watching that patient's live session.

Mirrors the local backend deliberately. If the contract in
docs/telemetry-schema.md changes, change it here, in backend/app/schema.py and
in the firmware together.

Never log a payload. A bite tied to a patient is health data; CloudWatch gets
ids and outcomes only.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

log = logging.getLogger()
log.setLevel(logging.INFO)

TABLE = boto3.resource("dynamodb").Table(os.environ["TELEMETRY_TABLE"])
DEFAULT_PATIENT_ID = os.environ.get("DEFAULT_PATIENT_ID", "demo-1")
RETENTION_DAYS = int(os.environ.get("BITE_RETENTION_DAYS", "90"))

# The live session (phase 2). Empty until the WebSocket API exists, and the
# push is best effort either way: the table is the source of truth, so a bite
# nobody was watching is not a bite that was lost.
WS_ENDPOINT = os.environ.get("WS_ENDPOINT", "")
_ws = boto3.client("apigatewaymanagementapi", endpoint_url=WS_ENDPOINT) if WS_ENDPOINT else None

BITE_SCHEMA = "bite/v2"

# backend/app/salinity.py - the probe's rating, not a preference.
PROBE_TEMP_MIN_C = 0.0
PROBE_TEMP_MAX_C = 40.0
PROBE_EC_MAX_MS_CM = 20.0  # hard detection ceiling
MAX_WEIGHT_G = 100.0  # load cell's range
CLOCK_SKEW = timedelta(days=1)

REQUIRED_NUMBERS = (
    "salinityIndex",
    "tempC",
    "salinity_g_l",
    "weightGrams",
    "sodiumEstimate",
    "sodium_mg_low",
    "sodium_mg_high",
)


class Refused(Exception):
    """The message is not a storable bite. Dropping it is the correct outcome."""


def _number(payload: dict[str, Any], field: str) -> float:
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Refused(f"{field} must be a number")
    return float(value)


def validate(payload: dict[str, Any]) -> dict[str, Any]:
    """The same checks the local backend makes, in the same order."""
    schema = payload.get("schema")
    if schema != BITE_SCHEMA:
        raise Refused(f"unknown schema {schema!r}; this ingest speaks {BITE_SCHEMA}")

    device_id = payload.get("deviceId")
    if not isinstance(device_id, str) or not device_id:
        raise Refused("deviceId missing")

    bite_id = payload.get("bite_id")
    if isinstance(bite_id, bool) or not isinstance(bite_id, int):
        raise Refused("bite_id must be an integer")

    timestamp = payload.get("timestamp")
    if not isinstance(timestamp, str):
        raise Refused("timestamp missing")
    try:
        when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Refused(f"timestamp is not ISO-8601: {exc}") from exc
    if when.tzinfo is None:
        raise Refused("timestamp must carry a UTC offset")
    if abs(when - datetime.now(timezone.utc)) > CLOCK_SKEW:
        raise Refused("timestamp more than a day from now; check the device's NTP clock")

    for field in REQUIRED_NUMBERS:
        _number(payload, field)

    # The interlock, enforced here as well as on the device. Outside the rated
    # range a reading is not less precise, it is unsupported - so the bite is
    # refused, not flagged. Do not add a "store it anyway" path.
    temp_c = _number(payload, "tempC")
    if not PROBE_TEMP_MIN_C <= temp_c <= PROBE_TEMP_MAX_C:
        raise Refused(
            f"{temp_c} C outside probe range {PROBE_TEMP_MIN_C}-{PROBE_TEMP_MAX_C} C"
        )

    salinity_index = _number(payload, "salinityIndex")
    if not 0.0 <= salinity_index <= PROBE_EC_MAX_MS_CM:
        raise Refused(f"salinityIndex {salinity_index} outside 0-{PROBE_EC_MAX_MS_CM} mS/cm")

    weight_g = _number(payload, "weightGrams")
    if not 0.0 <= weight_g <= MAX_WEIGHT_G:
        raise Refused(f"weightGrams {weight_g} outside 0-{MAX_WEIGHT_G} g")

    flags = payload.get("flags", [])
    if not isinstance(flags, list) or not all(isinstance(f, str) for f in flags):
        raise Refused("flags must be a list of strings")

    return payload


def patient_for(device_id: str) -> str:
    """Pairing written by POST /v1/devices/{id}/pair. Demo patient until then.

    A spoon never sends a patientId - it does not know who is holding it.
    """
    try:
        item = TABLE.get_item(
            Key={"PK": f"DEVICE#{device_id}", "SK": "PAIRING"},
            ProjectionExpression="patientId",
        ).get("Item")
    except ClientError:
        log.exception("pairing lookup failed for device %s", device_id)
        raise
    if item and item.get("patientId"):
        return str(item["patientId"])
    return DEFAULT_PATIENT_ID


def store(payload: dict[str, Any], patient_id: str) -> tuple[bool, dict[str, Any]]:
    """Write the bite. Returns (stored, item); stored is False on a replay.

    SQS is at-least-once and the firmware resends after a Wi-Fi drop, so the
    same bite can arrive twice. bite_id is in the sort key: a replay collides
    exactly, two genuine bites in the same millisecond do not.
    """
    sk = f"BITE#{payload['timestamp']}#{payload['deviceId']}#{payload['bite_id']}"
    item = {
        # Every raw field is kept, so old bites can be recomputed if the EC
        # curve is recalibrated.
        **payload,
        "PK": f"PATIENT#{patient_id}",
        "SK": sk,
        "patientId": patient_id,
        "receivedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "expiresAt": int(time.time() + RETENTION_DAYS * 86400),
    }
    try:
        TABLE.put_item(
            # DynamoDB has no float type: round-trip through Decimal.
            Item=json.loads(json.dumps(item), parse_float=Decimal),
            ConditionExpression="attribute_not_exists(SK)",
        )
        return True, item
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False, item
        raise


def push_live(payload: dict[str, Any], patient_id: str) -> int:
    """Send the stored bite to every socket watching this patient.

    Best effort, and deliberately after the write: the durable record is the
    point, the live view is a courtesy. A failure here is logged and dropped,
    never retried - a replayed bite would be deduped away anyway, so the retry
    would only delay the next one.
    """
    if not _ws:
        return 0

    try:
        conns = TABLE.query(
            KeyConditionExpression=Key("PK").eq(f"SESSION#{patient_id}") & Key("SK").begins_with("CONN#"),
            ProjectionExpression="connectionId",
        ).get("Items", [])
    except ClientError:
        log.exception("could not list live sessions for this patient")
        return 0

    message = json.dumps({
        "type": "bite",
        "patientId": patient_id,
        "received_at": payload["receivedAt"],
        "data": {k: v for k, v in payload.items() if k not in ("PK", "SK", "expiresAt")},
    }, default=str).encode()

    sent = 0
    for c in conns:
        cid = c["connectionId"]
        try:
            _ws.post_to_connection(ConnectionId=cid, Data=message)
            sent += 1
        except _ws.exceptions.GoneException:
            # The viewer closed the tab and API Gateway never told us. Tidy up.
            TABLE.delete_item(Key={"PK": f"SESSION#{patient_id}", "SK": f"CONN#{cid}"})
            TABLE.delete_item(Key={"PK": f"CONN#{cid}", "SK": "SESSION"})
        except ClientError:
            log.exception("live push failed for one connection")
    return sent


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """SQS batch. A refused message is dropped; a failed write is retried.

    Returning the ids of failed records leaves only those on the queue, so one
    bad bite cannot make a whole batch repeat.
    """
    failures: list[dict[str, str]] = []

    for record in event.get("Records", []):
        message_id = record["messageId"]
        try:
            payload = validate(json.loads(record["body"]))
        except (json.JSONDecodeError, Refused) as exc:
            # Retrying will not help: drop it, and say why without the payload.
            log.warning("bite refused (%s): %s", message_id, exc)
            continue

        try:
            patient_id = patient_for(payload["deviceId"])
            stored, item = store(payload, patient_id)
        except Exception:
            # Transient: retry, then the dead-letter queue after 5 attempts.
            log.exception("bite write failed (%s)", message_id)
            failures.append({"itemIdentifier": message_id})
            continue

        # A replay is not pushed twice: the viewer already has it.
        watching = push_live(item, patient_id) if stored else 0
        log.info(
            "bite %s device=%s stored=%s live=%d",
            payload["bite_id"], payload["deviceId"], stored, watching,
        )

    return {"batchItemFailures": failures}
