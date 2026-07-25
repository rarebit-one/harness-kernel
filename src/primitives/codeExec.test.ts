import { describe, it, expect } from "vitest"
import { tmpdir } from "node:os"
import { runCode } from "./codeExec.js"

describe("runCode", () => {
  it("runs a command and captures stdout", async () => {
    const res = await runCode({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi')"],
    })
    expect(res.stdout).toBe("hi")
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
  })

  it("passes env (secrets) through to the child", async () => {
    const res = await runCode({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.SECRET ?? '')"],
      env: { SECRET: "s3cr3t" },
    })
    expect(res.stdout).toBe("s3cr3t")
  })

  it("forwards HOME so tooling (npm) gets a stable cache dir", async () => {
    const res = await runCode({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.HOME ?? 'unset')"],
    })
    expect(res.stdout).toBe(process.env.HOME ?? "unset")
  })

  it("does NOT forward the runner's other env (no secret/token leak)", async () => {
    process.env.CODEEXEC_LEAK_PROBE = "leaked"
    try {
      const res = await runCode({
        cwd: tmpdir(),
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.CODEEXEC_LEAK_PROBE ?? '')"],
      })
      expect(res.stdout).toBe("")
    } finally {
      delete process.env.CODEEXEC_LEAK_PROBE
    }
  })

  it("kills a process that exceeds the timeout", async () => {
    const res = await runCode({
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 200,
    })
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).toBeNull()
  })
})
