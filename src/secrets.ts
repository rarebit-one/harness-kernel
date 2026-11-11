/**
 * Turn the run payload's resolved secrets into an environment map for the
 * code-exec primitive. The caller resolves secret VALUES (from its own secret
 * store) before the run; the kernel treats them as opaque and only ever
 * forwards them into executed code as environment variables — never logging them.
 */
export function secretsToEnv(secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(secrets)) {
    env[key] = value
  }
  return env
}

/**
 * Values shorter than this are not masked. Masking exact substrings means a
 * one- or two-character "secret" (a flag like `1`, a region like `eu`) would
 * shred every tool result it happens to appear in; a credential that short is
 * not a meaningful secret anyway.
 */
export const MIN_MASKED_SECRET_LENGTH = 6

/** What a masked secret value is replaced with in model-bound text. */
export const MASKED_SECRET = "[secret]"

/** Masks resolved secret values in model-bound text; see {@link secretMaskSet}. */
export interface SecretMaskSet {
  /** Mask `value` from now on (ignored below {@link MIN_MASKED_SECRET_LENGTH}). */
  add: (value: string) => void
  mask: (text: string) => string
}

/**
 * Replaces each resolved secret VALUE in text with {@link MASKED_SECRET},
 * longest first so a secret containing another is masked whole. Secrets are
 * handed to executed code as env (see secretsToEnv), so a command such as
 * `env` would otherwise echo them straight into the model's context and on to
 * its provider. It is a backstop, not a classifier: a value the code
 * transformed (encoded, split) is not caught.
 *
 * The set grows during the run: a credential resolved mid-run (a connector's
 * rotated token) is masked from the moment it is added, the same as a secret
 * the run started with.
 */
export function secretMaskSet(secrets: Record<string, string> = {}): SecretMaskSet {
  const known = new Set<string>()
  let values: string[] = []
  const add = (value: string): void => {
    if (typeof value !== "string" || value.length < MIN_MASKED_SECRET_LENGTH) return
    // Each value is also matched in its JSON-escaped form: tools such as
    // run_code JSON-encode their result, so a value holding a quote, backslash
    // or newline (a multi-line private key) reaches the model escaped.
    const forms = [value, JSON.stringify(value).slice(1, -1)].filter((v) => !known.has(v))
    if (forms.length === 0) return
    for (const form of forms) known.add(form)
    values = [...known].sort((a, b) => b.length - a.length)
  }
  for (const value of Object.values(secrets)) add(value)
  return {
    add,
    mask: (text) => {
      let out = text
      for (const value of values) {
        if (out.includes(value)) out = out.split(value).join(MASKED_SECRET)
      }
      return out
    },
  }
}
