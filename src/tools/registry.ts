import { runCode } from "../primitives/codeExec.js"
import { httpFetch } from "../primitives/http.js"
import { readFileSafe, listFiles } from "../primitives/fs.js"
import { connectMcp, type McpConnection } from "../connectors/mcpClient.js"
import type { ConnectorConfig } from "../types.js"
import type { ToolSpec } from "../providers/types.js"
import type { ToolMetadata } from "./metadata.js"

/**
 * What a tool produced: the string the model sees, plus the typed payload that
 * string was projected from.
 *
 * The model can only consume text, so `content` is what goes back into the
 * conversation. But a caller that JSON-stringifies a struct on the way out and
 * re-parses it on the way in has lost the type for no reason — so `structured`
 * carries the original alongside, untouched.
 */
export interface ToolOutput {
  /** The string projection fed back to the model. */
  content: string
  /** The typed payload, preserved for callers and clients. */
  structured?: unknown
}

/** A tool the agent can call: its public spec plus a server-side executor. */
export interface Tool {
  spec: ToolSpec
  /** Optional descriptive metadata — scoping, confirmation, undo, retention. */
  meta?: ToolMetadata
  /**
   * Execute and return the model-facing string. This is the required contract
   * every tool implements, and the only one the loop needs.
   */
  execute(input: Record<string, unknown>): Promise<string>
  /**
   * Optional richer executor. When present the loop calls this instead and
   * keeps the typed payload alongside the string; when absent nothing changes.
   *
   * Two methods rather than one widened return type is a deliberate
   * concession to compatibility: every existing tool and every existing caller
   * types `execute` as returning a plain `string`, and widening it to a union
   * would break them at the type level for a payload most tools never produce.
   */
  executeStructured?(input: Record<string, unknown>): Promise<ToolOutput>
}

/** Run a tool through its richest available executor. */
export async function executeTool(tool: Tool, input: Record<string, unknown>): Promise<ToolOutput> {
  if (tool.executeStructured) return tool.executeStructured(input)
  return { content: await tool.execute(input) }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/** Keep only string-valued headers (the model may pass arbitrary JSON). */
function stringHeaders(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value
  }
  return out
}

/**
 * General-purpose primitives, scoped to the run sandbox. `env` carries the
 * resolved secrets (see secretsToEnv) into executed code. Domain logic is the
 * user's own repo code, invoked through `run_code` — never baked in here.
 *
 * This set is strictly generic: sandboxed shell, file reads, and HTTP. Tools
 * that collect an application's *domain output* are not here at all — they are
 * the application's vocabulary, injected through the engines' domain-tool seam.
 *
 * When `allowed` is provided it acts as an allowlist of primitive tool names
 * (from the workflow's `permissions.tools`).
 */
export function primitiveTools(
  sandboxDir: string,
  env: NodeJS.ProcessEnv,
  allowed?: string[],
  allowHosts?: string[],
): Tool[] {
  const all: Tool[] = [
    {
      spec: {
        name: "run_code",
        description:
          "Run a shell command in the workspace sandbox — e.g. `node scan.mjs`, `npm ci`, or a one-liner. " +
          "`command` is a shell command line run via `/bin/sh -c`, so pipes, quoting and redirection work and " +
          "`node`/`npm`/etc. resolve on PATH. (Advanced: pass `args` to exec `command` as a bare binary with " +
          "those arguments, bypassing the shell.) Returns stdout, stderr, and the exit code.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            stdin: { type: "string" },
          },
          required: ["command"],
        },
      },
      execute: async (input) => {
        const command = str(input.command)
        const args = strArray(input.args)
        const stdin = typeof input.stdin === "string" ? input.stdin : undefined
        // Default to running the command line through a shell (mirrors the verify
        // gate's `/bin/sh -c`), so an agent can hand us `node scan.mjs` as a single
        // string. When explicit args are given, exec the binary directly (no shell).
        const result =
          args.length > 0
            ? await runCode({ cwd: sandboxDir, command, args, env, stdin })
            : await runCode({
                cwd: sandboxDir,
                command: "/bin/sh",
                args: ["-c", command],
                env,
                stdin,
              })
        return JSON.stringify(result)
      },
    },
    {
      spec: {
        name: "read_file",
        description: "Read a UTF-8 file from the workspace sandbox.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      execute: async (input) => (await readFileSafe(sandboxDir, str(input.path))) ?? "(not found)",
    },
    {
      spec: {
        name: "list_files",
        description: "List files under a directory in the workspace sandbox.",
        inputSchema: {
          type: "object",
          properties: { dir: { type: "string" } },
        },
      },
      execute: async (input) => (await listFiles(sandboxDir, str(input.dir) || ".")).join("\n"),
    },
    {
      spec: {
        name: "http_fetch",
        description: "Make an HTTP request. Returns the status and response body.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            method: { type: "string" },
            headers: { type: "object" },
            body: { type: "string" },
          },
          required: ["url"],
        },
      },
      execute: async (input) => {
        const res = await httpFetch({
          url: str(input.url),
          method: str(input.method) || "GET",
          headers: stringHeaders(input.headers),
          body: typeof input.body === "string" ? input.body : undefined,
          allowHosts, // egress allowlist from the workflow's permissions (undefined = any public host)
        })
        return JSON.stringify({ status: res.status, body: res.body })
      },
    },
  ]

  return allowed ? all.filter((t) => allowed.includes(t.spec.name)) : all
}

/**
 * Tools exposed by the run's MCP connectors. Each connector's tools are
 * namespaced `<connector>__<tool>` to avoid collisions. Returns a `close` to
 * tear down the connections when the run ends.
 */
export async function connectorTools(
  connectors: ConnectorConfig[],
  connect: (config: ConnectorConfig) => Promise<McpConnection> = connectMcp,
): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
  const connections: McpConnection[] = []
  const tools: Tool[] = []
  const close = async (): Promise<void> => {
    await Promise.allSettled(connections.map((c) => c.close()))
  }

  try {
    for (const config of connectors) {
      if (config.kind !== "mcp") continue

      const conn = await connect(config)
      connections.push(conn)

      const listed = (await conn.listTools()) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
      }

      for (const tool of listed.tools ?? []) {
        tools.push({
          spec: {
            name: `${config.name}__${tool.name}`,
            description: tool.description ?? `${config.name} tool ${tool.name}`,
            inputSchema: tool.inputSchema ?? { type: "object" },
          },
          execute: async (input) => {
            const result = await conn.callTool(tool.name, input)
            return JSON.stringify(result)
          },
        })
      }
    }
  } catch (err) {
    // Don't leak connections opened before the failing one.
    await close()
    throw err
  }

  return { tools, close }
}
