#!/usr/bin/env bash
# Create the spoon's X.509 certificate and attach it to the thing and policy.
#
# CloudFormation cannot do this: the private key is returned once and never
# again, so it is a CLI step by design.
#
# Usage: infra/scripts/create-device-cert.sh [device-id] [stack-name]
#
# The files land in ~/natrack-certs/<device-id>/ - OUTSIDE the repo, on purpose.
# Never commit a private key. The firmware reads them from a gitignored
# secrets.h.
set -euo pipefail

DEVICE_ID="${1:-spoon-01}"
STACK="${2:-natrack}"
PROFILE="${AWS_PROFILE:-natrack}"
REGION="${AWS_REGION:-us-east-1}"
OUT="$HOME/natrack-certs/$DEVICE_ID"

mkdir -p "$OUT"
chmod 700 "$HOME/natrack-certs" "$OUT"

if [ -f "$OUT/certificate.pem.crt" ]; then
  echo "refusing to overwrite $OUT - delete it first if you really mean to"
  exit 1
fi

echo "creating certificate for $DEVICE_ID ..."
ARN=$(aws iot create-keys-and-certificate \
  --set-as-active \
  --certificate-pem-outfile "$OUT/certificate.pem.crt" \
  --private-key-outfile "$OUT/private.pem.key" \
  --public-key-outfile "$OUT/public.pem.key" \
  --query certificateArn --output text \
  --profile "$PROFILE" --region "$REGION")

aws iot attach-thing-principal --thing-name "$DEVICE_ID" --principal "$ARN" \
  --profile "$PROFILE" --region "$REGION"
aws iot attach-policy --policy-name "${STACK}-spoon" --target "$ARN" \
  --profile "$PROFILE" --region "$REGION"

curl -fsS https://www.amazontrust.com/repository/AmazonRootCA1.pem \
  -o "$OUT/AmazonRootCA1.pem"

chmod 600 "$OUT"/*

ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text --profile "$PROFILE" --region "$REGION")

cat <<EOF

done. certificate arn:
  $ARN

files (keep them out of git):
  $OUT

for the firmware's secrets.h:
  #define AWS_IOT_ENDPOINT "$ENDPOINT"
  #define AWS_IOT_CLIENT_ID "$DEVICE_ID"
  #define AWS_IOT_TOPIC     "devices/$DEVICE_ID/bites"
EOF
