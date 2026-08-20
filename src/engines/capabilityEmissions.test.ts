import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readEmissions, writeEmissions } from "./capabilityEmissions.js"

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

  it("round-trips whatever the application wrote, unexamined", async () => {
    const e = {
      issues: [{ title: "look", dedupe_key: "k" }],
      knowledge: [{ content: "learned" }],
    }
    await writeEmissions(file, e)
    expect(await readEmissions(file)).toEqual(e)
  })

  it("round-trips a shape the kernel has never seen", async () => {
    // The point of the change: no interface here constrains what an application
    // may emit, so a completely different vocabulary survives the round trip.
    const e = { measurements: [{ celsius: 21.5 }], verdict: "nominal" }
    await writeEmissions(file, e)
    expect(await readEmissions(file)).toEqual(e)
  })

  it("returns undefined when the file is absent", async () => {
    // NOT an empty object: "nothing was written" and "something was written and
    // it was empty" are different facts, and defaulting would erase one.
    expect(await readEmissions(path.join(dir, "missing.json"))).toBeUndefined()
  })

  it("returns undefined when the file is malformed", async () => {
    await writeFile(file, "{ not json")
    expect(await readEmissions(file)).toBeUndefined()
  })

  it("distinguishes an empty emission from an absent one", async () => {
    await writeEmissions(file, {})
    expect(await readEmissions(file)).toEqual({})
    expect(await readEmissions(path.join(dir, "nope.json"))).toBeUndefined()
  })
})
