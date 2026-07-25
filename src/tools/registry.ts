import { runCode } from "../primitives/codeExec.js"
import { httpFetch } from "../primitives/http.js"
import { readFileSafe, listFiles } from "../primitives/fs.js"
import { connectMcp, type McpConnection } from "../connectors/mcpClient.js"
import type { ConnectorConfig, IssueEntry, KnowledgeEntry } from "../types.js"
import type { ToolSpec } from "../providers/types.js"

/** A tool the agent can call: its public spec plus a server-side executor. */
export interface Tool {
  spec: ToolSpec
  execute(input: Record<string, unknown>): Promise<string>
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
 * that collect an application's *domain output* are not here — see
 * {@link emissionTools}, which a caller composes in.
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

/** The sinks an emission tool appends to; the caller reads them after the run. */
export interface EmissionSinks {
  knowledge?: KnowledgeEntry[]
  issues?: IssueEntry[]
}

/**
 * The *domain-emission* tools: how a run hands durable knowledge and
 * human-actionable issues back to its caller. They are deliberately NOT part of
 * {@link primitiveTools} — a kernel primitive is generic (shell, files, HTTP),
 * whereas what an emission *means* (where knowledge is promoted to, what
 * "issue" denotes, what approval gate applies) is the application's concern.
 * So they are injected, not inherited: compose them alongside the primitives
 * when your application wants them.
 *
 * `allowed` applies the same permissions allowlist the primitives honour, so a
 * caller composing both sets gets uniform gating across the whole tool surface.
 */
export function emissionTools(sinks: EmissionSinks = {}, allowed?: string[]): Tool[] {
  const all: Tool[] = [
    {
      spec: {
        name: "promote_knowledge",
        description:
          "Record a durable piece of workspace knowledge/memory learned during this run " +
          "(a preference, decision, fact, or reusable summary). It is promoted into the " +
          "workspace after the run completes — held for human approval if the workflow " +
          "requires it. Use sparingly, for genuinely reusable knowledge, not transient output.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The knowledge to record (markdown)." },
            title: { type: "string", description: "Optional short title." },
            kind: {
              type: "string",
              description: "Optional kind, e.g. 'memory' (default) or 'decision'.",
            },
          },
          required: ["content"],
        },
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- execute() is async by tool contract; this tool resolves synchronously
      execute: async (input) => {
        const content = str(input.content)
        if (!content) return JSON.stringify({ ok: false, error: "content is required" })

        const entry: KnowledgeEntry = { content }
        if (str(input.title)) entry.title = str(input.title)
        if (str(input.kind)) entry.kind = str(input.kind)
        sinks.knowledge?.push(entry)
        return JSON.stringify({ ok: true })
      },
    },
    {
      spec: {
        name: "record_issue",
        description:
          "Open a workspace issue — the 'a human should look at this' surface (a decision " +
          "sheet, a finding, a chase item). It is filed after the run completes. Pass a stable " +
          "`dedupe_key` so a re-run UPDATES the same issue instead of opening a duplicate. Use " +
          "for durable, human-actionable items — not transient run output.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short issue title." },
            body: { type: "string", description: "Issue body (markdown)." },
            dedupe_key: {
              type: "string",
              description:
                "Stable key so re-runs upsert one rolling issue rather than duplicating.",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Optional labels.",
            },
          },
          required: ["title"],
        },
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- execute() is async by tool contract; this tool resolves synchronously
      execute: async (input) => {
        const title = str(input.title)
        if (!title) return JSON.stringify({ ok: false, error: "title is required" })

        const entry: IssueEntry = { title }
        if (str(input.body)) entry.body = str(input.body)
        if (str(input.dedupe_key)) entry.dedupe_key = str(input.dedupe_key)
        const labels = strArray(input.labels)
        if (labels.length > 0) entry.labels = labels
        sinks.issues?.push(entry)
        return JSON.stringify({ ok: true })
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
