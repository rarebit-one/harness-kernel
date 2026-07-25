import { describe, it, expect } from "vitest"
import { secretsToEnv } from "./secrets.js"

describe("secretsToEnv", () => {
  it("maps secrets to an env object", () => {
    expect(secretsToEnv({ API_KEY: "x", TOKEN: "y" })).toEqual({ API_KEY: "x", TOKEN: "y" })
  })

  it("returns an empty object when given nothing", () => {
    expect(secretsToEnv()).toEqual({})
  })
})
