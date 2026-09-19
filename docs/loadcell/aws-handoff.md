# AWS handoff for the load-cell firmware (proposal)

How `firmware/loadcell/` would send bites to AWS. **Proposal only:** `PLAN.md`
defers AWS in favour of the local backend, and this message format differs from
`docs/telemetry-schema.md` (see the last section). Decide which one wins before
building either.

## 1. Connection

| Item | Value |
|---|---|
| Path | ESP32 → Wi-Fi → AWS IoT Core (MQTT/TLS, port 8883) → IoT Rule → Lambda → DynamoDB |
| Thing / MQTT client ID | `spoon-01` |
| Topic | `devices/spoon-01/bites` |
| IoT Rule | `SELECT *, topic(2) AS deviceId FROM 'devices/+/bites'` → Lambda `ingestBite` |
| IoT policy | Connect as `spoon-01`, publish to that one topic only |
| Delivery | QoS 1 + resend after Wi-Fi drops, so **a bite can arrive twice**. The Lambda must ignore duplicates. |
| Rate | One message per bite (~every 5–60 s while eating). Nothing while idle, no raw sensor data. |
| Size | ~250 bytes (ESP32 buffer is 512) |

The firmware side needs the IoT endpoint (`xxxx-ats.iot.<region>.amazonaws.com`),
device certificate, private key and `AmazonRootCA1.pem`, shared privately.
**Never in git or chat.**

## 2. Bite message

```json
{
  "biteId": 7,
  "ts": 1789000123456,
  "salinity": 10.11,
  "tempC": 44.8,
  "weightG": 11.4,
  "loadedG": 12.0,
  "leftoverG": 0.6,
  "heldStill": true,
  "tempSettled": true,
  "gapS": 3.8,
  "tooFast": true,
  "fwVersion": "0.2.0"
}
```

| Field | Type / unit | Meaning |
|---|---|---|
| `biteId` | int | Counter, **restarts every reboot**: not a unique key on its own |
| `ts` | int, epoch **ms**, UTC (NTP) | When the bite was confirmed |
| `salinity` | float, mS/cm | Conductivity, compensated to 25 °C |
| `tempC` | float, °C | Food temperature |
| `weightG` | float, g | **Eaten** = `loadedG − leftoverG` |
| `loadedG`, `leftoverG` | float, g | On the spoon before / left after |
| `heldStill` | bool | `false` = weighed while moving (less accurate) |
| `tempSettled` | bool | `false` = temp probe still catching up (less accurate) |
| `gapS` | float s, or `null` | Time since the previous bite, `null` for the first after boot |
| `tooFast` | bool | Device's call: < 6 s since the last bite, LED lit |
| `fwVersion` | string | Firmware version |
| `deviceId` | string | **Not in the payload**: the IoT Rule adds it from the topic |

Not sent: sodium, raw motion data, any patient identity.

## 3. Lambda `ingestBite`

1. **Validate:** `weightG` 0–100 (load cell max), `salinity` 0–50, `tempC` 0–100,
   `ts` within ±1 day of now. Reject otherwise.
2. **Find the patient** from pairing item `DEVICE#<deviceId>` → `PATIENT#<id>`
   (fixed demo patient until pairing exists).
3. **Compute sodium** (in the cloud so the factor can change without reflashing,
   and old bites can be recomputed from stored raw values):
   ```
   sodiumMg     = salinity × 0.55 × weightG × 0.393
   range        = 0.30 + (0.15 if !heldStill) + (0.15 if !tempSettled)
   sodiumLowMg  = sodiumMg × (1 − range)
   sodiumHighMg = sodiumMg × (1 + range)
   ```
   Store `formulaVersion: 1`. The 0.55 is a placeholder until measured.
4. **Write** PK `PATIENT#<id>`, SK `BITE#<ts>#<deviceId>`, with
   `ConditionExpression: attribute_not_exists(SK)` to drop QoS 1 duplicates.
5. **Never log the payload.** Once linked to a patient it's health data. Log
   request IDs and status only.

## 4. Dashboard

- **"Eating too fast!"** on any bite with `tooFast: true` (no timing logic needed).
- Sodium as a **range**, labelled "measured by spoon"; "lower confidence" when
  `heldStill` or `tempSettled` is false.
- Per bite, per meal and daily totals vs the clinician's target; group meals by
  gaps in `ts`. Trends (e.g. fast bites per meal) come from queries over `ts`.

## 5. Test without hardware

IoT Core → MQTT test client → publish the JSON above to `devices/spoon-01/bites`.
One item should appear with `deviceId: "spoon-01"` and the sodium fields. Publish
it again: still one item.

## Differences from `docs/telemetry-schema.md` (`bite/v1`)

| | This proposal | `bite/v1` |
|---|---|---|
| Naming | camelCase, units implied | snake_case, unit in every name (`ec25_ms_cm`) |
| Time | `ts` epoch ms | `ts_utc` ISO-8601 string |
| Portion | measured `weightG` | calibrated `volume_ml` |
| Sodium | computed in the Lambda | computed on the device |
| Pace | `tooFast` bool (6 s) | `pace` green/yellow/red (30 s / 15 s) |
| Key | `BITE#<ts>#<deviceId>` | `BITE#<ts_utc>#<bite_id>` |

If the team keeps `bite/v1`, the load-cell firmware can adopt it by adding
`weight_g` next to `volume_ml` and following its naming rule.
