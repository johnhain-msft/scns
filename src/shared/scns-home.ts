import { homedir } from 'node:os'

/**
 * Resolve the base home directory for SCNS data (`~/.scns/...`).
 *
 * Honors the `SCNS_HOME` environment variable so the entire SCNS data tree
 * (vault.db, experience.db, dream.db, telemetry, state, secrets, …) can be
 * relocated WITHOUT changing the process `HOME`. This decouples SCNS data
 * isolation from `HOME`, which is important because spawned Copilot ACP agents
 * resolve their auth from the real `HOME`/keychain: a dev/test broker can run
 * under the real `HOME` (so workers authenticate) while pointing its data at an
 * isolated `SCNS_HOME` (so the live `~/.scns` vault is never touched).
 *
 * Callers should keep composing with `.scns`, e.g. `join(resolveScnsHome(), '.scns')`.
 * Returns `os.homedir()` when `SCNS_HOME` is unset/empty (unchanged behavior).
 */
export function resolveScnsHome(): string {
  const override = process.env['SCNS_HOME']
  return override && override.trim() !== '' ? override : homedir()
}
