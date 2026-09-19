// Mirrors docs/telemetry-schema.md. Keep in sync with backend/app/schema.py.
//
// camelCase fields are NaTrack's (docs/natrack-system-design.pdf); snake_case
// fields are extensions NaTrack does not cover. The casing is deliberate: it
// says whose field it is. Do not normalise it.

export const SAMPLE_SCHEMA = 'sample/v2';
export const BITE_SCHEMA = 'bite/v2';

export const QUALITY_THRESHOLD = 0.6;

/** DFR0300 probe limits. See docs/measurement-protocol.md. */
export const PROBE_TEMP_MIN_C = 0;
export const PROBE_TEMP_MAX_C = 40;
export const PROBE_EC_RECOMMENDED_MAX = 15;

export type Motion = 'still' | 'stirring' | 'moving' | 'unknown';
export type DetectorState = 'IDLE' | 'WETTING' | 'CAPTURE' | 'CONFIRM' | 'LOG' | 'ABORT';
export type Pace = 'green' | 'yellow' | 'red' | 'unknown';

export interface IMU {
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
}

export interface Sample {
  schema: string;
  deviceId: string;
  seq: number;
  uptime_ms: number;
  tempC: number | null;
  temp_in_range: boolean;
  /** Conductivity at 25 °C, mS/cm. An index of salinity, not salinity. */
  salinityIndex: number;
  salinity_g_l: number;
  imu: IMU;
  motion: Motion;
  submerged: boolean;
  state: DetectorState;
  quality: number;
}

/** NaTrack's BiteEvent. */
export interface Bite {
  schema: string;
  deviceId: string;
  bite_id: number;
  /** ISO-8601 UTC, milliseconds. */
  timestamp: string;
  /** Conductivity at 25 °C, mS/cm. */
  salinityIndex: number;
  tempC: number;
  salinity_g_l: number;
  salinity_source: 'measured' | 'bowl_reference';
  dilution_factor: number;
  /** Grams eaten. Weighed by a load-cell spoon, otherwise calibrated volume
   *  at 1 g/mL - volume_source says which. */
  weightGrams: number;
  volume_source: 'load_cell' | 'user_calibrated' | 'default';
  /** mg, computed on the device. */
  sodiumEstimate: number;
  sodium_mg_low: number;
  sodium_mg_high: number;
  quality: number;
  ec_sample_count: number;
  biteIntervalSec: number | null;
  pace: Pace;
  /** 'fast' | 'moving' | 'tempUnsettled'. Unknown values are ignored. */
  flags: string[];
  fw_version: string;
  /** Added by the backend; a spoon does not know who holds it. */
  patientId?: string;
  mealId?: number;
}

/** The totals half of NaTrack's MealSummary, as pushed with each live bite. */
export interface MealTotals {
  biteCount: number;
  /** mg. */
  totalSodium: number;
  total_sodium_mg_low: number;
  total_sodium_mg_high: number;
  total_weight_g: number;
  /** Excludes the meal's first bite, whose interval spans the previous meal. */
  avgBiteIntervalSec: number | null;
  minBiteIntervalSec: number | null;
  /** More than half the bites were flagged 'fast' by the device. */
  paceFlag: boolean;
}

/** NaTrack's MealSummary. */
export interface Meal extends MealTotals {
  mealId: number;
  patientId: string;
  deviceId: string;
  start: string;
  end: string | null;
  product_name: string | null;
  label_claim: string;
}

/** A meal as the clinician view receives it: checked against its own label. */
export interface MealWithLabel extends Meal {
  label_claim_label: string | null;
  label_flagged: boolean;
  label_headline: string | null;
}

export interface Patient {
  patientId: string;
  name: string;
  age: number | null;
  condition: string | null;
  /** mg/day, set by the care team. Every "limit" the patient sees is this. */
  sodiumTarget: number;
  clinicianId: string;
  enrolled_at: string;
}

export interface DailyTotal {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  measured_sodium_mg: number;
  manual_sodium_mg: number;
  total_sodium_mg: number;
  bite_count: number;
  manual_count: number;
  /** False means nothing was logged - which is not the same as zero intake. */
  logged: boolean;
}

