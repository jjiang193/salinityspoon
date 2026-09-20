#!/usr/bin/env bash
# Publish a bite to IoT Core as if the spoon had sent it, then show what landed.
#
# Usage:
#   infra/scripts/publish-test-bite.sh              # the sample bite, now
#   infra/scripts/publish-test-bite.sh 44.8         # a refused one: too hot
#   infra/scripts/publish-test-bite.sh 36.8 7 2026-09-20T06:28:52.609Z
#                                                   # a true replay: same bite,
#                                                   # same timestamp, same id
#
# This uses your own AWS credentials, not the device certificate, so it proves
# the rule, the queue, the Lambda and the table - not the TLS path. That one
# needs the firmware (phase 5 of the firmware work).
set -euo pipefail

TEMP_C="${1:-36.8}"
BITE_ID="${2:-$RANDOM}"
# A replay is the *same* bite arriving twice, so the timestamp is part of it:
# pass one to test dedupe, leave it out for a new bite.
TS_ARG="${3:-}"
DEVICE_ID="${DEVICE_ID:-spoon-01}"
STACK="${STACK:-natrack}"
PROFILE="${AWS_PROFILE:-natrack}"
REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TABLE=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='TelemetryTableName'].OutputValue" \
  --output text --profile "$PROFILE" --region "$REGION")

TS="${TS_ARG:-$(python3 -c "from datetime import datetime,timezone; \
print(datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))")}"

PAYLOAD=$(python3 - "$HERE/sample-bite.json" "$TS" "$TEMP_C" "$BITE_ID" <<'PY'
import json, sys
bite = json.load(open(sys.argv[1]))
bite["timestamp"] = sys.argv[2]
bite["tempC"] = float(sys.argv[3])
bite["bite_id"] = int(sys.argv[4])
print(json.dumps(bite))
PY
)

BEFORE=$(aws dynamodb query \
  --table-name "$TABLE" \
  --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" \
  --expression-attribute-values \
    "{\":pk\":{\"S\":\"PATIENT#demo-1\"},\":sk\":{\"S\":\"BITE#\"}}" \
  --select COUNT --query Count --output text \
  --profile "$PROFILE" --region "$REGION")
echo "bites before: $BEFORE"

echo "publishing bite_id=$BITE_ID tempC=$TEMP_C ts=$TS to devices/$DEVICE_ID/bites"
aws iot-data publish \
  --topic "devices/$DEVICE_ID/bites" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" \
  --profile "$PROFILE" --region "$REGION"

# The queue batches for up to 5 s and a cold start adds ~0.5 s, so poll rather
# than guess. A refused bite never arrives, hence the timeout below is normal
# for the 44.8 C case.
echo -n "waiting for the bite to land "
for _ in $(seq 1 15); do
  sleep 2
  echo -n "."
  FOUND=$(aws dynamodb query \
    --table-name "$TABLE" \
    --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" \
    --expression-attribute-values \
      "{\":pk\":{\"S\":\"PATIENT#demo-1\"},\":sk\":{\"S\":\"BITE#\"}}" \
    --select COUNT --query Count --output text \
    --profile "$PROFILE" --region "$REGION")
  [ "$FOUND" -gt "${BEFORE:-0}" ] && break
done
echo

echo
echo "bites now in $TABLE:"
aws dynamodb query \
  --table-name "$TABLE" \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"PATIENT#demo-1"}}' \
  --query "Items[].{SK:SK.S,tempC:tempC.N,sodium:sodiumEstimate.N}" \
  --output table --profile "$PROFILE" --region "$REGION"
