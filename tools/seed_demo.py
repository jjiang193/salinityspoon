#!/usr/bin/env python3
"""Seed two weeks of synthetic history for the demo cohort.

The clinician view compares patients over weeks; without this it opens on five
empty rows. Everything written is tagged as seeded (see backend/app/demo_seed.py)
and `--reset` removes exactly that.

    python tools/seed_demo.py            # top up the last 14 days, idempotent
    python tools/seed_demo.py --reset    # remove seeded rows, keep real ones
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import demo_seed  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--reset", action="store_true", help="remove seeded rows and exit")
    args = p.parse_args()

    if args.reset:
        demo_seed.reset()
        print("Seeded rows removed.")
        return

    # Days are the local machine's days, matching what the dashboard will ask for.
    offset = datetime.now().astimezone().utcoffset()
    counts = demo_seed.seed(int(offset.total_seconds() // 60) if offset else 0)
    for patient_id, n in counts.items():
        print(f"{patient_id}: {n} bites written")


if __name__ == "__main__":
    main()
