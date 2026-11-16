import { describe, expect, test } from "bun:test"
import {
  fetchedToConfigModel,
  formatTokenLimit,
  isValidProviderID,
  mergeFetchedModels,
  slugifyProviderID,
} from "./model"

describe("provider edit model helpers", () => {
  test("slugifyProviderID and isValidProviderID", () => {
    expect(slugifyProviderID("My Local Ollama!")).toBe("my-local-ollama")
    expect(slugifyProviderID("  OpenAI_Custom  ")).toBe("openai_custom")
    expect(isValidProviderID("my-local-ollama")).toBe(true)
    expect(isValidProviderID("v1_proxy")).toBe(true)
    expect(isValidProviderID("-bad")).toBe(false)
    expect(isValidProviderID("")).toBe(false)
  })

  test("mergeFetchedModels adds new models while preserving existing edits", () => {
    const existing = [
      { id: "gpt-4o", name: "Custom 4o", context: 64000 },
      { id: "manual-only" },
    ]

    const fetched = [
      { id: "gpt-4o", name: "GPT-4o", context: 128000, tools: true, vision: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", context: 128000, output: 16384 },
    ]

    const merged = mergeFetchedModels(existing, fetched)
    expect(merged).toEqual([
      { id: "gpt-4o", name: "Custom 4o", context: 64000, tools: true, vision: true },
      { id: "manual-only" },
      fetchedToConfigModel(fetched[1]!),
    ])
  })

  test("formatTokenLimit", () => {
    expect(formatTokenLimit(undefined)).toBeUndefined()
    expect(formatTokenLimit(128000)).toBe("128k")
    expect(formatTokenLimit(1000000)).toBe("1M")
    expect(formatTokenLimit(1500000)).toBe("1.5M")
    expect(formatTokenLimit(512)).toBe("512")
  })
})
