export * as ProviderFetch from "./provider-fetch.js"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { Provider } from "@opencode/schema/provider"

export class FetchError extends Schema.TaggedError<FetchError>()("ProviderFetch.Error", {
  message: Schema.String,
}) {}

const requestTimeout = "15 seconds"

type EndpointCandidate = {
  readonly url: string
  readonly kind: "models" | "ollama"
}

export function buildCandidateEndpoints(baseURL: string, pkg?: string): EndpointCandidate[] {
  const trimmed = baseURL.trim().replace(/\/+$/, "")
  if (!trimmed || !URL.canParse(trimmed)) return []
  const parsed = new URL(trimmed)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return []

  const path = parsed.pathname.replace(/\/+$/, "")
  const candidates: EndpointCandidate[] = []
  const push = (url: string, kind: "models" | "ollama") => {
    if (!candidates.some((item) => item.url === url)) candidates.push({ url, kind })
  }

  const isOllama = pkg?.includes("ollama") || parsed.port === "11434"
  if (path.endsWith("/models")) {
    push(trimmed, "models")
    return candidates
  }
  if (path.endsWith("/api/tags")) {
    push(trimmed, "ollama")
    return candidates
  }

  push(`${trimmed}/models`, "models")
  if (!/\/v\d+(?:alpha|beta)?$/i.test(path)) {
    push(`${trimmed}/v1/models`, "models")
  }
  if (isOllama) {
    const root = new URL(parsed.origin)
    root.pathname = path.replace(/\/(?:v1|api)$/i, "") + "/api/tags"
    push(root.toString(), "ollama")
  }
  return candidates
}

