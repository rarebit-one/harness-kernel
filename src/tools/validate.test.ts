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
