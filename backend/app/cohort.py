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

# NaTrack's `range` parameter, as a number of days in the `daily` series. A week
# is the averaged window plus today: the seven finished days a chart draws are
# then exactly the seven the averages and "days over target" were counted over.
RANGE_DAYS = {"day": 1, "week": WINDOW_DAYS + 1, "month": 30}

# The roster's sparkline.
ROSTER_DAYS = 14

# Upward drift: this window's mean against the previous window's.
DRIFT_THRESHOLD = 0.15
DRIFT_MIN_LOGGED_DAYS = 3

# Sanity bounds for a clinician-entered target. Typos in medical data mislead
# clinicians (PLAN.md §7), and 15000 is a typo, not a prescription.
TARGET_MIN_MG = 500
TARGET_MAX_MG = 5000


def _salinity_g_l(sodium_mg: float, weight_g: float) -> Optional[float]:
    if weight_g <= 0:
        return None
    return sodium_mg / (salinity.SODIUM_FRACTION_OF_NACL * weight_g)


def meal_salinity_g_l(meal: dict[str, Any]) -> Optional[float]:
    """What the bowl was: the meal's weight-averaged NaCl-equivalent salinity,
    g/L. None until a bite has been weighed. Grams stand in for millilitres
    here, as they do in sodiumEstimate."""
    return _salinity_g_l(meal["totalSodium"], meal["total_weight_g"])


def label_check(meal: dict[str, Any]) -> Optional[labels.LabelCheck]:
    """Check a finished meal against its label, from the meal's mean salinity.

    Mean, not last bite: a clinician reading history wants what the bowl was,
    and the weight-averaged mean over thirty bites is the better estimate.
    """
    g_l = meal_salinity_g_l(meal)
    if meal["label_claim"] == "none" or g_l is None:
        return None
    return labels.check(g_l, meal["label_claim"])


def live_label_check(meal_id: Optional[int]) -> Optional[dict[str, Any]]:
    """The open meal against its label, as the live session carries it.

    Judged on the meal's mean so far, not on the bite that just landed. Near
    the 2x threshold a single bite flips the flag on and off from one spoonful
    to the next, and history already judges a meal by its mean: the live view
    and the clinician's table must not disagree about the same bowl.
    """
    meal = store.get_meal_row(meal_id) if meal_id is not None else None
    g_l = meal_salinity_g_l(meal) if meal else None
    if g_l is None:
        return None
    return {
        "product_name": meal["product_name"],
        **labels.check(g_l, meal["label_claim"]).__dict__,
    }


def sources(
    patient_id: str, days: int, tz_offset_min: int = 0,
    daily: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Where the logged sodium came from, over the same local days as `daily`.

    One row per product for what the spoon measured, one per name for what the
    patient typed in. Measured and self-reported are never merged into one row,
    even under the same name: they are not the same claim. Shares are of LOGGED
    sodium only - a patient who logs only soup gets 100 % soup, which says
    nothing about what they ate. Ranked by milligrams. It is a sort order, not
    a score.

    Meals are placed by when they started and days by when each bite landed, so
    a bowl eaten across the window's first midnight can leave this total a few
    bites off the sum of `daily`.
    """
    if daily is None:
        daily = store.daily_totals(patient_id, days, tz_offset_min)

    # Product names are typed by the patient: "Chicken broth" and "chicken broth "
    # are one product. Grouped as the self-reported names are below, and shown
    # in the first spelling seen.
    measured: dict[tuple[Optional[str], str], dict[str, Any]] = {}
    for meal in store.meals_in_window(patient_id, days, tz_offset_min):
        product = (meal["product_name"] or "").strip() or None
        item = measured.setdefault(
            (product.lower() if product else None, meal["label_claim"]),
            {
                "kind": "measured",
                "name": product,  # None: product not declared
                "portion": None,
                "label_claim": meal["label_claim"],
                "label_claim_label": labels.CLAIM_LABEL.get(meal["label_claim"]),
                "count": 0, "sodium_mg": 0.0, "weight_g": 0.0, "flagged_count": 0,
            },
        )
        check = label_check(meal)
        item["count"] += 1
        item["sodium_mg"] += meal["totalSodium"]
        item["weight_g"] += meal["total_weight_g"]
        item["flagged_count"] += bool(check and check.flagged)

    # Newest first, so the first entry seen in a group supplies how it is shown.
    manual: dict[str, dict[str, Any]] = {}
    for entry in store.manual_meals_in_window(patient_id, days, tz_offset_min):
        item = manual.setdefault(
            entry["name"].strip().lower(),
            {
                "kind": "manual",
                "name": entry["name"].strip(),
                "portion": entry["portion"],
                "label_claim": None,
                "label_claim_label": None,
                "count": 0, "sodium_mg": 0.0, "weight_g": 0.0, "flagged_count": 0,
            },
        )
        item["count"] += 1
        item["sodium_mg"] += entry["sodium_mg"]

    measured_mg = sum(i["sodium_mg"] for i in measured.values())
    manual_mg = sum(i["sodium_mg"] for i in manual.values())
    total = measured_mg + manual_mg

    items = []
    for item in (*measured.values(), *manual.values()):
        g_l = _salinity_g_l(item["sodium_mg"], item.pop("weight_g"))
        items.append({
            **item,
            "share_pct": item["sodium_mg"] / total * 100.0 if total > 0 else 0.0,
            "mean_salinity_g_l": g_l,
            "mg_per_serving": salinity.sodium_mg(g_l, labels.REFERENCE_SERVING_ML)
            if g_l is not None else None,
        })
    items.sort(key=lambda i: i["sodium_mg"], reverse=True)

    return {
        "days": days,
        "days_logged": sum(1 for d in daily if d["logged"]),
        "total_sodium_mg": total,
        "measured_sodium_mg": measured_mg,
        "manual_sodium_mg": manual_mg,
        "items": items,
    }


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
