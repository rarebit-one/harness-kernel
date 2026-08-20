import { readFile, writeFile } from "node:fs/promises"

/**
 * The out-of-process emissions file.
 *
 * An external-process engine (codex / a CLI) cannot share memory with the run
 * that spawned it, so the runner-hosted stdio capability server persists what
 * the run emitted to a JSON file OUTSIDE the sandbox tree — where the change
 * set will not capture it — and the engine reads it back afterwards. That round
 * trip is the whole mechanism, and it is generic.
 *
 * What it carries is **not** the kernel's business. This module moves an opaque
 * JSON value; it does not know or check its shape. It previously declared an
 * `Emissions { issues, knowledge }` interface, which put one application's run
 * protocol inside the kernel — `write_file` changes are still excluded on
 * purpose, because those DO belong in the tree and travel via the change set.
 */

/** Persist the current emissions (the stdio server rewrites the full state per call). */
export async function writeEmissions(file: string, emissions: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(emissions))
}

/**
 * Read back what the capability server persisted.
 *
 * Returns `undefined` for an absent or malformed file rather than an empty
 * object: "nothing was written" and "something was written and it was empty"
 * are different facts, and a defaulted `{}` would erase the difference. The
 * caller casts to whatever its own capability surface agreed to write.
 */
export async function readEmissions(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}
