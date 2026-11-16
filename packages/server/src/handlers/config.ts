import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { ProviderFetch } from "@opencode/core/provider-fetch"
import { ShellSelect } from "@opencode/core/shell/select"
import { InvalidRequestError } from "@opencode/protocol/errors"
import type { Document } from "@opencode/schema/config"
import type { ConfigProvider } from "@opencode/schema/config/provider"
import type { Provider as ProviderSchema } from "@opencode/schema/provider"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"

function configuredProviderInfo(
  entries: readonly { type: string; info?: { providers?: Record<string, ConfigProvider.Info> } }[],
  providerID: string,
) {
  let merged: ConfigProvider.Info | undefined
  let hasConfig = false
  for (const entry of entries) {
    if (entry.type !== "document") continue
    const doc = entry as Document
    const item = doc.info.providers?.[providerID]
    if (!item) continue
    hasConfig = true
    merged = {
      ...(merged ?? {}),
      ...item,
      settings: item.settings ? { ...(merged?.settings ?? {}), ...item.settings } : merged?.settings,
      headers: item.headers ? { ...(merged?.headers ?? {}), ...item.headers } : merged?.headers,
      models: item.models ? { ...(merged?.models ?? {}), ...item.models } : merged?.models,
    }
  }
  return { configured: merged, hasConfig }
}

