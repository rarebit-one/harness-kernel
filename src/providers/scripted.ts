import type {
  CompletionRequest,
  ConverseOptions,
  ConverseRequest,
  ConverseResult,
  Provider,
} from "./types.js"

/**
 * One scripted model turn: a fixed result, or a function of the request it
 * answers (and its zero-based index in the script) for a script that needs to
 * inspect what the loop sent before deciding.
 */
export type ScriptedTurn =
  | ConverseResult
  | ((req: ConverseRequest, index: number) => ConverseResult | Promise<ConverseResult>)

export interface ScriptedProviderOptions {
  /** Reported as `Provider.name`; shows up as the run's `provider`. Default `"scripted"`. */
  name?: string
  /** Reported as `Provider.model` and stamped on every result that names none. */
  model?: string
  /** Declare usage reporting when the script's turns carry `usage`. Default `false`. */
  reportsUsage?: boolean
}

/** Thrown when the loop asks for a turn the script does not have. */
export class ScriptExhaustedError extends Error {
  readonly played: number

  constructor(played: number) {
    super(
      `scripted provider exhausted: ${played} turn(s) played and the loop asked for another — ` +
        "the script is shorter than the conversation it was recorded against",
    )
    this.name = "ScriptExhaustedError"
    this.played = played
  }
}

/**
 * A deterministic provider that plays back a recorded script of model turns.
 *
 * It exists for evals and tests that need the whole loop to run — tools
 * executed, results fed back, terminal tools honoured — without a model or a
 * network, and with every request the loop built available afterwards for
 * assertions. It fails loud in both directions: a script that runs out throws
 * rather than inventing a turn, and `remaining` lets a test assert that every
 * recorded turn was consumed.
 *
 * It honours `signal` the way a real adapter does, so cancellation tests can
 * run against it too.
 */
export class ScriptedProvider implements Provider {
  readonly name: string
  readonly model?: string
  readonly reportsUsage: boolean
  /** Every request received, in order, as detached copies. */
  readonly requests: ConverseRequest[] = []

  private readonly script: readonly ScriptedTurn[]
  private played = 0

  constructor(script: readonly ScriptedTurn[], options: ScriptedProviderOptions = {}) {
    this.script = script
    this.name = options.name ?? "scripted"
    if (options.model !== undefined) this.model = options.model
    this.reportsUsage = options.reportsUsage ?? false
  }

  /** Turns not yet played. Zero after a conversation consumed the whole script. */
  get remaining(): number {
    return this.script.length - this.played
  }

  async converse(req: ConverseRequest, opts?: ConverseOptions): Promise<ConverseResult> {
    opts?.signal?.throwIfAborted()
    const turn = this.script[this.played]
    if (turn === undefined) throw new ScriptExhaustedError(this.played)
    const index = this.played
    this.played += 1
    this.requests.push(detach(req))

    const result = typeof turn === "function" ? await turn(req, index) : turn
    opts?.signal?.throwIfAborted()
    // Return a deep copy: the loop hands a call's `input` to the tool, a tool
    // may mutate it, and a script that reuses one recorded result across turns
    // must play the same data every time or the eval is not deterministic.
    const copy = detachResult(result)
    return {
      ...copy,
      ...(copy.model === undefined && this.model !== undefined ? { model: this.model } : {}),
    }
  }

  /** Play the next turn as a one-shot completion and return its text. */
  async complete(req: CompletionRequest): Promise<string> {
    const result = await this.converse({
      system: req.system,
      messages: [{ role: "user", text: req.prompt }],
      tools: [],
    })
    return result.text
  }
}

/** A detached copy of a turn, whole; the shallow fallback covers a value `structuredClone` refuses. */
function detachResult(result: ConverseResult): ConverseResult {
  try {
    return structuredClone(result)
  } catch {
    return { ...result, toolCalls: result.toolCalls.map((c) => ({ ...c, input: { ...c.input } })) }
  }
}

/** A detached copy of a request, so later mutation by the loop cannot rewrite history. */
function detach(req: ConverseRequest): ConverseRequest {
  try {
    return structuredClone(req)
  } catch {
    return { ...req, messages: [...req.messages], tools: [...req.tools] }
  }
}
