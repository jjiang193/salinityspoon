"""Label claims, and the potassium-substitute flag.

The sensor cannot tell sodium from potassium — it reads all ions. Normally that
is a limitation. Here it is the one thing this hardware can do that no food
database or barcode app can:

    A product LABELLED low-sodium that MEASURES high ionic content is likely
    using a non-sodium ionic salt — almost always potassium chloride.

That matters clinically. Potassium chloride is the usual salt substitute, and
for people with chronic kidney disease, or on ACE inhibitors, ARBs or
potassium-sparing diuretics, excess potassium risks hyperkalemia.

This is a FLAG, not a diagnosis. It says "this does not look like what the label
claims, ask someone". It never tells anyone what to do about it.
"""

from dataclasses import dataclass
from typing import Literal, Optional

from . import salinity

# FDA nutrient content claims, milligrams of sodium per labelled serving.
# 21 CFR 101.61.
LabelClaim = Literal[
    "sodium_free", "very_low_sodium", "low_sodium", "reduced_sodium", "none"
]

CLAIM_MAX_SODIUM_MG_PER_SERVING: dict[str, float] = {
    "sodium_free": 5.0,
    "very_low_sodium": 35.0,
    "low_sodium": 140.0,
}

CLAIM_LABEL: dict[str, str] = {
    "sodium_free": "Sodium free",
    "very_low_sodium": "Very low sodium",
    "low_sodium": "Low sodium",
    "reduced_sodium": "Reduced sodium",
    "none": "No claim",
}

# A labelled serving for liquid foods. The claim is per serving, so the measured
# concentration has to be scaled to the same basis before they can be compared.
REFERENCE_SERVING_ML = 240.0

# How far over the claim before we flag. Set well above the measurement error
# budget (±10% on a meal) so a flag means a real discrepancy, not sensor noise.
FLAG_RATIO_THRESHOLD = 2.0


@dataclass
class LabelCheck:
    claim: str
    claim_label: str
    claim_max_mg: Optional[float]
    measured_mg_per_serving: float
    ratio: Optional[float]
    flagged: bool
    severity: Literal["none", "info", "warning"]
    headline: str
    detail: str


def check(
    salinity_g_l: float,
    claim: str,
    serving_ml: float = REFERENCE_SERVING_ML,
) -> LabelCheck:
    """Compare a measured salinity against what the label claims."""
    measured = salinity.sodium_mg(salinity_g_l, serving_ml)
    label = CLAIM_LABEL.get(claim, "No claim")
    limit = CLAIM_MAX_SODIUM_MG_PER_SERVING.get(claim)

    # "Reduced sodium" is relative to a reference product we do not have, so
    # there is no absolute threshold to test it against. Say so rather than
    # inventing one.
    if limit is None:
        return LabelCheck(
            claim=claim,
            claim_label=label,
            claim_max_mg=None,
            measured_mg_per_serving=measured,
            ratio=None,
            flagged=False,
            severity="none",
            headline=f"{measured:.0f} mg per {serving_ml:.0f} mL serving",
            detail="No absolute claim to check this against."
            if claim == "reduced_sodium"
            else "Measured as NaCl-equivalent salinity.",
        )

    ratio = measured / limit if limit > 0 else float("inf")

    if ratio < 1.0:
        return LabelCheck(
            claim=claim,
            claim_label=label,
            claim_max_mg=limit,
            measured_mg_per_serving=measured,
            ratio=ratio,
            flagged=False,
            severity="none",
            headline=f"Consistent with the {label.lower()} claim",
            detail=f"{measured:.0f} mg measured against a {limit:.0f} mg limit "
                   f"per {serving_ml:.0f} mL serving.",
        )

    if ratio < FLAG_RATIO_THRESHOLD:
        return LabelCheck(
            claim=claim,
            claim_label=label,
            claim_max_mg=limit,
            measured_mg_per_serving=measured,
            ratio=ratio,
            flagged=False,
            severity="info",
            headline=f"Slightly above the {label.lower()} claim",
            detail=f"{measured:.0f} mg against a {limit:.0f} mg limit "
                   f"({ratio:.1f}×). Within what measurement error and serving-size "
                   f"assumptions could explain.",
        )

    # This is the interesting case.
    return LabelCheck(
        claim=claim,
        claim_label=label,
        claim_max_mg=limit,
        measured_mg_per_serving=measured,
        ratio=ratio,
        flagged=True,
        severity="warning",
        headline="Possible potassium-based salt substitute",
        detail=f"Measures {ratio:.0f}× the {label.lower()} limit "
               f"({measured:.0f} mg against {limit:.0f} mg per "
               f"{serving_ml:.0f} mL). Conductivity reads all ions, so a "
               f"low-sodium product with this much ionic content is most likely "
               f"using potassium chloride. That matters for kidney patients and "
               f"anyone on ACE inhibitors, ARBs or potassium-sparing diuretics. "
               f"Check the ingredients and ask a clinician — this is a flag, "
               f"not a diagnosis.",
    )
