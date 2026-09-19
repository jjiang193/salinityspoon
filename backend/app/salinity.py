"""EC → NaCl → sodium.

Mirror of firmware/spoon/salinity.h. The firmware reports derived values so the
spoon is useful over bare serial; the backend recomputes them so a recalibration
does not require reflashing. If you change the curve here, change it there.
"""

from dataclasses import dataclass

# g/L NaCl = A·ec25 + B·ec25²
# Defaults fitted to reference NaCl conductivity at 25 °C:
#   2.0 mS/cm → 1.0 g/L,  17.5 mS/cm → 10.0 g/L
# Replace with your own fit — see docs/calibration.md.
COEFF_A = 0.49078
COEFF_B = 0.004608

SODIUM_FRACTION_OF_NACL = 0.3934  # 1 g NaCl = 393.4 mg sodium

# --- Probe limits (DFR0300, K=1). See docs/measurement-protocol.md. ---
PROBE_TEMP_MAX_C = 40.0
PROBE_TEMP_MIN_C = 0.0
PROBE_EC_MAX_MS_CM = 20.0          # hard detection ceiling
PROBE_EC_RECOMMENDED_MAX = 15.0    # accuracy holds below this
PROBE_EC_FULL_SCALE_ERROR = 1.0    # ±5% F.S. of 20 mS/cm, absolute

# --- Daily sodium references, milligrams ---
FDA_DAILY_LIMIT_MG = 2300
AHA_IDEAL_LIMIT_MG = 1500

DEFAULT_VOLUME_ML = 10.0   # a soup spoon, until the user calibrates
DEFAULT_VOLUME_SD_ML = 2.5


def ec_to_g_per_litre(ec25_ms_cm: float) -> float:
    if ec25_ms_cm <= 0:
        return 0.0
    return COEFF_A * ec25_ms_cm + COEFF_B * ec25_ms_cm**2


def apply_dilution(g_per_litre: float, dilution_factor: float = 1.0) -> float:
    """Scale AFTER converting EC to concentration, never before.

    The EC↔concentration curve is quadratic, so scaling the input does not scale
    the output. For a true 10 g/L sample measured at 1:1, converting then scaling
    gives 10.0 g/L; scaling then converting gives 11.3 g/L — 13% high.
    """
    return g_per_litre * dilution_factor


def g_per_litre_to_salt_percent(g_l: float) -> float:
    return g_l / 10.0  # 10 g/L == 1% w/v


def sodium_mg(g_per_litre: float, volume_ml: float, food_matrix_factor: float = 1.0) -> float:
    return g_per_litre * SODIUM_FRACTION_OF_NACL * volume_ml * food_matrix_factor


def sodium_range_mg(
    g_per_litre: float, volume_ml: float, volume_sd_ml: float, food_matrix_factor: float = 1.0
) -> tuple[float, float, float]:
    """Point estimate plus bounds from the scoop volume's spread."""
    mid = sodium_mg(g_per_litre, volume_ml, food_matrix_factor)
    low = sodium_mg(g_per_litre, max(0.0, volume_ml - volume_sd_ml), food_matrix_factor)
    high = sodium_mg(g_per_litre, volume_ml + volume_sd_ml, food_matrix_factor)
    return low, mid, high


def temp_in_range(temp_c: float | None) -> bool:
    """The interlock. No salinity measurement is valid outside the probe's range."""
    if temp_c is None:
        return False
    return PROBE_TEMP_MIN_C <= temp_c <= PROBE_TEMP_MAX_C


def ec_relative_error(ec25_ms_cm: float) -> float:
    """Relative error from the ±5% F.S. spec — grows as the reading shrinks.

    14 mS/cm → ±7%.  10 → ±10%.  5 → ±20%.  2 → ±50%.
    This is why we measure high in the recommended band and do not dilute
    by default.
    """
    if ec25_ms_cm <= 0:
        return float("inf")
    return PROBE_EC_FULL_SCALE_ERROR / ec25_ms_cm


@dataclass
class SodiumContext:
    """What a number like '472 mg' actually means to a person."""

    sodium_mg: float
    pct_of_fda_limit: float
    pct_of_aha_ideal: float
    verdict: str


def contextualise(total_sodium_mg: float) -> SodiumContext:
    pct_fda = total_sodium_mg / FDA_DAILY_LIMIT_MG * 100.0
    pct_aha = total_sodium_mg / AHA_IDEAL_LIMIT_MG * 100.0

    # Fractions of the daily limit, not medical advice. Tune the wording, not
    # the physics.
    if pct_fda < 25:
        verdict = "low"
    elif pct_fda < 50:
        verdict = "moderate"
    elif pct_fda < 85:
        verdict = "high"
    else:
        verdict = "very high"

    return SodiumContext(total_sodium_mg, pct_fda, pct_aha, verdict)
