import { describe, it, expect } from "vitest"
import { MASKED_SECRET, secretMaskSet, secretsToEnv } from "./secrets.js"

describe("secretsToEnv", () => {
  it("maps secrets to an env object", () => {
    expect(secretsToEnv({ API_KEY: "x", TOKEN: "y" })).toEqual({ API_KEY: "x", TOKEN: "y" })
  })

  it("returns an empty object when given nothing", () => {
    expect(secretsToEnv()).toEqual({})
  })
})

describe("secretMaskSet", () => {
  it("masks the starting secrets, and a value added later from then on", () => {
    const secrets = secretMaskSet({ API_TOKEN: "tok_start_123", REGION: "eu" })
    expect(secrets.mask("a tok_start_123 b eu")).toBe(`a ${MASKED_SECRET} b eu`)
    expect(secrets.mask("rotated tok_later_456")).toBe("rotated tok_later_456")

    secrets.add("tok_later_456")
    secrets.add("tiny")
    expect(secrets.mask("rotated tok_later_456 tiny")).toBe(`rotated ${MASKED_SECRET} tiny`)
  })

  it("masks a value containing another whole, and its JSON-escaped form", () => {
    const secrets = secretMaskSet()
    secrets.add("abcdef")
    secrets.add('Bearer abcdef"x')
    expect(secrets.mask('Bearer abcdef"x')).toBe(MASKED_SECRET)
    expect(secrets.mask(JSON.stringify('Bearer abcdef"x'))).toBe(`"${MASKED_SECRET}"`)
  })
})
