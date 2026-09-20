"""The live session's connection book.

NaTrack's live view is a WebSocket per patient: a clinician subscribes and every
new bite arrives as it lands. API Gateway holds the sockets; this function only
records who is listening to whom, so ingestBite knows where to push.

Two items per connection, because each direction is needed once:

    SESSION#<patientId> / CONN#<id>   -> who is listening to this patient
    CONN#<id>           / SESSION     -> which patient this socket joined

The second exists because $disconnect is told the connection id and nothing
else. Both carry a TTL: a socket API Gateway forgot to close should not leave a
row behind for ever.

A connection is not health data, but it names a patient, so the same rule
applies as everywhere else: log ids, never payloads.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger()
log.setLevel(logging.INFO)

TABLE = boto3.resource("dynamodb").Table(os.environ["TELEMETRY_TABLE"])
TTL_HOURS = int(os.environ.get("CONNECTION_TTL_HOURS", "12"))


def _ok(body: str = "ok") -> dict[str, Any]:
    return {"statusCode": 200, "body": body}


def connect(connection_id: str, params: dict[str, str]) -> dict[str, Any]:
    patient_id = (params or {}).get("patientId")
    if not patient_id:
        # The route is per patient, so there is nothing sensible to subscribe to
        # without one. Refusing at $connect closes the socket immediately.
        log.warning("connect refused (%s): no patientId", connection_id)
        return {"statusCode": 400, "body": "connect with ?patientId=<id>"}

    expires = int(time.time() + TTL_HOURS * 3600)
    TABLE.put_item(Item={
        "PK": f"SESSION#{patient_id}", "SK": f"CONN#{connection_id}",
        "connectionId": connection_id, "patientId": patient_id, "expiresAt": expires,
    })
    TABLE.put_item(Item={
        "PK": f"CONN#{connection_id}", "SK": "SESSION",
        "connectionId": connection_id, "patientId": patient_id, "expiresAt": expires,
    })
    log.info("session joined: connection=%s patient=%s", connection_id, patient_id)
    return _ok("connected")


def disconnect(connection_id: str) -> dict[str, Any]:
    try:
        item = TABLE.get_item(
            Key={"PK": f"CONN#{connection_id}", "SK": "SESSION"},
            ProjectionExpression="patientId",
        ).get("Item")
    except ClientError:
        log.exception("disconnect lookup failed (%s)", connection_id)
        raise

    if item:
        TABLE.delete_item(Key={"PK": f"SESSION#{item['patientId']}", "SK": f"CONN#{connection_id}"})
        TABLE.delete_item(Key={"PK": f"CONN#{connection_id}", "SK": "SESSION"})
        log.info("session left: connection=%s", connection_id)
    return _ok("disconnected")


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    ctx = event.get("requestContext", {})
    route = ctx.get("routeKey")
    connection_id = ctx.get("connectionId", "")

    if route == "$connect":
        return connect(connection_id, event.get("queryStringParameters") or {})
    if route == "$disconnect":
        return disconnect(connection_id)

    # $default. The session is one-way - bites flow out, nothing flows in - so
    # anything arriving here is a client checking the socket is alive.
    return _ok("this session only sends; nothing to do with what you sent")
