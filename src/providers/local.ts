import { OpenAICompatibleProvider } from "./openai.js"

/**
 * Default model id when neither the run nor LOCAL_MODEL specifies one. A local
 * server usually has a single model loaded and either accepts any id or ignores
 * it, so this is a readable placeholder rather than a real catalog name.
 */
export const LOCAL_DEFAULT_MODEL = "local"

/**
 * A self-hosted / local model reached over the OpenAI chat.completions dialect —
 * the same shared core as OpenAI and OpenRouter, pointed at an operator-supplied
 * base URL (llama-server, LM Studio, vLLM, Ollama's OpenAI endpoint, …).
 *
 * It exists so a run that must stay on private inference has a provider to
 * actually run on: jumpdrive-web#654 forces a `data_class: pii` workflow onto the
 * org's designated model, and this is what that model can point at.
 *
 * The API key is OPTIONAL — a local server typically needs none. When it is
 * absent the Authorization header is omitted entirely (rather than sent as an
 * empty or placeholder bearer token), by handing the SDK a `null` header.
 */
export class LocalProvider extends OpenAICompatibleProvider {
  constructor(
    baseURL: string,
    apiKey?: string,
    model = process.env.LOCAL_MODEL ?? LOCAL_DEFAULT_MODEL,
  ) {
    const hasKey = typeof apiKey === "string" && apiKey.length > 0
    super("local", {
      // The OpenAI SDK requires a non-empty apiKey to construct at all; a keyless
      // local server ignores it, and the header is suppressed below so nothing is
      // sent on the wire.
      apiKey: hasKey ? apiKey : "no-key",
      model,
      baseURL,
      // No key → drop the Authorization header entirely (a keyless server must
      // not receive `Bearer no-key`). With a key, send it the normal way.
      ...(hasKey ? {} : { defaultHeaders: { Authorization: null } }),
    })
  }
}