function authHeaders(input: {
  readonly apiKey?: string
  readonly package?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly url: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  }
  const key = input.apiKey?.trim()
  const isAnthropic =
    input.package?.includes("anthropic") || input.url.includes("anthropic.com")
  const isGoogle =
    input.package?.includes("google") || input.url.includes("generativelanguage.googleapis.com")

  if (key) {
    if (isAnthropic) {
      headers["x-api-key"] = key
      headers["anthropic-version"] = "2023-06-01"
      headers["Authorization"] = `Bearer ${key}`
    } else if (isGoogle) {
      headers["x-goog-api-key"] = key
    } else {
      headers["Authorization"] = `Bearer ${key}`
    }
  } else if (isAnthropic) {
    headers["anthropic-version"] = "2023-06-01"
  }

  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      if (k.trim() && v !== undefined) headers[k] = v
    }
  }
  return headers
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseModelsPayload(payload: unknown): Provider.FetchedModel[] {
  const root = asRecord(payload)
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : undefined
  if (!items) return []

  const seen = new Map<string, Provider.FetchedModel>()
  for (const raw of items) {
    const item = asRecord(raw)
    if (!item) continue
    const rawId =
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : typeof item.model === "string" && item.model.trim()
          ? item.model.trim()
          : typeof item.name === "string" && item.name.trim()
            ? item.name.trim()
            : undefined
    if (!rawId) continue

    const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId
    const displayName =
      typeof item.display_name === "string" && item.display_name.trim()
        ? item.display_name.trim()
        : typeof item.displayName === "string" && item.displayName.trim()
          ? item.displayName.trim()
          : typeof item.name === "string" && item.name.trim() && item.name.trim() !== rawId
            ? item.name.trim()
            : undefined

    const limits = asRecord(item.limits) ?? asRecord(item.limit)
    const topProvider = asRecord(item.top_provider)
    const context =
      asPositiveInt(item.context_length) ??
      asPositiveInt(item.max_model_len) ??
      asPositiveInt(item.context_window) ??
      asPositiveInt(item.inputTokenLimit) ??
      asPositiveInt(limits?.context) ??
      asPositiveInt(topProvider?.context_length)
    const output =
      asPositiveInt(item.max_output_tokens) ??
      asPositiveInt(item.outputTokenLimit) ??
      asPositiveInt(limits?.output) ??
      asPositiveInt(topProvider?.max_completion_tokens)

    const capabilities = asRecord(item.capabilities)
    const supportedParams = Array.isArray(item.supported_parameters)
      ? item.supported_parameters.filter((v): v is string => typeof v === "string")
      : []
    const supportedGenMethods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods.filter((v): v is string => typeof v === "string")
      : []
    if (
      supportedGenMethods.length > 0 &&
      !supportedGenMethods.includes("generateContent") &&
      !supportedGenMethods.includes("streamGenerateContent")
    ) {
      continue
    }

    const architecture = asRecord(item.architecture)
    const inputModalities = Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities
      : Array.isArray(item.input_modalities)
        ? item.input_modalities
        : undefined
    const tools =
      typeof capabilities?.tools === "boolean"
        ? capabilities.tools
        : supportedParams.includes("tools")
          ? true
          : undefined
    const vision =
      typeof capabilities?.vision === "boolean"
        ? capabilities.vision
        : inputModalities?.includes("image")
          ? true
          : undefined
    const reasoning =
      typeof capabilities?.reasoning === "boolean"
        ? capabilities.reasoning
        : supportedParams.includes("reasoning") || supportedParams.includes("include_reasoning")
          ? true
          : undefined

    const ownedBy = typeof item.owned_by === "string" && item.owned_by.trim() ? item.owned_by.trim() : undefined

    if (!seen.has(id)) {
      seen.set(id, {
        id,
        ...(displayName ? { name: displayName } : {}),
        ...(ownedBy ? { ownedBy } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(vision !== undefined ? { vision } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
      })
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.id.localeCompare(b.id))
}

export const fetchModels = Effect.fn("ProviderFetch.fetchModels")(function* (input: {
  readonly baseURL: string
  readonly apiKey?: string
  readonly package?: string
  readonly headers?: Readonly<Record<string, string>>
}) {
  const candidates = buildCandidateEndpoints(input.baseURL, input.package)
  if (candidates.length === 0) {
    return yield* new FetchError({ message: "Enter a valid http:// or https:// Base URL" })
  }

  const http = yield* HttpClient.HttpClient
  let lastError = "Failed to fetch models from provider"

  for (const candidate of candidates) {
    const req = HttpClientRequest.get(candidate.url).pipe(
      HttpClientRequest.setHeaders(
        authHeaders({
          apiKey: input.apiKey,
          package: input.package,
          headers: input.headers,
          url: candidate.url,
        }),
      ),
    )

    const outcome = yield* http.execute(req).pipe(
      Effect.flatMap((res) =>
        Effect.gen(function* () {
          const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""))
          if (res.status < 200 || res.status >= 300) {
            return {
              ok: false as const,
              status: res.status,
              error: extractErrorMessage(text) ?? `HTTP ${res.status} from ${candidate.url}`,
            }
          }
          try {
            const parsed: unknown = JSON.parse(text)
            const models = parseModelsPayload(parsed)
            return { ok: true as const, endpoint: candidate.url, models }
          } catch {
            return {
              ok: false as const,
              status: res.status,
              error: `Invalid JSON response from ${candidate.url}`,
            }
          }
        }),
      ),
      Effect.timeout(requestTimeout),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          status: 0,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    )

    if (outcome.ok) {
      return { endpoint: outcome.endpoint, models: outcome.models } satisfies Provider.FetchModelsResponse
    }

    lastError = outcome.error
    // Auth errors won't improve on fallback paths; stop early with the real error.
    if (outcome.status === 401 || outcome.status === 403) break
  }

  return yield* new FetchError({ message: lastError })
})

function extractErrorMessage(text: string): string | undefined {
  if (!text.trim()) return undefined
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const err = asRecord(parsed.error)
    if (typeof err?.message === "string" && err.message.trim()) return err.message.trim()
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim()
  } catch {}
  return text.trim().slice(0, 200)
}
