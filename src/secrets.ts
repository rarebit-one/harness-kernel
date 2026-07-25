/**
 * Turn the run payload's resolved secrets into an environment map for the
 * code-exec primitive. The control plane resolves secret VALUES (from the
 * SecretStore) before the run; the runner treats them as opaque and only ever
 * forwards them into executed code as environment variables — never logging them.
 */
export function secretsToEnv(secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(secrets)) {
    env[key] = value
  }
  return env
}
