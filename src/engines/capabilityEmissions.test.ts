import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { emptyEmissions, readEmissions, writeEmissions } from "./capabilityEmissions.js"

describe("capabilityEmissions", () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "emit-test-"))
    file = path.join(dir, "emissions.json")
  })
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("round-trips issues and knowledge", async () => {
    const e = {
      issues: [{ title: "look", dedupe_key: "k" }],
      knowledge: [{ content: "learned" }],
    }
    await writeEmissions(file, e)
    expect(await readEmissions(file)).toEqual(e)
  })

  it("returns empty when the file is absent", async () => {
    expect(await readEmissions(path.join(dir, "missing.json"))).toEqual(emptyEmissions())
  })

  it("returns empty when the file is malformed", async () => {
    await writeFile(file, "{ not json")
    expect(await readEmissions(file)).toEqual(emptyEmissions())
  })

  it("tolerates partial content (missing arrays default to empty)", async () => {
    await writeFile(file, JSON.stringify({ issues: [{ title: "x" }] }))
    expect(await readEmissions(file)).toEqual({ issues: [{ title: "x" }], knowledge: [] })
  })
})
