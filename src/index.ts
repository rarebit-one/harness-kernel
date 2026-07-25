// The kernel's public API. Anything not re-exported here is internal and may
// change without notice — adding an export is a compatibility commitment, so do
// it deliberately.

// ---------------------------------------------------------------------------
// Shared shapes callers hand in
// ---------------------------------------------------------------------------
export type {
  ConnectorConfig,
  Permissions,
  WorkflowDefinition,
  KnowledgeEntry,
  IssueEntry,
} from "./types.js"

// ---------------------------------------------------------------------------
// Providers — the model adapters and their selection
// ---------------------------------------------------------------------------
export { selectProvider } from "./providers/index.js"
export type { ProviderSelection } from "./providers/index.js"
export type {
  Provider,
  CompletionRequest,
  ConverseRequest,
  ConverseResult,
  AgentMessage,
  ToolSpec,
  ToolCall,
  ToolResult,
} from "./providers/types.js"
export { AnthropicProvider } from "./providers/anthropic.js"
export { OpenAIProvider, OpenAICompatibleProvider } from "./providers/openai.js"
export type { OpenAICompatibleOptions } from "./providers/openai.js"
export { OpenRouterProvider } from "./providers/openrouter.js"
export { MockProvider } from "./providers/mock.js"

// ---------------------------------------------------------------------------
// The tool-use loop
// ---------------------------------------------------------------------------
export { runAgent, maxToolResultBytes } from "./agent.js"
export type { RunAgentOptions } from "./agent.js"

// ---------------------------------------------------------------------------
// Tools — generic primitives, injectable domain emissions, MCP connectors
// ---------------------------------------------------------------------------
export { primitiveTools, emissionTools, connectorTools } from "./tools/registry.js"
export type { Tool, EmissionSinks } from "./tools/registry.js"

// ---------------------------------------------------------------------------
// Sandbox primitives (the executors the tools are built on)
// ---------------------------------------------------------------------------
export { runCode } from "./primitives/codeExec.js"
export type { RunCodeOptions, RunCodeResult } from "./primitives/codeExec.js"
export { readFileSafe, listFiles } from "./primitives/fs.js"
export { httpFetch } from "./primitives/http.js"
export type { HttpFetchOptions, HttpResponse } from "./primitives/http.js"
export { downloadToFile } from "./primitives/download.js"
export type { DownloadOptions } from "./primitives/download.js"

// ---------------------------------------------------------------------------
// MCP connectors
// ---------------------------------------------------------------------------
export { connectMcp } from "./connectors/mcpClient.js"
export type { McpConnection } from "./connectors/mcpClient.js"

// ---------------------------------------------------------------------------
// Engines — the pluggable-harness seam
// ---------------------------------------------------------------------------
export { selectEngine } from "./engines/index.js"
export type {
  AgentEngine,
  EngineContext,
  EngineResult,
  EngineSupport,
  RunSpec,
} from "./engines/types.js"
export { NativeEngine } from "./engines/native.js"
export type { NativeEngineOptions, DomainToolFactory } from "./engines/native.js"
export { ClaudeCodeEngine } from "./engines/claudeCode.js"
export type { ClaudeCodeOptions, ClaudeCodeDriver } from "./engines/claudeCode.js"
export { CodexEngine } from "./engines/codex.js"
export type { CodexOptions, CodexDriver } from "./engines/codex.js"

// The capability surface every engine shares (open_issue / write_file /
// promote_knowledge), plus the emissions file an out-of-process engine reads back.
export { capabilityTools, CAPABILITY_TOOL_NAMES } from "./engines/capability.js"
export type { CapabilityContext, CapabilityResult, CapabilityTool } from "./engines/capability.js"
export { emptyEmissions, readEmissions, writeEmissions } from "./engines/capabilityEmissions.js"
export type { Emissions } from "./engines/capabilityEmissions.js"

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
export { secretsToEnv } from "./secrets.js"
