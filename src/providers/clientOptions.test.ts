import { describe, it, expect, vi, afterEach } from "vitest"
import { maxTokens } from "./clientOptions.js"

describe("maxTokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("falls back to 4096 when RUNNER_MAX_TOKENS is unset", () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", undefined)
    expect(maxTokens()).toBe(4096)
  })

  it("uses a configured positive integer", () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "8192")
    expect(maxTokens()).toBe(8192)
  })

  it("floors a fractional value", () => {
    vi.stubEnv("RUNNER_MAX_TOKENS", "1024.9")
    expect(maxTokens()).toBe(1024)
  })

  it.each(["banana", "", "0", "-100", "NaN", "Infinity"])(
    "falls back to 4096 for invalid value %j",
    (raw) => {
      vi.stubEnv("RUNNER_MAX_TOKENS", raw)
      expect(maxTokens()).toBe(4096)
    },
  )
})
