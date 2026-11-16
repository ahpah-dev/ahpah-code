import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { ProviderFetch } from "@opencode/core/provider-fetch"

function mockHttp(handler: (url: string, headers: Headers) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(request.headers)) {
          if (typeof v === "string") headers.set(k, v)
        }
        const response = handler(request.url, headers)
        return HttpClientResponse.fromWeb(request, response)
      }),
    ),
  )
}

describe("ProviderFetch", () => {
  test("buildCandidateEndpoints covers bare origins, /v1, /models, and ollama", () => {
    expect(ProviderFetch.buildCandidateEndpoints("https://api.example.com")).toEqual([
      { url: "https://api.example.com/models", kind: "models" },
      { url: "https://api.example.com/v1/models", kind: "models" },
    ])

    expect(ProviderFetch.buildCandidateEndpoints("https://api.example.com/v1")).toEqual([
      { url: "https://api.example.com/v1/models", kind: "models" },
    ])

    expect(ProviderFetch.buildCandidateEndpoints("https://api.example.com/custom/models")).toEqual([
      { url: "https://api.example.com/custom/models", kind: "models" },
    ])

    expect(
      ProviderFetch.buildCandidateEndpoints("http://localhost:11434/v1", "@opencode/ai/providers/openai-compatible"),
    ).toEqual([
      { url: "http://localhost:11434/v1/models", kind: "models" },
      { url: "http://localhost:11434/api/tags", kind: "ollama" },
    ])

    expect(ProviderFetch.buildCandidateEndpoints("ftp://invalid.example.com")).toEqual([])
  })

  test("parseModelsPayload normalizes OpenAI, OpenRouter, Ollama, Anthropic, and Gemini shapes", () => {
    const models = ProviderFetch.parseModelsPayload({
      data: [
        {
          id: "gpt-4o",
          owned_by: "openai",
          context_length: 128000,
          max_output_tokens: 16384,
          capabilities: { tools: true, vision: true, reasoning: false },
        },
        {
          id: "claude-sonnet-4",
          display_name: "Claude Sonnet 4",
          supported_parameters: ["tools", "reasoning"],
          architecture: { input_modalities: ["text", "image"] },
          top_provider: { context_length: 200000, max_completion_tokens: 8192 },
        },
      ],
    })
    expect(models).toEqual([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        context: 200000,
        output: 8192,
        tools: true,
        vision: true,
        reasoning: true,
      },
      {
        id: "gpt-4o",
        ownedBy: "openai",
        context: 128000,
        output: 16384,
        tools: true,
        vision: true,
        reasoning: false,
      },
    ])

    const ollama = ProviderFetch.parseModelsPayload({
      models: [{ model: "qwen2.5-coder:14b", name: "Qwen 2.5 Coder 14B" }],
    })
    expect(ollama).toEqual([{ id: "qwen2.5-coder:14b", name: "Qwen 2.5 Coder 14B" }])

    const gemini = ProviderFetch.parseModelsPayload({
      models: [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          inputTokenLimit: 1000000,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/embedding-001",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    })
    expect(gemini).toEqual([
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        context: 1000000,
        output: 65536,
      },
    ])
  })

  test("fetchModels falls back to /v1/models and sends provider auth headers", async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const layer = mockHttp((url, headers) => {
      seen.push({ url, auth: headers.get("authorization") })
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: "llama-3.3-70b", owned_by: "meta" }] })
      }
      return new Response("Not found", { status: 404 })
    })

    const result = await Effect.runPromise(
      ProviderFetch.fetchModels({
        baseURL: "https://api.example.com",
        apiKey: "sk-test-123",
      }).pipe(Effect.provide(layer)),
    )

    expect(result.endpoint).toBe("https://api.example.com/v1/models")
    expect(result.models).toEqual([{ id: "llama-3.3-70b", ownedBy: "meta" }])
    expect(seen).toEqual([
      { url: "https://api.example.com/models", auth: "Bearer sk-test-123" },
      { url: "https://api.example.com/v1/models", auth: "Bearer sk-test-123" },
    ])
  })

  test("fetchModels stops immediately on 401 auth failure and uses Google/Anthropic headers", async () => {
    const seen: Array<{ url: string; anthropicKey: string | null; anthropicVersion: string | null }> = []
    const anthropicLayer = mockHttp((url, headers) => {
      seen.push({
        url,
        anthropicKey: headers.get("x-api-key"),
        anthropicVersion: headers.get("anthropic-version"),
      })
      return Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
    })

    await expect(
      Effect.runPromise(
        ProviderFetch.fetchModels({
          baseURL: "https://api.anthropic.com",
          apiKey: "sk-bad",
          package: "@opencode/ai/providers/anthropic",
        }).pipe(Effect.provide(anthropicLayer)),
      ),
    ).rejects.toThrow("Invalid API key")

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      url: "https://api.anthropic.com/models",
      anthropicKey: "sk-bad",
      anthropicVersion: "2023-06-01",
    })
  })
})
