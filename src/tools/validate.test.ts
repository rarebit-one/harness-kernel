import { describe, it, expect } from "vitest"
import { invalidInputRefusal, validateToolInput } from "./validate.js"
import type { Tool } from "./registry.js"

const paths = (schema: unknown, input: unknown) =>
  validateToolInput(schema, input).map((p) => `${p.path}: ${p.message}`)

describe("validateToolInput", () => {
  const schema = {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 5 },
      count: { type: "integer", minimum: 1, exclusiveMaximum: 10 },
      mode: { enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      when: { type: ["string", "null"] },
    },
    required: ["text"],
  }

  it("accepts arguments that fit, extra properties included when the schema allows them", () => {
    expect(paths(schema, { text: "hi", count: 3, mode: "a", tags: ["x"], when: null })).toEqual([])
    expect(paths(schema, { text: "hi", other: true })).toEqual([])
  })

  it("names a missing required property by its path", () => {
    expect(paths(schema, {})).toEqual(["/text: is required"])
  })

  it("names a wrong type, and does not restate it as further problems", () => {
    expect(paths(schema, { text: 7 })).toEqual(["/text: expected string, got number"])
    expect(paths(schema, { text: "hi", count: 1.5 })).toEqual([
      "/count: expected integer, got number",
    ])
    expect(paths(schema, "nope")).toEqual([": expected object, got string"])
  })

  it("checks bounds, enums and nested items", () => {
    expect(paths(schema, { text: "toolong", count: 10, mode: "c", tags: ["x", 2, "z"] })).toEqual([
      "/text: must be at most 5 characters",
      "/count: must be < 10",
      '/mode: must be one of "a", "b"',
      "/tags: must have at most 2 items",
      "/tags/1: expected string, got number",
    ])
  })

  it("refuses a property additionalProperties: false does not allow", () => {
    const closed = { ...schema, additionalProperties: false }
    expect(paths(closed, { text: "hi", extra: 1 })).toEqual(["/extra: is not an allowed property"])
  })

  it("does not call a property additional when patternProperties covers it", () => {
    const s = {
      type: "object",
      properties: {},
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
    }
    expect(paths(s, { "x-a": "ok" })).toEqual([])
    expect(paths(s, { y: "no" })).toEqual(["/y: is not an allowed property"])
  })

  it("follows local $refs, allOf and anyOf, and reads oneOf as anyOf", () => {
    const s = {
      type: "object",
      properties: {
        item: { $ref: "#/$defs/item" },
        either: { oneOf: [{ type: "string" }, { type: "string", minLength: 2 }] },
        any: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
      $defs: {
        item: {
          type: "object",
          required: ["id"],
          allOf: [{ properties: { id: { type: "string" } } }],
        },
      },
    }
    expect(paths(s, { item: { id: "1" }, either: "ab", any: 3 })).toEqual([])
    expect(paths(s, { item: { id: 1 }, any: true })).toEqual([
      "/item/id: expected string, got number",
      "/any: matches none of the 2 allowed shapes",
    ])
  })

  it("ignores keywords outside its subset rather than guess at them", () => {
    const s = {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        n: { type: "number", multipleOf: 3 },
        x: { not: { type: "string" } },
        r: { $ref: "https://example.com/remote.json" },
        p: { type: "string", pattern: "(?<unclosed" },
      },
      if: { required: ["url"] },
      then: { required: ["n"] },
    }
    expect(paths(s, { url: "not a uri", n: 4, x: "s", r: 1, p: "anything" })).toEqual([])
  })

  it("survives a $ref cycle", () => {
    expect(paths({ $ref: "#" }, { a: 1 })).toEqual([])
  })

  it("admits null under OpenAPI nullable even beside allOf, $ref or anyOf", () => {
    // The shape an OpenAPI-targeted generator emits for a nullable reference or union.
    const s = {
      type: "object",
      properties: {
        owner: { nullable: true, allOf: [{ $ref: "#/$defs/person" }] },
        either: { nullable: true, anyOf: [{ type: "string" }, { type: "number" }] },
      },
      $defs: { person: { type: "object", properties: { name: { type: "string" } } } },
    }
    expect(paths(s, { owner: null, either: null })).toEqual([])
    expect(paths(s, { owner: 1 })).toEqual(["/owner: expected object, got number"])
  })

  it("ignores a $ref's siblings when the schema declares a draft that did", () => {
    const thing = { $ref: "#/definitions/base", additionalProperties: false }
    const s = {
      definitions: { base: { type: "object", properties: { a: { type: "string" } } } },
      type: "object",
      properties: { thing },
    }
    const draft07 = { $schema: "http://json-schema.org/draft-07/schema#", ...s }
    expect(paths(draft07, { thing: { a: "x", b: 1 } })).toEqual([])
    expect(paths(draft07, { thing: { a: 1 } })).toEqual(["/thing/a: expected string, got number"])
    // 2020-12 (and an undeclared draft) applies them; `additionalProperties`
    // sees only the `properties` beside it, so both keys are additional there.
    expect(paths(s, { thing: { a: "x" } })).toEqual(["/thing/a: is not an allowed property"])
  })

  it("ignores a $ref with a malformed percent-escape instead of throwing", () => {
    const s = {
      type: "object",
      properties: { q: { $ref: "#/$defs/100%" } },
      $defs: { "100%": { type: "string" } },
    }
    expect(paths(s, { q: 1 })).toEqual([])
  })

  it("ignores a type name outside the seven JSON types", () => {
    expect(paths({ type: "any" }, "x")).toEqual([])
    expect(paths({ type: ["string", "any"] }, 1)).toEqual([])
    expect(paths({ type: [] }, 1)).toEqual([])
  })

  it("ignores a local $ref inside an embedded resource with its own $id", () => {
    // Inside the resource, "#/definitions/n" means the resource's own integer
    // definition, not the root's string one.
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: {
        n: { type: "string" },
        inner: {
          $id: "http://example.test/inner",
          definitions: { n: { type: "integer" } },
          $ref: "#/definitions/n",
        },
      },
      properties: { v: { $ref: "#/definitions/inner" } },
    }
    expect(validateToolInput(schema, { v: 5 })).toEqual([])
    // Outside the resource the root's definitions still apply.
    expect(
      validateToolInput({ ...schema, properties: { v: { $ref: "#/definitions/n" } } }, { v: 5 }),
    ).toEqual([{ path: "/v", message: "expected string, got number" }])
  })

  it("ignores const and prefixItems under a declared draft that did not have them", () => {
    const kind = { properties: { kind: { type: "string", const: "foo" } } }
    const d4 = "http://json-schema.org/draft-04/schema#"
    expect(validateToolInput({ $schema: d4, ...kind }, { kind: "bar" })).toEqual([])
    expect(validateToolInput(kind, { kind: "bar" })).toEqual([
      { path: "/kind", message: 'must be "foo"' },
    ])
    const tuple = { prefixItems: [{ type: "string" }] }
    const d7 = "http://json-schema.org/draft-07/schema#"
    expect(validateToolInput({ $schema: d7, ...tuple }, [5])).toEqual([])
    expect(
      validateToolInput({ $schema: "https://json-schema.org/draft/2020-12/schema", ...tuple }, [5]),
    ).toEqual([{ path: "/0", message: "expected string, got number" }])
  })

  it("percent-decodes a $ref fragment before splitting it into pointer tokens", () => {
    const schema = {
      $defs: { a: { b: { type: "integer" } }, "a/b": { type: "string" } },
      properties: { v: { $ref: "#/$defs/a%2Fb" } },
    }
    // %2F decodes to a separator: the pointer is /$defs/a/b, the integer.
    expect(validateToolInput(schema, { v: 3 })).toEqual([])
    // The key "a/b" is spelled with JSON Pointer's ~1 escape instead.
    expect(
      validateToolInput({ ...schema, properties: { v: { $ref: "#/$defs/a~1b" } } }, { v: 3 }),
    ).toEqual([{ path: "/v", message: "expected string, got number" }])
  })

  it("gives up rather than doing exponential work over shared definitions", () => {
    // Ten levels, each referencing the one below from four allOf branches:
    // 4^10 checks if every path were walked.
    const $defs: Record<string, unknown> = { l0: { type: "object" } }
    for (let i = 1; i <= 10; i += 1) {
      $defs[`l${i}`] = { allOf: Array.from({ length: 4 }, () => ({ $ref: `#/$defs/l${i - 1}` })) }
    }
    const schema = { $defs, $ref: "#/$defs/l10" }
    const started = Date.now()
    // Invalid input: walked in full it would be refused a million times over.
    expect(validateToolInput(schema, 5)).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("accepts anything for an empty or permissive schema", () => {
    expect(paths({}, { a: 1 })).toEqual([])
    expect(paths(true, { a: 1 })).toEqual([])
    expect(paths({ type: "object" }, { a: 1 })).toEqual([])
  })
})

describe("invalidInputRefusal", () => {
  const tool: Tool = {
    spec: {
      name: "lookup",
      description: "look up",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    execute: async () => "ok",
  }

  it("is undefined when the arguments fit", () => {
    expect(invalidInputRefusal(tool, { id: "1" })).toBeUndefined()
  })

  it("tells the model the call was not run and which arguments to fix", () => {
    expect(invalidInputRefusal(tool, {})).toBe(
      "invalid arguments for lookup; the call was not run. " +
        "Call it again with arguments that match its input schema: /id: is required",
    )
  })

  it("caps how many problems it lists", () => {
    const many: Tool = {
      ...tool,
      spec: {
        ...tool.spec,
        inputSchema: { type: "object", required: Array.from({ length: 12 }, (_, i) => `k${i}`) },
      },
    }
    expect(invalidInputRefusal(many, {})).toMatch(/\/k9: is required; and 2 more$/)
  })
})
