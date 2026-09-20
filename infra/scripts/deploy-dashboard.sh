#!/usr/bin/env bash
# Build the dashboard against this stack and put it behind CloudFront.
#
#   infra/scripts/deploy-dashboard.sh
#
# The API URL, the socket URL and the Cognito client id all come from the
# stack's outputs, so there is nothing to paste and nothing to keep in sync. A
# build with none of them set is the local one, which talks to a laptop through
# Vite's proxy and has no sign-in at all - that stays the demo path.
set -euo pipefail

STACK="${STACK:-natrack}"
PROFILE="${AWS_PROFILE:-natrack}"
REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text \
    --profile "$PROFILE" --region "$REGION"
}

BUCKET=$(out DashboardBucketName)
DIST=$(out DashboardDistributionId)
export VITE_API_BASE=$(out ApiUrl)
export VITE_WS_BASE=$(out SessionUrl)
export VITE_COGNITO_CLIENT_ID=$(out UserPoolClientId)
export VITE_COGNITO_REGION="$REGION"

echo "building against $VITE_API_BASE"
cd "$HERE/dashboard"
[ -d node_modules ] || npm ci
npm run build

echo "uploading to s3://$BUCKET"
# Hashed assets can be cached for a year; index.html must never be, or a
# browser keeps loading last week's app against this week's API.
aws s3 sync dist "s3://$BUCKET" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable" --profile "$PROFILE" --region "$REGION"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache" --profile "$PROFILE" --region "$REGION"

echo "invalidating the distribution"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --query 'Invalidation.Status' --output text --profile "$PROFILE" --region "$REGION"

echo
echo "live at $(out DashboardUrl)"
echo "sign in with the accounts from infra/scripts/seed-cloud.py"