function toConfigModels(models: ConfigProvider.Info["models"]): ProviderSchema.ConfigModel[] {
  if (!models) return []
  return Object.entries(models).map(([id, cfg]) => {
    const reasoning =
      cfg.capabilities?.reasoning && typeof cfg.capabilities.reasoning === "object"
        ? cfg.capabilities.reasoning.supported
        : undefined
    const vision = cfg.capabilities?.input ? cfg.capabilities.input.includes("image") : undefined
    return {
      id,
      ...(cfg.name ? { name: cfg.name } : {}),
      ...(cfg.modelID ? { modelID: cfg.modelID } : {}),
      ...(cfg.limit?.context !== undefined ? { context: cfg.limit.context } : {}),
      ...(cfg.limit?.output !== undefined ? { output: cfg.limit.output } : {}),
      ...(cfg.capabilities?.tools !== undefined ? { tools: cfg.capabilities.tools } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(cfg.disabled !== undefined ? { disabled: cfg.disabled } : {}),
    }
  })
}

const buildConfigState = Effect.fnUntraced(function* (providerID: Provider.ID) {
  const config = yield* Config.Service
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const integrations = yield* Integration.Service

  const entries = yield* config.entries()
  const { configured, hasConfig } = configuredProviderInfo(entries, providerID)
  const runtime = yield* providers.get(providerID)
  const runtimeModels = (yield* models.available()).filter((m) => m.providerID === providerID)

  const integrationID = runtime?.integrationID ?? Integration.ID.make(providerID)
  const integration = yield* integrations.get(integrationID)
  const hasIntegrationCredential =
    integration?.connections.some((c) => c.type === "credential" || c.type === "env") ?? false
  const configApiKey = typeof configured?.settings?.apiKey === "string" && configured.settings.apiKey.length > 0

  const configuredBaseURL =
    typeof configured?.settings?.baseURL === "string" && configured.settings.baseURL.trim()
      ? configured.settings.baseURL.trim()
      : undefined
  const runtimeBaseURL =
    typeof runtime?.settings?.baseURL === "string" && runtime.settings.baseURL.trim()
      ? runtime.settings.baseURL.trim()
      : undefined
  const defaultBaseURL = runtimeModels.find(
    (m) => typeof m.settings?.baseURL === "string" && m.settings.baseURL.trim().length > 0,
  )?.settings?.baseURL as string | undefined

  return {
    providerID,
    name: configured?.name ?? runtime?.name ?? integration?.name ?? providerID,
    package: configured?.package ?? runtime?.package ?? "@opencode/ai/providers/openai-compatible",
    ...(configuredBaseURL ?? runtimeBaseURL ? { baseURL: configuredBaseURL ?? runtimeBaseURL } : {}),
    ...(defaultBaseURL ? { defaultBaseURL } : {}),
    ...(configured?.headers ?? runtime?.headers ? { headers: configured?.headers ?? runtime?.headers } : {}),
    hasCredential: hasIntegrationCredential || configApiKey,
    hasConfig,
    models: toConfigModels(configured?.models),
  } satisfies ProviderSchema.ConfigState
})

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      "config.update",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
        return yield* config.update(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    )
    .handle(
      "config.fetchProviderModels",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins
        const providers = yield* Provider.Service
        const integrations = yield* Integration.Service
        const config = yield* Config.Service

        const providerID = ctx.payload.providerID
        const runtime = providerID ? yield* providers.get(providerID) : undefined
        let apiKey = ctx.payload.apiKey?.trim() || undefined
        if (!apiKey && providerID) {
          const integrationID = runtime?.integrationID ?? Integration.ID.make(providerID)
          const active = yield* integrations.connection.active(integrationID)
          const resolved = active
            ? yield* integrations.connection.resolve(active).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          if (resolved?.type === "key") apiKey = resolved.key
          else if (resolved?.type === "oauth") apiKey = resolved.access
          if (!apiKey) {
            const { configured } = configuredProviderInfo(yield* config.entries(), providerID)
            if (typeof configured?.settings?.apiKey === "string" && configured.settings.apiKey.trim()) {
              apiKey = configured.settings.apiKey.trim()
            } else if (typeof runtime?.settings?.apiKey === "string" && runtime.settings.apiKey.trim()) {
              apiKey = runtime.settings.apiKey.trim()
            }
          }
        }

        const mergedHeaders =
          runtime?.headers || ctx.payload.headers
            ? { ...(runtime?.headers ?? {}), ...(ctx.payload.headers ?? {}) }
            : undefined

        const result = yield* ProviderFetch.fetchModels({
          baseURL: ctx.payload.baseURL,
          apiKey,
          package: ctx.payload.package ?? runtime?.package,
          headers: mergedHeaders,
        }).pipe(
          Effect.mapError(
            (error) => new InvalidRequestError({ message: error.message, kind: "provider_fetch_models" }),
          ),
        )
        return yield* response(Effect.succeed(result))
      }),
    )
    .handle(
      "config.getProvider",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins
        return yield* response(buildConfigState(ctx.params.providerID))
      }),
    )
    .handle(
      "config.saveProvider",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins
        const providerID = ctx.params.providerID.trim()
        if (!providerID) {
          return yield* new InvalidRequestError({
            message: "Provider ID is required",
            kind: "provider_config_invalid",
          })
        }

        const config = yield* Config.Service
        if (!config.saveProvider) {
          return yield* new InvalidRequestError({
            message: "Config updates are unavailable",
            kind: "provider_config_unavailable",
          })
        }

        const apiKey = typeof ctx.payload.apiKey === "string" ? ctx.payload.apiKey.trim() : undefined
        const patch: ProviderSchema.ConfigSave =
          apiKey && apiKey.length > 0 ? { ...ctx.payload, apiKey: null } : ctx.payload

        yield* config.saveProvider(providerID, patch).pipe(Effect.orDie)
        // Let ConfigEntryObserver process config.updated and rebuild Integration/Provider state.
        yield* Effect.sleep("50 millis")

        if (apiKey && apiKey.length > 0) {
          const providers = yield* Provider.Service
          const integrations = yield* Integration.Service
          const runtime = yield* providers.get(Provider.ID.make(providerID))
          const integrationID = runtime?.integrationID ?? Integration.ID.make(providerID)
          const integration = yield* integrations.get(integrationID)
          const supportsKey = integration?.methods.some((m) => m.type === "key" && !m.form?.length) ?? false
          if (supportsKey) {
            yield* integrations.connection
              .key({ integrationID, key: apiKey })
              .pipe(
                Effect.mapError(
                  (error) => new InvalidRequestError({ message: error.message, kind: "integration_authorization" }),
                ),
              )
          } else {
            yield* integrations.connection
              .key({ integrationID, key: apiKey })
              .pipe(Effect.catch(() => Effect.void))
          }
          yield* Effect.sleep("30 millis")
        }

        return yield* response(buildConfigState(Provider.ID.make(providerID)))
      }),
    )
    .handle(
      "config.removeProvider",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins
        const config = yield* Config.Service
        if (!config.removeProvider) {
          return yield* new InvalidRequestError({
            message: "Config updates are unavailable",
            kind: "provider_config_unavailable",
          })
        }
        yield* config.removeProvider(ctx.params.providerID).pipe(Effect.orDie)
        yield* Effect.sleep("50 millis")
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
