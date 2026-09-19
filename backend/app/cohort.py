"""Per-patient summaries for the clinician view.

Everything here is arithmetic over stored totals. No risk score, no triage
model: a clinician gets the numbers and the target they set, and draws their
own conclusion.

Three rules shape the numbers:

**An unlogged day is not a zero day.** Averages run over days that have data,
and the count of logged days is reported beside them. Averaging in zeros would
reward a patient for leaving the spoon in a drawer.

**Today is excluded from the trailing window.** A day that is half over drags
an average down until dinner, which reads as improvement every morning.

**Drift is a comparison of two windows, not a slope.** NaTrack asks that a
clinician be "flagged on upward drift" and leaves it undefined. A fitted slope
over fourteen noisy days moves with one salty dinner; two weekly means do not.
The rule is written down in docs/telemetry-schema.md so it can be argued with.
"""

from typing import Any, Optional

from . import labels, salinity, store

# Trailing window for the averages, in full days before today.
WINDOW_DAYS = 7

# NaTrack's `range` parameter, as a number of days in the `daily` series.
RANGE_DAYS = {"day": 1, "week": 7, "month": 30}

# The roster's sparkline.
ROSTER_DAYS = 14

# Upward drift: this window's mean against the previous window's.
DRIFT_THRESHOLD = 0.15
DRIFT_MIN_LOGGED_DAYS = 3

# Sanity bounds for a clinician-entered target. Typos in medical data mislead
# clinicians (PLAN.md §7), and 15000 is a typo, not a prescription.
TARGET_MIN_MG = 500
TARGET_MAX_MG = 5000


def label_check(meal: dict[str, Any]) -> Optional[labels.LabelCheck]:
    """Check a finished meal against its label, from the meal's mean salinity.

    Mean, not last bite: a clinician reading history wants what the bowl was,
    and the weight-averaged mean over thirty bites is the better estimate.
    Grams stand in for millilitres here, as they do in sodiumEstimate.
    """
    if meal["label_claim"] == "none" or meal["total_weight_g"] <= 0:
        return None
    g_l = meal["totalSodium"] / (
        salinity.SODIUM_FRACTION_OF_NACL * meal["total_weight_g"]
    )
    return labels.check(g_l, meal["label_claim"])


def _mean_logged(days: list[dict[str, Any]]) -> tuple[Optional[float], int]:
    logged = [d for d in days if d["logged"]]
    if not logged:
        return None, 0
    return sum(d["total_sodium_mg"] for d in logged) / len(logged), len(logged)


def summarise(
    patient: dict[str, Any], tz_offset_min: int = 0, in_meal: bool = False,
    history_days: int = ROSTER_DAYS,
) -> dict[str, Any]:
    target = patient["sodiumTarget"]

    # Enough history for both drift windows plus today, whatever was asked for.
    span = max(history_days, 2 * WINDOW_DAYS + 1)
    all_days = store.daily_totals(patient["patientId"], span, tz_offset_min)

    today = all_days[-1]
    window = all_days[-(WINDOW_DAYS + 1):-1]
    previous = all_days[-(2 * WINDOW_DAYS + 1):-(WINDOW_DAYS + 1)]

    avg, days_logged = _mean_logged(window)
    prev_avg, prev_logged = _mean_logged(previous)

    drift_pct: Optional[float] = None
    if (
        avg is not None and prev_avg
        and days_logged >= DRIFT_MIN_LOGGED_DAYS and prev_logged >= DRIFT_MIN_LOGGED_DAYS
    ):
        drift_pct = (avg / prev_avg - 1.0) * 100.0

    # Days since anything was logged, counted in local days so "yesterday"
    # means what a person means by it.
    days_since_log: Optional[int] = None
    for back, day in enumerate(reversed(all_days)):
        if day["logged"]:
            days_since_log = back
            break

    # Meals in the window (and today): label flags, and NaTrack's pace metrics.
    since = window[0]["date"]
    flagged = paced = 0
    gaps: list[tuple[float, int]] = []
    quickest: Optional[float] = None
    for meal in store.list_meals(60, patient["patientId"]):
        if store.local_date(meal["start"], tz_offset_min).isoformat() < since:
            break
        check = label_check(meal)
        flagged += bool(check and check.flagged)
        paced += meal["paceFlag"]
        if meal["avgBiteIntervalSec"] is not None:
            gaps.append((meal["avgBiteIntervalSec"], meal["biteCount"]))
            fastest = meal["minBiteIntervalSec"]
            quickest = fastest if quickest is None else min(quickest, fastest)

    # Weighted by bites, so a three-bite snack does not count as much as dinner.
    total_bites = sum(n for _, n in gaps)
    avg_interval = sum(g * n for g, n in gaps) / total_bites if total_bites else None

    return {
        **patient,
        "today": today,
        "pct_of_target_today": today["total_sodium_mg"] / target * 100.0,
        "window_days": WINDOW_DAYS,
        "avg_sodium_mg": avg,
        "pct_of_target_avg": avg / target * 100.0 if avg is not None else None,
        "days_logged": days_logged,
        "days_over_target": sum(
            1 for d in window if d["logged"] and d["total_sodium_mg"] > target
        ),
        "days_since_log": days_since_log,
        "drift_pct": drift_pct,
        "upward_drift": drift_pct is not None and drift_pct >= DRIFT_THRESHOLD * 100.0,
        "flagged_meals": flagged,
        "avgBiteIntervalSec": avg_interval,
        "minBiteIntervalSec": quickest,
        "pace_flagged_meals": paced,
        "last_activity_at": store.last_activity(patient["patientId"]),
        "in_meal": in_meal,
        "daily": all_days[-history_days:],
    }
