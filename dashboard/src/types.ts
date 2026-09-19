// Mirrors docs/telemetry-schema.md. Keep in sync with backend/app/schema.py.

export const SAMPLE_SCHEMA = 'sample/v1';
export const BITE_SCHEMA = 'bite/v1';

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
  device_id: string;
  seq: number;
  uptime_ms: number;
  temp_c: number | null;
  temp_in_range: boolean;
  ec25_ms_cm: number;
  salinity_g_l: number;
  imu: IMU;
  motion: Motion;
  submerged: boolean;
  state: DetectorState;
  quality: number;
}

export interface Bite {
  schema: string;
  device_id: string;
  bite_id: number;
  ts_utc: string;
  ec25_ms_cm: number;
  temp_c: number;
  salinity_g_l: number;
  salinity_source: 'measured' | 'bowl_reference';
  dilution_factor: number;
  volume_ml: number;
  volume_source: 'user_calibrated' | 'default';
  sodium_mg: number;
  sodium_mg_low: number;
  sodium_mg_high: number;
  quality: number;
  ec_sample_count: number;
  seconds_since_prev_bite: number | null;
  pace: Pace;
  fw_version: string;
}

export interface MealTotals {
  bite_count: number;
  total_sodium_mg: number;
  total_sodium_mg_low: number;
  total_sodium_mg_high: number;
  total_volume_ml: number;
}

export interface Meal extends MealTotals {
  id: number;
  patient_id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface IntakeToday {
  total_sodium_mg: number;
  bite_count: number;
  meal_count: number;
  fda_daily_limit_mg: number;
  aha_ideal_limit_mg: number;
  pct_of_fda_limit: number;
  pct_of_aha_ideal: number;
  verdict: 'low' | 'moderate' | 'high' | 'very high';
}

export type LiveMessage =
  | { type: 'sample'; received_at: string; meal_id: number | null; data: Sample }
  | { type: 'bite'; received_at: string; meal_id: number; data: Bite; meal_totals: MealTotals }
  | { type: 'meal_started'; meal_id: number }
  | { type: 'meal_ended'; meal_id: number }
  | { type: 'error'; detail: string };

/** A sample with the server's wall-clock stamp, ready to chart. */
export interface ChartPoint {
  t: number;
  ec25_ms_cm: number;
  salinity_g_l: number;
  salt_pct: number;
  temp_c: number | null;
  temp_in_range: boolean;
  quality: number;
  submerged: boolean;
  state: DetectorState;
  /** Null when the probe is in air — there is no measurement to plot. */
  measured_salt_pct: number | null;
  /** Null unless this sample would count toward a bite. */
  trusted_salt_pct: number | null;
}
