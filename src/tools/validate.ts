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
 * `nullable`, with `$ref` read as 2020-12 reads it (its siblings still apply).
 * Any other keyword (`format`, `not`, `if`/`then`/`else`, `multipleOf`,
 * `uniqueItems`, the `dependent*` family, a remote `$ref`) is ignored, and
 * `oneOf` is read as `anyOf`.
 *
 * Ignoring is the point: the validator may let a bad call through, but it
 * never refuses a call the schema accepts. A refusal costs the model a turn,
 * so a false one is worse than a missed one, and a schema written by someone
 * else (an MCP server's) can use any keyword it likes without the run
 * starting to refuse calls its server would have taken.
 */
export function validateToolInput(schema: unknown, input: unknown): ToolInputProblem[] {
  const problems: ToolInputProblem[] = []
  check(schema, input, "", schema, 0, problems)
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
  const problems = validateToolInput(tool.spec.inputSchema, input)
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
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  let node: unknown = root
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~")
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
  root: unknown,
  depth: number,
  problems: ToolInputProblem[],
): void {
  if (schema === false) {
    problems.push({ path, message: "is not allowed" })
    return
  }
  if (!isObject(schema) || depth > MAX_DEPTH) return
  const s: JsonSchema = schema
  const at = (message: string) => problems.push({ path, message })

  if (typeof s.$ref === "string") {
    const target = resolveRef(root, s.$ref)
    if (target !== undefined) check(target, value, path, root, depth + 1, problems)
  }
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) check(branch, value, path, root, depth + 1, problems)
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = s[key]
    if (!Array.isArray(branches) || branches.length === 0) continue
    const fits = branches.some((branch) => {
      const inner: ToolInputProblem[] = []
      check(branch, value, path, root, depth + 1, inner)
      return inner.length === 0
    })
    if (!fits) at(`matches none of the ${branches.length} allowed shapes`)
  }

  const actual = jsonType(value)
  if (s.nullable === true && value === null) return
  const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type : undefined
  if (types && !types.some((t) => typeof t === "string" && typeMatches(t, actual))) {
    // "integer" is the schema's word for a kind of number, not a type a model writes.
    at(`expected ${types.join(" or ")}, got ${actual === "integer" ? "number" : actual}`)
    // The keywords below would only restate a wrong type as several problems.
    return
  }

  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value))) {
    at(`must be one of ${quoted(s.enum)}`)
  }
  if (Object.hasOwn(s, "const") && !deepEqual(s.const, value)) {
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
    const positional = Array.isArray(s.prefixItems)
      ? s.prefixItems
      : Array.isArray(s.items)
        ? s.items
        : []
    positional.forEach((item, i) => {
      if (i < value.length) check(item, value[i], pointer(path, i), root, depth + 1, problems)
    })
    if (!Array.isArray(s.items) && s.items !== undefined) {
      for (let i = positional.length; i < value.length; i += 1) {
        check(s.items, value[i], pointer(path, i), root, depth + 1, problems)
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
        check(properties[key], item, where, root, depth + 1, problems)
        continue
      }
      if (!additionalKnown || patterns.some((p) => p?.test(key))) continue
      if (s.additionalProperties === false) {
        problems.push({ path: where, message: "is not an allowed property" })
      } else if (isObject(s.additionalProperties)) {
        check(s.additionalProperties, item, where, root, depth + 1, problems)
      }
    }
  }
}
