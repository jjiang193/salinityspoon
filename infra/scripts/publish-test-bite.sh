#!/usr/bin/env bash
# Publish a bite to IoT Core as if the spoon had sent it, then show what landed.
#
# Usage:
#   infra/scripts/publish-test-bite.sh              # the sample bite, now
#   infra/scripts/publish-test-bite.sh 44.8         # a refused one: too hot
#   infra/scripts/publish-test-bite.sh 36.8 7       # fix bite_id to test a replay
#
# This uses your own AWS credentials, not the device certificate, so it proves
# the rule, the queue, the Lambda and the table - not the TLS path. That one
# needs the firmware (phase 5 of the firmware work).
set -euo pipefail

TEMP_C="${1:-36.8}"
BITE_ID="${2:-$RANDOM}"
DEVICE_ID="${DEVICE_ID:-spoon-01}"
STACK="${STACK:-natrack}"
PROFILE="${AWS_PROFILE:-natrack}"
REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TABLE=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='TelemetryTableName'].OutputValue" \
  --output text --profile "$PROFILE" --region "$REGION")

TS=$(python3 -c "from datetime import datetime,timezone; \
print(datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))")

PAYLOAD=$(python3 - "$HERE/sample-bite.json" "$TS" "$TEMP_C" "$BITE_ID" <<'PY'
import json, sys
bite = json.load(open(sys.argv[1]))
bite["timestamp"] = sys.argv[2]
bite["tempC"] = float(sys.argv[3])
bite["bite_id"] = int(sys.argv[4])
print(json.dumps(bite))
PY
)

echo "publishing bite_id=$BITE_ID tempC=$TEMP_C to devices/$DEVICE_ID/bites"
aws iot-data publish \
  --topic "devices/$DEVICE_ID/bites" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" \
  --profile "$PROFILE" --region "$REGION"

echo "waiting for the queue and the function ..."
sleep 8

echo
echo "bites now in $TABLE:"
aws dynamodb query \
  --table-name "$TABLE" \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"PATIENT#demo-1"}}' \
  --query "Items[].{SK:SK.S,tempC:tempC.N,sodium:sodiumEstimate.N}" \
  --output table --profile "$PROFILE" --region "$REGION"
