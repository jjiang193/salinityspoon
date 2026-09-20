#!/usr/bin/env python3
"""Create the demo patient, the demo clinician, and the two Cognito users.

    python3 infra/scripts/seed-cloud.py [--password 'Something-Long-1']

Synthetic people only. This is health-shaped data and the rule the whole
project runs on is that no real patient's numbers go anywhere near the demo.

It is safe to run twice: the profile is overwritten, and a user that already
exists is left alone (only its password is reset, so you can always get in).
"""

import argparse
import json
import secrets
import subprocess
import sys

STACK = "natrack"
PROFILE = "natrack"
REGION = "us-east-1"

PATIENT_ID = "demo-1"
# These are usernames, not mailboxes: Cognito is told to suppress its mail
# (--message-action SUPPRESS), so nothing is ever sent to them. RFC 2606 keeps
# a .invalid domain for exactly this, which is what these were; .com is the
# house style here, so the rule that matters is the one below - the domain is
# ours to type and the people are invented.
PATIENT_EMAIL = "patient@natrack-demo.com"
CLINICIAN_EMAIL = "clinician@natrack-demo.com"


def aws(*args: str, quiet: bool = False) -> str:
    out = subprocess.run(["aws", *args, "--profile", PROFILE, "--region", REGION],
                         capture_output=True, text=True)
    if out.returncode and not quiet:
        sys.exit(f"aws {' '.join(args[:3])} failed:\n{out.stderr.strip()}")
    return out.stdout.strip()


def outputs() -> dict[str, str]:
    raw = aws("cloudformation", "describe-stacks", "--stack-name", STACK,
              "--query", "Stacks[0].Outputs", "--output", "json")
    return {o["OutputKey"]: o["OutputValue"] for o in json.loads(raw)}


def put(table: str, item: dict) -> None:
    aws("dynamodb", "put-item", "--table-name", table, "--item", json.dumps(item))


def user(pool: str, email: str, password: str, group: str, patient_id: str | None) -> None:
    attrs = [{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}]
    if patient_id:
        attrs.append({"Name": "custom:patientId", "Value": patient_id})
    aws("cognito-idp", "admin-create-user", "--user-pool-id", pool, "--username", email,
        "--user-attributes", json.dumps(attrs), "--message-action", "SUPPRESS", quiet=True)
    # Permanent, so the first sign-in is not a forced password change - this is
    # a demo account, not a person's.
    aws("cognito-idp", "admin-set-user-password", "--user-pool-id", pool, "--username", email,
        "--password", password, "--permanent")
    aws("cognito-idp", "admin-add-user-to-group", "--user-pool-id", pool, "--username", email,
        "--group-name", group)
    print(f"  {group:9} {email}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--password", default=None, help="one password for both demo accounts")
    args = ap.parse_args()
    password = args.password or "NaDemo"

    out = outputs()
    pool, patients, telemetry = out["UserPoolId"], out["PatientsTableName"], out["TelemetryTableName"]

    print("patient profile and clinician assignment:")
    put(patients, {
        "PK": {"S": f"PATIENT#{PATIENT_ID}"}, "SK": {"S": "PROFILE"},
        "patientId": {"S": PATIENT_ID}, "name": {"S": "Demo Patient"},
        "age": {"N": "72"}, "condition": {"S": "Hypertension"},
        "sodiumTarget": {"N": "1500"}, "clinicianId": {"S": CLINICIAN_EMAIL},
    })
    put(patients, {
        "PK": {"S": f"CLINICIAN#{CLINICIAN_EMAIL}"}, "SK": {"S": f"PATIENT#{PATIENT_ID}"},
        "GSI1PK": {"S": f"CLINICIAN#{CLINICIAN_EMAIL}"}, "GSI1SK": {"S": f"PATIENT#{PATIENT_ID}"},
        "patientId": {"S": PATIENT_ID}, "clinicianId": {"S": CLINICIAN_EMAIL},
    })
    print(f"  patient {PATIENT_ID} assigned to {CLINICIAN_EMAIL}")

    print("device pairing:")
    put(telemetry, {
        "PK": {"S": "DEVICE#spoon-01"}, "SK": {"S": "PAIRING"},
        "deviceId": {"S": "spoon-01"}, "patientId": {"S": PATIENT_ID},
    })
    print(f"  spoon-01 -> {PATIENT_ID}")

    print("cognito users:")
    user(pool, PATIENT_EMAIL, password, "patient", PATIENT_ID)
    user(pool, CLINICIAN_EMAIL, password, "clinician", None)

    print(f"\npassword for both: {password}")
    print("Synthetic people only - never seed a real patient's numbers.")


if __name__ == "__main__":
    main()
