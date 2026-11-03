/**
 * US5 (specs/001-learning-memory-loop) — outward actions, ALL routed through the single
 * safetyKernel.check chokepoint. The kernel core and the human-owned allowlist stay UNCHANGED.
 */
export {
  createAskHumanHandler,
  ASK_HUMAN_MAX_CHARS,
  type AskHumanHandler,
  type AskHumanInput,
  type AskHumanResult,
  type AskHumanDeps,
} from './ask-human.js'
export {
  createConsultSourceHandler,
  CONSULT_REASON_MAX_CHARS,
  type ConsultSourceHandler,
  type ConsultSourceInput,
  type ConsultSourceResult,
  type ConsultSourceDeps,
} from './consult-source.js'
