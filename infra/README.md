# NaTrack on AWS — phases 1–2: ingest, and the live session

What `docs/natrack-system-design.pdf` calls ingest, as far as the durable write:

```
spoon ──MQTT/TLS──► IoT Core ──rule──► SQS ──► Lambda ingestBite ──► DynamoDB
       cert per device   devices/+/bites   bite-ingest   validate, dedupe   telemetry
```

…and from the table out to anyone watching that patient live:

```
ingestBite ──► API Gateway WebSocket ──► clinician's browser
               wss://<api>/live?patientId=demo-1
```

Later phases (not here): Cognito and the `/v1/...` API, the dashboard on
Amplify, then hardening (KMS CMK, private subnets, Streams → `MealSummary`, S3
archive, CloudTrail).

The message is `bite/v2`, defined in `docs/telemetry-schema.md`. That file is
the contract; this stack is plumbing around it. `docs/loadcell/aws-handoff.md`
maps the firmware's struct onto it.

## What is here

| File | |
|---|---|
| `template.yaml` | The stack: two tables, queue + dead-letter queue, the Lambda, the thing, its policy, the topic rule |
| `ingest/app.py` | `ingestBite` — the cloud twin of `backend/app/main.py:_handle_bite`, and the live push |
| `session/app.py` | The live session's connection book: who is watching which patient |
| `scripts/watch-session.py` | Watches a patient's session from the terminal, as the dashboard will |
| `test_validate.py` | The refusal rules, no AWS needed: `python3 infra/test_validate.py` |
| `sample-bite.json` | The load-cell spoon's bite, from the handoff doc |
| `scripts/create-device-cert.sh` | The spoon's certificate (CLI-only: the key is shown once) |
| `scripts/publish-test-bite.sh` | Publish a bite and show what landed |

## Deploy

Needs the `natrack` profile (`aws sso login --profile natrack`) and SAM.

```bash
cd infra
sam build
sam deploy --guided --profile natrack     # stack name: natrack, region: us-east-1
```

Answer `y` to "Allow SAM CLI IAM role creation" and to saving `samconfig.toml`.
Later deploys are just `sam build && sam deploy --profile natrack`.

## Test it, without the spoon

```bash
infra/scripts/publish-test-bite.sh          # a normal bite  -> one new item
infra/scripts/publish-test-bite.sh 36.8 7   # same bite_id   -> still one item
infra/scripts/publish-test-bite.sh 44.8     # too hot        -> no item at all
```

Or by hand in the console: **IoT Core → Test → MQTT test client**, publish
`infra/sample-bite.json` to `devices/spoon-01/bites`.

Watch the function:

```bash
sam logs -n ingestBite --stack-name natrack --tail --profile natrack
```

A refused bite logs `bite refused (...): 44.8 C outside probe range 0.0-40.0 C`
and stores nothing. A replay logs `stored=False`.

## The live session

```bash
python3 infra/scripts/watch-session.py demo-1     # leave this open
infra/scripts/publish-test-bite.sh                # in another terminal
```

The bite should appear in the watcher about a second after it is published.
Measured on the deployed stack: published 07:59:52, on screen 07:59:53.

That second is mostly Lambda. The first version of this stack batched SQS
messages for up to 5 s and took **22 s** end to end; `MaximumBatchingWindowInSeconds`
is 0 because the window is pure latency on the live view and a spoon sends one
bite every few seconds at most. Batching earns its keep at 10k bites/s, not at
one — turn it back up if that day arrives.

**The patient is a query string, not a path.** NaTrack writes the live view as
`wss://.../session/{patientId}`, but a WebSocket API routes on the message body
and cannot take a path parameter, so it is `?patientId=demo-1` instead. Phase 4
can put NaTrack's spelling back with a custom domain if the dashboard wants it.

**The push is best effort, and after the write.** The table is the source of
truth; a bite nobody was watching is not a bite that was lost. A failed push is
logged and dropped rather than retried — the bite is already durable, and a
retry would only delay the next one. A replay is never pushed twice, because
the write is what decides whether anything is new.

