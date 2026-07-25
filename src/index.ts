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
export type { OpenRouterAttribution } from "./providers/openrouter.js"
export { MockProvider } from "./providers/mock.js"

// ---------------------------------------------------------------------------
// The model seam — the neutral arrow every model kind is invoked through
// ---------------------------------------------------------------------------
export {
  emitCompleteToolCall,
  invokeStreaming,
  modelIdentity,
  requireCapability,
  CapabilityError,
} from "./models/types.js"
export type {
  ModelInvocation,
  ModelKind,
  ModelCaps,
  ModelIdentity,
  ModelResult,
  InvokeContext,
  StreamSink,
  Usage,
  TokenUsage,
  UnitUsage,
  Health,
  HealthStatus,
} from "./models/types.js"

// The chat kind, and the adapter that puts an existing Provider on the seam.
export { chatModel, asChatModel, isChatModel, chatRequest, CHAT_KIND } from "./models/chat.js"
export type { ChatModel, ChatRequest, ChatResponse, ChatPart, BinaryRef } from "./models/chat.js"

// Extension point 1 — bind kind+id to a concrete invocation.
export { ModelRegistry, UnknownModelError } from "./models/registry.js"
export type { ModelRef, ModelFactory, ModelSupport } from "./models/registry.js"

// Extension point 3 — cross-cutting concerns over every kind, uniformly.
export {
  withMiddleware,
  correlationMiddleware,
  loggingMiddleware,
  healthTrackingMiddleware,
  errorRedactionMiddleware,
  HealthTracker,
} from "./models/middleware.js"
export type { Middleware, Invoker, StreamInvoker } from "./models/middleware.js"

// ---------------------------------------------------------------------------
// Extension point 2 — route resolution (capability → model + prompt + tools)
// ---------------------------------------------------------------------------
export { StaticRouteResolver } from "./routing/staticResolver.js"
export { UnknownCapabilityError } from "./routing/types.js"
export type {
  RouteResolver,
  RouteContext,
  RouteLimits,
  CapabilityDefinition,
  ResolvedRoute,
} from "./routing/types.js"

// ---------------------------------------------------------------------------
// Extension point 5 — pluggable context assembly
// ---------------------------------------------------------------------------
export { assembleContext, renderContext } from "./context/types.js"
export type { ContextProvider, ContextFragment, ContextSpec } from "./context/types.js"

// ---------------------------------------------------------------------------
// The tool-use loop
// ---------------------------------------------------------------------------
export { runAgent, maxToolResultBytes } from "./agent.js"
export type { RunAgentOptions } from "./agent.js"

// ---------------------------------------------------------------------------
// Extension point 6 — tools: generic primitives, injectable domain emissions,
// MCP connectors, rich metadata + projections, and models-as-tools
// ---------------------------------------------------------------------------
export { primitiveTools, emissionTools, connectorTools, executeTool } from "./tools/registry.js"
export type { Tool, ToolOutput, EmissionSinks } from "./tools/registry.js"
export {
  selectTools,
  isToolVisible,
  toToolSpecs,
  toolsRequiringConfirmation,
  undoToolFor,
} from "./tools/metadata.js"
export type {
  ToolMetadata,
  ToolSelection,
  InvocationMode,
  ResultRetention,
  ClientResultVisibility,
} from "./tools/metadata.js"
export { modelAsTool } from "./tools/modelTool.js"
export type { ModelToolOptions } from "./tools/modelTool.js"

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
export { connectMcp, MCP_CLIENT_NAME } from "./connectors/mcpClient.js"
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