/** Mirrors backend/app/cohort.py. */
export interface PatientSummary extends Patient {
  today: DailyTotal;
  pct_of_target_today: number;
  /** Full days before today that the averages run over. */
  window_days: number;
  /** Mean over LOGGED days in the window. Null if none were logged. */
  avg_sodium_mg: number | null;
  pct_of_target_avg: number | null;
  days_logged: number;
  days_over_target: number;
  days_since_log: number | null;
  /** This window's mean against the previous window's, %. Null if either
   *  window has too few logged days to compare. */
  drift_pct: number | null;
  upward_drift: boolean;
  /** Meals in the window whose measurement contradicts their label claim. */
  flagged_meals: number;
  /** Pace over the window's meals, weighted by bites. */
  avgBiteIntervalSec: number | null;
  minBiteIntervalSec: number | null;
  pace_flagged_meals: number;
  last_activity_at: string | null;
  in_meal: boolean;
  /** Oldest first, today last. */
  daily: DailyTotal[];
}

export type SummaryRange = 'day' | 'week' | 'month';

/** NaTrack's HealthLog: what the patient records about themselves. */
export interface HealthLog {
  id: number;
  patientId: string;
  timestamp: string;
  systolic: number | null;
  diastolic: number | null;
  weightKg: number | null;
  note: string | null;
}

export interface PatientDetail extends PatientSummary {
  range: SummaryRange;
  meals: MealWithLabel[];
  manual_meals: ManualMeal[];
}

export interface LabelCheck {
  product_name: string | null;
  claim: string;
  claim_label: string;
  claim_max_mg: number | null;
  measured_mg_per_serving: number;
  ratio: number | null;
  flagged: boolean;
  severity: 'none' | 'info' | 'warning';
  headline: string;
  detail: string;
}

export interface LabelClaimOption {
  value: string;
  label: string;
  max_sodium_mg_per_serving: number | null;
}

/** Self-reported food. Not a NaTrack entity, so its fields keep their names;
 *  patientId is NaTrack's everywhere. */
export interface ManualMeal {
  id: number;
  patientId: string;
  ts_utc: string;
  name: string;
  portion: string | null;
  sodium_mg: number;
  source: string;
}

export interface IntakeToday {
  /** Measured by the spoon. */
  measured_sodium_mg: number;
  /** Self-reported solids the probe cannot read. Never conflated with measured. */
  manual_sodium_mg: number;
  total_sodium_mg: number;
  bite_count: number;
  manual_count: number;
  meal_count: number;
  patientId: string;
  /** The patient's own target. The FDA and AHA figures are context, not the goal. */
  sodiumTarget: number;
  pct_of_target: number;
  fda_daily_limit_mg: number;
  aha_ideal_limit_mg: number;
  pct_of_fda_limit: number;
  pct_of_aha_ideal: number;
  verdict: 'low' | 'moderate' | 'high' | 'very high';
}

export type LiveMessage =
  // holder: this patient has the spoon. busy: someone else is mid-meal with it
  // (anonymous on purpose). mealId: this patient's open meal, for backfill.
  | { type: 'spoon'; holder: boolean; busy: boolean; mealId: number | null }
  | { type: 'sample'; received_at: string; mealId: number | null;
      patientId: string; data: Sample }
  | { type: 'bite'; received_at: string; mealId: number; patientId: string;
      data: Bite; meal_totals: MealTotals; label_check?: LabelCheck }
  | { type: 'meal_started'; mealId: number; patientId: string }
  | { type: 'meal_ended'; mealId: number; patientId: string }
  | { type: 'error'; detail: string };

/** A sample with the server's wall-clock stamp, ready to chart. */
export interface ChartPoint {
  t: number;
  salinityIndex: number;
  salinity_g_l: number;
  salt_pct: number;
  tempC: number | null;
  temp_in_range: boolean;
  quality: number;
  submerged: boolean;
  state: DetectorState;
  /** Null when the probe is in air — there is no measurement to plot. */
  measured_salt_pct: number | null;
  /** Null unless this sample would count toward a bite. */
  trusted_salt_pct: number | null;
}
