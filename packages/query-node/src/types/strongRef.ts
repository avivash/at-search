/**
 * Canonical strong reference for versioned AT Proto records (search hits, pointers).
 * Re-exported from shared package so query-node code imports a single local types entry.
 */
export type { StrongRef } from '@atsearch/common'
export { parseAtUri, buildAtUri } from '@atsearch/common'
