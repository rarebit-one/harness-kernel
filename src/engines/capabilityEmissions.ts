import { readFile, writeFile } from "node:fs/promises"
import type { IssueEntry, KnowledgeEntry } from "../types.js"

/**
 * The issue/knowledge a run emitted through the capability surface. For the
 * in-process engines (native, Claude Code) these live in memory; for an
 * external-process engine (codex / a CLI) the runner-hosted stdio capability
 * server persists them to a JSON file OUTSIDE the sandbox tree — so they are NOT
 * captured by the change set — and the engine reads them back after the run.
 * write_file changes are excluded here on purpose: those DO belong in the tree
 * and travel via the change set.
 */
export interface Emissions {
  issues: IssueEntry[]
  knowledge: KnowledgeEntry[]
}

export function emptyEmissions(): Emissions {
  return { issues: [], knowledge: [] }
}

/** Persist the current emissions (the stdio server rewrites the full state per call). */
export async function writeEmissions(file: string, e: Emissions): Promise<void> {
  await writeFile(file, JSON.stringify(e))
}

/**
 * Read the emissions the capability server persisted, tolerating an absent or
 * malformed file (→ empty). The engine folds the result into its RunResult so
 * codex reaches emit parity with the native and Claude Code engines.
 */
export async function readEmissions(file: string): Promise<Emissions> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Emissions>
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      knowledge: Array.isArray(parsed.knowledge) ? parsed.knowledge : [],
    }
  } catch {
    return emptyEmissions()
  }
}
