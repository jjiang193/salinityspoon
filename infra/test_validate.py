"""The refusal rules, without AWS. Run: python3 infra/test_validate.py

Only validate() is covered here - everything below it needs DynamoDB. The
deployed path is tested by publishing to IoT Core, see infra/README.md.
"""

import json
import os
import pathlib
import sys
import types
from datetime import datetime, timezone
from unittest import mock

os.environ.setdefault("TELEMETRY_TABLE", "test-table")
sys.path.insert(0, str(pathlib.Path(__file__).parent / "ingest"))

# Lambda has boto3; a laptop need not. Stub what app.py touches at import.
if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.resource = mock.MagicMock()
    sys.modules["boto3"] = boto3
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = type("ClientError", (Exception,), {})
    sys.modules["botocore"] = types.ModuleType("botocore")
    sys.modules["botocore.exceptions"] = exceptions

import app  # noqa: E402

SAMPLE = json.loads((pathlib.Path(__file__).parent / "sample-bite.json").read_text())


def bite(**overrides):
    payload = {**SAMPLE, "timestamp": datetime.now(timezone.utc)
               .isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    payload.update(overrides)
    return payload


def refused(why, **overrides):
    try:
        app.validate(bite(**overrides))
    except app.Refused as exc:
        print(f"  ok   refused {why}: {exc}")
        return
    raise AssertionError(f"should have refused {why}")


def accepted(why, **overrides):
    app.validate(bite(**overrides))
    print(f"  ok   accepted {why}")


print("validate():")
accepted("the sample bite")
accepted("0 C, the low edge", tempC=0.0)
accepted("40 C, the high edge", tempC=40.0)
accepted("an unknown flag", flags=["fast", "somethingNew"])
accepted("a first bite with no interval", biteIntervalSec=None)

refused("hot soup", tempC=44.8)
refused("a freezing sample", tempC=-0.1)
refused("bite/v1", schema="bite/v1")
refused("no schema", schema=None)
refused("a missing number", sodiumEstimate=None)
refused("a string where a number belongs", weightGrams="10.2")
refused("more than the load cell can hold", weightGrams=101.0)
refused("a reading past the probe ceiling", salinityIndex=20.1)
refused("epoch timestamps", timestamp="1758304812317")
refused("a timestamp with no zone", timestamp="2026-09-19T18:04:12.317")
refused("a stale clock", timestamp="2020-01-01T00:00:00.000Z")
refused("flags that are not strings", flags=[1, 2])
refused("a missing bite_id", bite_id=None)

print("\nall good")
