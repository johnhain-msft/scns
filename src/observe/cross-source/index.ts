/**
 * Cross-Source Pattern Detection — barrel export.
 */

export {
  createCrossSourceCorrelator,
  type CrossSourceEvent,
  type CrossSourcePattern,
} from './correlator.js'

export { generateCrossToolDigest, type CrossToolDigest } from './digest.js'
