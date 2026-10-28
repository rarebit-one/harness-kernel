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

/**
 * A function that replaces each resolved secret VALUE in `text` with
 * {@link MASKED_SECRET}, longest first so a secret containing another is masked
 * whole. Secrets are handed to executed code as env (see secretsToEnv), so a
 * command such as `env` would otherwise echo them straight into the model's
 * context and on to its provider. It is a backstop, not a classifier: a value
 * the code transformed (encoded, split) is not caught.
 */
export function secretMasker(secrets: Record<string, string> = {}): (text: string) => string {
  const values = [...new Set(Object.values(secrets))]
    .filter((v) => typeof v === "string" && v.length >= MIN_MASKED_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  if (values.length === 0) return (text) => text
  return (text) => {
    let out = text
    for (const value of values) {
      if (out.includes(value)) out = out.split(value).join(MASKED_SECRET)
    }
    return out
  }
}
