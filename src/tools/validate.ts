import type { Tool } from "./registry.js"

/**
 * One way a tool call's arguments fail the tool's declared `inputSchema`.
 * `path` is a JSON Pointer into the arguments (`/items/0/name`), or `""` for
 * the arguments object itself.
 */
export interface ToolInputProblem {
  path: string
  message: string
}

/**
 * Check a tool call's arguments against a JSON Schema, returning every problem
 * found (empty when the arguments fit).
 *
 * This is the subset of JSON Schema that tool schemas actually use: `type`
 * (including `integer`, `null` and type arrays), `properties`, `required`,
 * `additionalProperties`, `enum`, `const`, `items` / `prefixItems`, the
 * length, size and range bounds, `pattern`, `allOf` / `anyOf` / `oneOf`,
 * local `$ref`s (`#/$defs/...`, `#/definitions/...`) and OpenAPI's
 * `nullable`. A `$ref`'s sibling keywords apply as in 2019-09 and later, and
 * are ignored when the root `$schema` names draft 03 to 07, where a `$ref`
 * replaced its whole schema object; `const` is ignored before draft 6 and
 * `prefixItems` before 2020-12, the drafts that introduced them. Any other keyword (`format`, `not`,
 * `if`/`then`/`else`, `multipleOf`, `uniqueItems`, the `dependent*` family, a
 * remote or malformed `$ref`, a local `$ref` inside an embedded resource with
 * its own `$id`, a `type` name outside the seven JSON types) is ignored, and
 * `oneOf` is read as `anyOf`. A schema whose check would take more than a
 * fixed amount of work is not judged at all: no problems are returned.
 *
 * Ignoring is the point: the validator may let a bad call through, but it
 * never refuses a call the schema accepts. A refusal costs the model a turn,
 * so a false one is worse than a missed one, and a schema written by someone
 * else (an MCP server's) can use any keyword it likes without the run
 * starting to refuse calls its server would have taken.
 *
 * `pattern` is compiled and run synchronously on the model's input, like any
 * regular expression. A schema author's pattern with catastrophic
 * backtracking (`^(a+)+$`) can stall the event loop, and the run's deadline
 * cannot interrupt it; turn validation on only for tools whose schemas you
 * would run that way.
 */
export function validateToolInput(schema: unknown, input: unknown): ToolInputProblem[] {
  const problems: ToolInputProblem[] = []
  try {
    check(schema, input, "", { root: schema, scoped: false, work: { left: MAX_WORK } }, 0, problems)
  } catch (err) {
    // A schema too costly to judge is one the validator cannot judge.
    if (err instanceof WorkExhausted) return []
    throw err
  }
  return problems
}

/** How many problems the model is told about; the rest are counted. */
const MAX_REPORTED = 10

/**
 * The tool result a call gets when its arguments fail the tool's schema, or
 * `undefined` when they fit. The loop answers the call with this instead of
 * running it, and the model corrects the call within its own budgets.
 */
export function invalidInputRefusal(
  tool: Tool,
  input: Record<string, unknown>,
): string | undefined {
  let problems: ToolInputProblem[]
  try {
    problems = validateToolInput(tool.spec.inputSchema, input)
  } catch {
    // A schema the validator trips over is one it cannot judge: the call runs,
    // as it would with validation off, rather than the run failing.
    return undefined
  }
  if (problems.length === 0) return undefined
  const shown = problems
    .slice(0, MAX_REPORTED)
    .map((p) => `${p.path || "(arguments)"}: ${p.message}`)
  const more = problems.length - shown.length
  return (
    `invalid arguments for ${tool.spec.name}; the call was not run. ` +
    `Call it again with arguments that match its input schema: ${shown.join("; ")}` +
    (more > 0 ? `; and ${more} more` : "")
  )
}

/** Deep enough for any real tool schema; a `$ref` cycle stops here instead of looping. */
const MAX_DEPTH = 32

/**
 * How many schema/value checks one validation may make. Shared definitions
 * referenced from several composition branches can multiply the work
 * exponentially without any cycle, and validation runs synchronously before
 * the call, where no deadline can interrupt it; past this the validator gives
 * up and the call runs unjudged.
 */
const MAX_WORK = 25_000
class WorkExhausted extends Error {}

/**
 * What a check carries down: the root schema local `$ref`s resolve against,
 * whether it is inside an embedded resource (a subschema with its own `$id`),
 * where a local `$ref` would resolve against that resource rather than the
 * root and so is ignored, and the work left, shared by the whole validation.
 */
