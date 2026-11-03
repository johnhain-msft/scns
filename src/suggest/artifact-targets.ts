/**
 * ARTIFACT TARGETS — the one place that answers "where does an approved suggestion land?".
 *
 * WHY THIS MODULE EXISTS (defect, 2026-08-05). `proposal-spec.ts` opened with the claim that
 * location facts "come from one shared location map, so the scan that looks for existing artifacts
 * and the sentence that tells John where this one would land can never disagree." That guarantee
 * covered the SCAN and the SENTENCE — it never covered the EXECUTOR, which was wired to its own
 * private constant. So the two drifted, and nothing could catch it:
 *
 *   - the sentence John reviewed said  `<repo>/.github/instructions`   (proposal-spec.ts)
 *   - the executor actually wrote      `~/.github/copilot-instructions.md`  (executor.ts)
 *
 * Both modules had passing tests, because each was tested against its OWN constant. An invariant
 * that lives only in a doc comment is not an invariant. It is now expressed here, in code, and
 * `test/unit/suggest/artifact-target-truthfulness.test.ts` fails if the sentence and the write
 * ever diverge again.
 *
 * SECOND DEFECT FIXED HERE: `~/.github/copilot-instructions.md` is not a file Copilot CLI reads
 * as user-level guidance. The locations it honours are `.github/copilot-instructions.md` *relative
 * to a git root or cwd*, and — for user scope — `$HOME/.copilot/copilot-instructions.md` plus
 * `$HOME/.copilot/instructions/`. Writing user-scope guidance to `$HOME/.github/…` only ever took
 * effect when the session happened to be started from `$HOME`. User-scope artifacts therefore live
 * under `$HOME/.copilot/`, which is also where `mcp-config.json` and `lsp-config.json` live.
 *
 * SCOPE NOTE: this module is DESCRIPTIVE — it says where things go. `resolveGates` in
 * `executor.ts` stays PRESCRIPTIVE security policy — it says where writing is *permitted*. They
 * remain separate on purpose: wiring human-facing text into a safety gate would let a wording
 * change widen what is writable. The gates are expected to *contain* these paths, not to be
 * derived from them.
 */
import { join } from 'node:path'

/** Copilot CLI's user-scope config directory, relative to the user's home. */
export const COPILOT_CONFIG_DIR = '.copilot'

/**
 * User-scope custom instructions. Copilot CLI loads this file for every session regardless of
 * cwd — unlike `$HOME/.github/copilot-instructions.md`, which it only loads when the session's
 * git root or cwd IS `$HOME`.
 */
export const SUGGESTED_INSTRUCTIONS_REL = join(COPILOT_CONFIG_DIR, 'copilot-instructions.md')

/** Copilot CLI's user-scope language-server registry, read by `/lsp` and by code intelligence. */
export const LSP_CONFIG_REL = join(COPILOT_CONFIG_DIR, 'lsp-config.json')

/** Absolute path of the user-scope instructions file, given the executor's config base dir. */
export function suggestedInstructionsPath(configBaseDir: string): string {
  return join(configBaseDir, SUGGESTED_INSTRUCTIONS_REL)
}

/** Absolute path of the user-scope LSP registry, given the executor's config base dir. */
export function lspConfigPath(configBaseDir: string): string {
  return join(configBaseDir, LSP_CONFIG_REL)
}