**Connections are rows with a TTL.** `SESSION#<patientId>` / `CONN#<id>` says
who is listening, `CONN#<id>` / `SESSION` says which patient a socket joined,
because `$disconnect` is told nothing but the connection id. A socket API
Gateway forgot to close expires in 12 hours instead of being pushed to for ever;
one that has already gone (`GoneException`) is deleted on the spot.

**No auth yet.** `$connect` takes any `patientId`, which is fine for a stack
holding synthetic demo data and is not fine for real patients. Cognito on the
`$connect` route is phase 3, together with the `canAccess` check the reference
sheet calls the biggest real risk.

## Decisions worth knowing

**Two tables.** The design PDF keeps patient medical data apart from telemetry,
with the stricter IAM on the patients table. The ingest Lambda holds
`PutItem` + `GetItem` on the telemetry table only — it cannot read a profile at
all. (The old reference sheet sketched one table; the PDF wins, per `PLAN.md`.)

**Pairing lives in the telemetry table** (`DEVICE#<id>` / `PAIRING`), so
resolving a device to a patient does not need the patients table. Until
`POST /v1/devices/{id}/pair` exists (phase 3), bites go to `demo-1`.

**`deviceId` comes from the topic.** The rule selects `topic(2) AS deviceId`,
overwriting whatever the payload claims, so one spoon cannot impersonate
another.

**Writes are idempotent.** SQS is at-least-once and the firmware resends after a
Wi-Fi drop. The sort key is `BITE#{timestamp}#{deviceId}#{bite_id}` and the
write is guarded by `attribute_not_exists(SK)`: a replay collides exactly, two
genuine bites in the same millisecond do not.

**0–40 °C is refused, not flagged.** Enforced on the device, in the local
backend, and again here. Outside the probe's rating a reading is unsupported,
not merely imprecise. Do not add a path that stores it anyway.

**No payload ever reaches the logs.** A bite tied to a patient is health data;
CloudWatch gets ids and outcomes. Log retention is 14 days.

**Refused vs failed.** A message that can never be valid is dropped after one
log line; a failed write is retried and reaches the dead-letter queue after 5
attempts. `batchItemFailures` means one bad bite does not replay a whole batch.

## What a real bite looks like here

From the board on 2026-09-20, through `devices/spoon-01/bites`:

```
SK               BITE#2026-09-20T07:33:07.494Z#spoon-01#2
patientId        demo-1          (added on ingest, from the device pairing)
salinityIndex    13.04 mS/cm     ec_sample_count 125
tempC            21.9            inside 0-40, so it was accepted
salinity_g_l     7.18            quadratic curve, computed on the device
weightGrams      31.2            sodiumEstimate 88.3 mg (48.5-128)
pour_tilt_deg    78              the tip that confirmed the bite
quality          0.8             flags ["tempUnsettled"]
```

21 s from pour to stored: the queue's batching window plus a cold start. Fine for
the dashboard's history, which is why phase 2's WebSocket exists for the live
view. `pour_tilt_deg` is a firmware extension (#9): the Lambda stores unknown
keys and tolerates unknown flags, so the contract can grow without a redeploy.

## Cost

Everything here is pay-per-use and idles at ~$0: on-demand DynamoDB, SQS,
Lambda, IoT Core. A `natrack-monthly` budget alerts at $20.

## Not done in phase 1

- ~~The firmware has no MQTT client~~ — it does now (#9), and a real bite from
  the board has landed in this table. The test script still works for checking
  the stack without hardware.
- The device certificate is created by `scripts/create-device-cert.sh`, not by
  the stack. Keys stay in `~/natrack-certs/`, never in git.
- `MealSummary` rows, the REST API and Cognito are phases 3–5. The local backend
  keeps serving the demo meanwhile, exactly as `HANDOFF.md` intends.
- The live session is unauthenticated, and `meal_totals` / `label_check` are not
  in the pushed message: the cloud has no meal grouping until `MealSummary`
  (phase 5). The local backend's session message carries both.
