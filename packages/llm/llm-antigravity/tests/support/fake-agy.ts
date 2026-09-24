/**
 * Test-only helper that materializes `tests/fixtures/fake-agy.cjs` as a
 * directly spawnable executable: a fresh temp file per install, a
 * `#!/usr/bin/env node` shebang prepended, and mode 0o755 set at write time
 * — never a committed exec bit, which git does not reliably preserve.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_PATH = fileURLToPath(new URL('../fixtures/fake-agy.cjs', import.meta.url))

/** One installed fake-agy executable and its teardown. */
export interface FakeAgy {
  /** Absolute path to the generated, executable wrapper; use as `binaryPath`. */
  binaryPath: string
  /** Remove the temp directory holding the wrapper. */
  cleanup: () => Promise<void>
}

/**
 * Install a fresh fake-agy executable.
 * @returns the executable path and its cleanup.
 */
export async function installFakeAgy(): Promise<FakeAgy> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-agy-'))
  const binaryPath = join(dir, 'fake-agy')
  const source = await readFile(SOURCE_PATH, 'utf8')
  await writeFile(binaryPath, `#!/usr/bin/env node\n${source}`)
  await chmod(binaryPath, 0o755)
  return {
    binaryPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