interface Env {
  root: unknown
  scoped: boolean
  work: { left: number }
}

type JsonSchema = Record<string, unknown>

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** The JSON type of a parsed value, as JSON Schema names it. */
function jsonType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"])

/**
 * The draft the root schema declares in `$schema`: 3 to 7 for draft-03 to
 * draft-07, 2019 for 2019-09, 2020 for 2020-12, or `undefined` when it names
 * none (then every keyword the validator knows applies).
 */
function declaredDraft(root: unknown): number | undefined {
  const declared = isObject(root) ? root.$schema : undefined
  if (typeof declared !== "string") return undefined
  const old = /draft-0([3-7])\b/.exec(declared)
  if (old) return Number(old[1])
  if (declared.includes("2019-09")) return 2019
  if (declared.includes("2020-12")) return 2020
  return undefined
}

/** Whether the root schema declares a draft (03 to 07) in which `$ref` siblings are ignored. */
function refReplacesSiblings(root: unknown): boolean {
  const draft = declaredDraft(root)
  return draft !== undefined && draft <= 7
}

/** Whether a keyword introduced in `since` exists in the draft the root schema declares. */
function inDraft(root: unknown, since: number): boolean {
  const draft = declaredDraft(root)
  return draft === undefined || draft >= since
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === "number" && actual === "integer")
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    )
  }
  return false
}

/** A pattern the validator can compile, or `undefined` for one it cannot (then the keyword is ignored). */
function compile(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== "string") return undefined
  try {
    return new RegExp(pattern, "u")
  } catch {
    try {
      return new RegExp(pattern)
    } catch {
      return undefined
    }
  }
}

/** Resolve a local `#/...` JSON Pointer against the root schema. */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined
  // The fragment is percent-decoded as a whole before it is read as a JSON
  // Pointer (RFC 6901 §6), so an encoded `/` (`%2F`) separates tokens.
  let fragment: string
  try {
    fragment = decodeURIComponent(ref.slice(1))
  } catch {
    // A malformed escape (`%` not followed by two hex digits) names nothing.
    return undefined
  }
  if (fragment === "") return root
  if (!fragment.startsWith("/")) return undefined
  let node: unknown = root
  for (const raw of fragment.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!isObject(node) && !Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

const pointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)

const quoted = (values: unknown[]): string => {
  const shown = values.slice(0, MAX_REPORTED).map((v) => JSON.stringify(v))
  return values.length > shown.length ? `${shown.join(", ")}, …` : shown.join(", ")
}

