import type { ProviderConfigModel, ProviderFetchedModel } from "@opencode/client/promise"

export type ProviderPackageOption = {
  readonly id: string
  readonly label: string
}

export const PROVIDER_PACKAGE_OPTIONS: readonly ProviderPackageOption[] = [
  { id: "@opencode/ai/providers/openai-compatible", label: "OpenAI Compatible (Chat Completions)" },
  { id: "@opencode/ai/providers/openai-compatible/responses", label: "OpenAI Compatible (Responses)" },
  { id: "@opencode/ai/providers/anthropic-compatible", label: "Anthropic Compatible" },
  { id: "@opencode/ai/providers/openai", label: "OpenAI" },
  { id: "@opencode/ai/providers/anthropic", label: "Anthropic" },
  { id: "@opencode/ai/providers/google", label: "Google Gemini" },
  { id: "@opencode/ai/providers/openrouter", label: "OpenRouter" },
]

export function slugifyProviderID(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function isValidProviderID(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(id.trim())
}

export function fetchedToConfigModel(item: ProviderFetchedModel): ProviderConfigModel {
  return {
    id: item.id,
    name: item.name && item.name !== item.id ? item.name : undefined,
    context: item.context,
    output: item.output,
    tools: item.tools,
    vision: item.vision,
    reasoning: item.reasoning,
  }
}

export function mergeFetchedModels(
  existing: readonly ProviderConfigModel[],
  selected: readonly ProviderFetchedModel[],
): ProviderConfigModel[] {
  const byId = new Map<string, ProviderConfigModel>(existing.map((m) => [m.id, m]))

  for (const item of selected) {
    const incoming = fetchedToConfigModel(item)
    const current = byId.get(item.id)

    if (!current) {
      byId.set(item.id, incoming)

      continue
    }

    byId.set(item.id, {
      ...incoming,
      ...current,
      name: current.name ?? incoming.name,
      context: current.context ?? incoming.context,
      output: current.output ?? incoming.output,
      tools: current.tools ?? incoming.tools,
      vision: current.vision ?? incoming.vision,
      reasoning: current.reasoning ?? incoming.reasoning,
    })
  }

  return Array.from(byId.values())
}

export function formatTokenLimit(limit?: number): string | undefined {
  if (!limit || limit <= 0) return undefined

  if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(limit % 1_000_000 === 0 ? 0 : 1)}M`

  if (limit >= 1_000) return `${Math.round(limit / 1_000)}k`

  return String(limit)
}
