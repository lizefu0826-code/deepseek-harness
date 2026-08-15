/** Stable structured-review categories shared by reports and evaluation gold data. */
export const REVIEW_CATEGORIES = [
  'blocking-and-concurrency',
  'resources-and-lifecycle',
  'timeout-and-recovery',
  'boundaries-and-data-integrity',
  'performance-and-real-time',
  'state-consistency-and-compatibility',
  'security-and-safety',
  'observability-and-verification',
  'hdl-clock-reset-and-cdc',
  'hdl-width-and-sequential-semantics',
] as const

/** Stable category accepted by structured engineering-review findings. */
export type EngineeringFindingCategory = typeof REVIEW_CATEGORIES[number]