function check(
  schema: unknown,
  value: unknown,
  path: string,
  outer: Env,
  depth: number,
  problems: ToolInputProblem[],
): void {
  if (--outer.work.left < 0) throw new WorkExhausted()
  if (schema === false) {
    problems.push({ path, message: "is not allowed" })
    return
  }
  if (!isObject(schema) || depth > MAX_DEPTH) return
  const s: JsonSchema = schema
  const env: Env =
    !outer.scoped &&
    schema !== outer.root &&
    (typeof s.$id === "string" || typeof s.id === "string")
      ? { ...outer, scoped: true }
      : outer
  const at = (message: string) => problems.push({ path, message })
  // OpenAPI's `nullable` admits null whatever else the schema says, composition
  // included (generators emit `{ allOf: [{ $ref }], nullable: true }`).
  if (s.nullable === true && value === null) return

  if (typeof s.$ref === "string") {
    // Inside an embedded resource a local `$ref` means that resource, which
    // this validator does not track, so it is ignored rather than misread.
    const target = env.scoped ? undefined : resolveRef(env.root, s.$ref)
    if (target !== undefined) check(target, value, path, env, depth + 1, problems)
    // Before 2019-09 a `$ref` replaced its whole schema object: the keywords
    // beside it are ignored, so they are ignored here too.
    if (refReplacesSiblings(env.root)) return
  }
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) check(branch, value, path, env, depth + 1, problems)
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = s[key]
    if (!Array.isArray(branches) || branches.length === 0) continue
    const fits = branches.some((branch) => {
      const inner: ToolInputProblem[] = []
      check(branch, value, path, env, depth + 1, inner)
      return inner.length === 0
    })
    if (!fits) at(`matches none of the ${branches.length} allowed shapes`)
  }

  const actual = jsonType(value)
  const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type : undefined
  // A type name outside the seven JSON types (draft 3's `any`, a typo) is a
  // keyword the validator does not know, so the whole `type` check is skipped.
  const knownTypes =
    types !== undefined &&
    types.length > 0 &&
    types.every((t) => typeof t === "string" && JSON_TYPES.has(t))
  if (types && knownTypes && !types.some((t) => typeMatches(t as string, actual))) {
    // "integer" is the schema's word for a kind of number, not a type a model writes.
    at(`expected ${types.join(" or ")}, got ${actual === "integer" ? "number" : actual}`)
    // The keywords below would only restate a wrong type as several problems.
    return
  }

  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value))) {
    at(`must be one of ${quoted(s.enum)}`)
  }
  // `const` arrived in draft 6; an older schema's `const` is an unknown keyword.
  if (Object.hasOwn(s, "const") && inDraft(env.root, 6) && !deepEqual(s.const, value)) {
    at(`must be ${JSON.stringify(s.const)}`)
  }

  if (typeof value === "string") {
    const length = [...value].length
    const min = num(s.minLength)
    const max = num(s.maxLength)
    if (min !== undefined && length < min) at(`must be at least ${min} characters`)
    if (max !== undefined && length > max) at(`must be at most ${max} characters`)
    const pattern = compile(s.pattern)
    if (pattern && !pattern.test(value)) at(`must match the pattern ${String(s.pattern)}`)
  }

  if (typeof value === "number") {
    const min = num(s.minimum)
    const max = num(s.maximum)
    // Draft 4 spelled the exclusive bounds as booleans beside minimum/maximum.
    const exMin = num(s.exclusiveMinimum) ?? (s.exclusiveMinimum === true ? min : undefined)
    const exMax = num(s.exclusiveMaximum) ?? (s.exclusiveMaximum === true ? max : undefined)
    if (min !== undefined && s.exclusiveMinimum !== true && value < min) at(`must be >= ${min}`)
    if (max !== undefined && s.exclusiveMaximum !== true && value > max) at(`must be <= ${max}`)
    if (exMin !== undefined && value <= exMin) at(`must be > ${exMin}`)
    if (exMax !== undefined && value >= exMax) at(`must be < ${exMax}`)
  }

  if (Array.isArray(value)) {
    const min = num(s.minItems)
    const max = num(s.maxItems)
    if (min !== undefined && value.length < min) at(`must have at least ${min} items`)
    if (max !== undefined && value.length > max) at(`must have at most ${max} items`)
    // Positional schemas: `prefixItems` (2020-12) or an `items` array (draft 7).
    // `prefixItems` arrived in 2020-12; under an older declared draft it is unknown.
    const positional =
      Array.isArray(s.prefixItems) && inDraft(env.root, 2020)
        ? s.prefixItems
        : Array.isArray(s.items)
          ? s.items
          : []
    positional.forEach((item, i) => {
      if (i < value.length) check(item, value[i], pointer(path, i), env, depth + 1, problems)
    })
    if (!Array.isArray(s.items) && s.items !== undefined) {
      for (let i = positional.length; i < value.length; i += 1) {
        check(s.items, value[i], pointer(path, i), env, depth + 1, problems)
      }
    }
  }

  if (isObject(value)) {
    const properties = isObject(s.properties) ? s.properties : {}
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          problems.push({ path: pointer(path, key), message: "is required" })
        }
      }
    }
    const min = num(s.minProperties)
    const max = num(s.maxProperties)
    const count = Object.keys(value).length
    if (min !== undefined && count < min) at(`must have at least ${min} properties`)
    if (max !== undefined && count > max) at(`must have at most ${max} properties`)
    // A key matched by `patternProperties` is not "additional". If any of its
    // patterns cannot be compiled, nothing can be called additional with
    // confidence, so that check is skipped rather than guessed.
    const patternKeys = isObject(s.patternProperties) ? Object.keys(s.patternProperties) : []
    const patterns = patternKeys.map(compile)
    const additionalKnown = patterns.every((p) => p !== undefined)
    for (const [key, item] of Object.entries(value)) {
      const where = pointer(path, key)
      if (Object.hasOwn(properties, key)) {
        check(properties[key], item, where, env, depth + 1, problems)
        continue
      }
      if (!additionalKnown || patterns.some((p) => p?.test(key))) continue
      if (s.additionalProperties === false) {
        problems.push({ path: where, message: "is not an allowed property" })
      } else if (isObject(s.additionalProperties)) {
        check(s.additionalProperties, item, where, env, depth + 1, problems)
      }
    }
  }
}
