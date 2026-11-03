/**
 * Phase D — the offline reward-learner REPORT entrypoint (read-only; a thin CLI wrapper).
 *
 * The logic lives in `src/reward/reward-report-run.ts` so this entrypoint and the broker's scheduled
 * `reward-report` task run the SAME code instead of two drifting copies. The store is opened strictly
 * read-only there. This NEVER flips anything: a proposal in the output goes to the arm-frontier judged
 * gate, and any default change stays AWAITING-JOHN (AGENTS.md #9).
 *
 * USAGE:
 *   npx tsx scripts/reward-report.ts [path/to/experience.db]   # default: ~/.scns/memory/experience.db
 */
import { runRewardReport } from '../src/reward/reward-report-run.js'
import { humanOutcomePromotion } from './locomo-judge-lib.js'

const out = runRewardReport({
  ...(process.argv[2] ? { path: process.argv[2] } : {}),
  promotion: humanOutcomePromotion,
})
console.log(out.text)
