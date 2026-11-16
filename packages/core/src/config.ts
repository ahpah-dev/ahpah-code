export * as Config from "./config.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { Context, Effect, FiberMap, Layer, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import { Directory, Document, Info, type Patch, type Entry, Event } from "@opencode/schema/config"
import type { Provider as ProviderSchema } from "@opencode/schema/provider"
import { Credential } from "./credential.js"
import { Bus } from "./bus.js"
import { Watcher } from "./filesystem/watcher.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import { ConfigVariable } from "./config/variable.js"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigDiscovery } from "./config/discovery.js"
import { ConfigWatch } from "./config/watch.js"
import { ConfigIntegration } from "./config/integration.js"
import { ConfigManaged } from "./config/managed.js"
import { ManagedPolicy } from "./managed-policy.js"
import { Connection } from "@opencode/schema/connection"
import { WellKnown } from "./wellknown.js"
import { AppProcess } from "@opencode/util/process"
import { ChildProcess } from "effect/process"

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries.findLast((entry): entry is Document => entry.type === "document" && entry.info[key] !== undefined)
    ?.info[key]
}

export interface Interface {
  /** Returns location config documents and discovery sources from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Compatibility roots consumed by internal compatibility plugins. */
  readonly compatibility?: () => Effect.Effect<{
    readonly claude: readonly AbsolutePath[]
    readonly agents: readonly AbsolutePath[]
  }>
  /**
   * Streams raw filesystem updates under config roots. Config owns root
   * topology and watch reconciliation; domain owners filter this feed for the
   * source files they parse and rebuild their own state.
   */
  readonly changes: () => Stream.Stream<Watcher.Update>
  /** Updates supported global config fields while preserving unrelated JSONC content. */
  readonly update?: (patch: Patch) => Effect.Effect<void, FSUtil.Error>
  /** Creates or updates a provider entry in global config while preserving unrelated JSONC content. */
  readonly saveProvider?: (providerID: string, save: ProviderSchema.ConfigSave) => Effect.Effect<void, FSUtil.Error>
  /** Removes a provider entry from global config while preserving unrelated JSONC content. */
  readonly removeProvider?: (providerID: string) => Effect.Effect<void, FSUtil.Error>
  /**
   * Replaces, or clears with `undefined`, the document an integration connection contributes. It loads right after
   * managed policies: its settings layer below remote, user, and project config, while its policies outrank theirs.
   * Changing it reloads config like any other source.
   */
  readonly integration?: (
    integrationID: ConfigIntegration.Document["integrationID"],
    document: ConfigIntegration.Document | undefined,
  ) => Effect.Effect<void>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  // false skips the system and global config dirs, ~/.claude, and ~/.agents;
  // wellknown, file, and content entries still load.
  global: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  // false skips ~/.claude and project .claude dirs.
  claude: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export interface TestInterface extends Interface {
  /** Replaces the entries returned by subsequent entries() calls. */
  readonly setEntries: (entries: Entry[]) => Effect.Effect<void>
  /** Emits one filesystem update to every changes() subscriber. */
  readonly emitChange: (update: Watcher.Update) => Effect.Effect<void>
}

export class Test extends Context.Service<Test, TestInterface>()("@opencode/Config/Test") {}

/** In-memory config for tests: static entries with replaceable state and a test-driven change feed. */
export const testLayer = (
  initial: Entry[] = [],
  compatibility: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] } = {
    claude: [],
    agents: [],
  },
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const entries = yield* Ref.make(initial)
      const integrations = yield* Ref.make(new Map<string, ConfigIntegration.Document>())
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const service = Test.of({
        entries: () =>
          Effect.all([Ref.get(integrations), Ref.get(entries)]).pipe(
            Effect.map(([documents, entries]) => [...documents.values(), ...entries]),
          ),
        compatibility: () => Effect.succeed(compatibility),
        changes: () => Stream.fromPubSub(updates),
        setEntries: (next) => Ref.set(entries, next),
        emitChange: (update) => PubSub.publish(updates, update).pipe(Effect.asVoid),
        integration: (integrationID, document) =>
          Ref.update(integrations, (current) => {
            // Like config, keeps the document it holds when handed a deep-equal one.
            if (isDeepStrictEqual(current.get(integrationID), document)) return current
            const next = new Map(current)
            next.delete(integrationID)
            return document ? next.set(integrationID, document) : next
          }),
      })
      return Context.empty().pipe(Context.add(Service, service), Context.add(Test, service))
    }),
  )

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const bus = yield* Bus.Service
      const credentials = yield* Credential.Service
      const globalService = yield* Global.Service
      const wellknown = yield* WellKnown.Service
      const processes = yield* AppProcess.Service
      const integrations = new Map<string, ConfigIntegration.Document>()
      // Integrations set their documents from outside this layer, so their reloads run with its services.
      const context = yield* Effect.context<FSUtil.Service | Global.Service | Location.Service>()
      const reloadLock = Semaphore.makeUnsafe(1)
      const updateLock = Semaphore.makeUnsafe(1)
      const decodeOptions = { errors: "all", onExcessProperty: "ignore" } as const
      const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
      const parseInfo = Effect.fn("Config.parseInfo")(function* (text: string, source: string) {
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) {
          yield* Effect.logWarning("configuration normalization diagnostic", {
            source,
            path: "$",
            kind: "invalid",
            action: "rejected malformed JSON or JSONC document",
          })
          return
        }
        const result = ConfigNormalize.normalize(input)
        // Every reload repeats the routine notes on a config that loads. A rejected config or a dropped malformed
        // setting is the user's to fix, so those stay warnings.
        yield* Effect.forEach(result.diagnostics, (diagnostic) => {
          const log = result.type === "rejected" || diagnostic.kind === "invalid" ? Effect.logWarning : Effect.logDebug
          return log("configuration normalization diagnostic", {
            source,
            path: diagnostic.path[0] === "$" ? "$" : `$.${diagnostic.path.join(".")}`,
            kind: diagnostic.kind,
            action: diagnostic.message,
          })
        })
        if (result.type === "rejected") return
        const info = Option.getOrUndefined(decodeInfo(result.encoded))
        if (info) return info
        yield* Effect.logWarning("configuration normalization diagnostic", {
          source,
          path: "$",
          kind: "invalid",
          action: "rejected canonical configuration after final validation",
        })
      })

      const loadFile = Effect.fnUntraced(function* (filepath: string) {
        const text = yield* fs.readFileStringSafe(filepath)
        if (text === undefined) return
        const substituted = yield* ConfigVariable.substitute({ type: "path", path: filepath, text })
        const info = yield* parseInfo(substituted, filepath)
        if (!info) return
        return new Document({ type: "document", path: AbsolutePath.make(filepath), info })
      })

      const loadWellknownEntry = Effect.fnUntraced(function* (entry: WellKnown.Entry) {
        const auth = entry.manifest.auth
        const credential = (yield* credentials.list(entry.integrationID)).at(-1)
        const variables = auth && credential?.value.type === "key" ? { [auth.env]: credential.value.key } : undefined
        // Logging out drops the saved remote config, so the source supplies nothing until a fresh fetch succeeds.
        if (!variables) return yield* wellknown.clearCached(entry.origin).pipe(Effect.as([]))
        // A failed refresh keeps the last resolved config so remote providers and allowlists do not disappear.
        const configs = yield* wellknown.resolve(entry, variables).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to load wellknown config", { source: entry.origin, error }).pipe(
              Effect.andThen(wellknown.cached(entry.origin)),
            ),
          ),
        )
        return yield* Effect.forEach(configs, (config) =>
          ConfigVariable.substitute({
            type: "virtual",
            source: entry.origin,
            dir: entry.origin,
            text: JSON.stringify(config),
            env: variables,
          }).pipe(
            Effect.flatMap((text) => parseInfo(text, entry.origin)),
            Effect.map((info) =>
              info
                ? new ConfigIntegration.WellKnownDocument({
                    type: "document",
                    info,
                    integrationID: entry.integrationID,
                  })
                : undefined,
            ),
          ),
        ).pipe(Effect.map((documents) => documents.filter((document) => document !== undefined)))
      })

      const loadWellknown = Effect.fn("Config.loadWellknown")(function* () {
        const entries = yield* wellknown
          .entries()
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to discover wellknown config", { error }).pipe(Effect.as([] as const)),
            ),
          )
        return yield* Effect.forEach(entries, (entry) =>
          loadWellknownEntry(entry).pipe(
            Effect.map((documents) => ({ integrationID: entry.integrationID, documents })),
          ),
        )
      })

      // `integration.use` decides whether an integration may supply anything. Only managed policies can withhold the
      // documents an integration delivers, so a project file can never strip the Console document carrying org policy.
      // A withheld document keeps its policies, so denying an integration never lifts the restrictions it carries.
      const supplies = Effect.fnUntraced(function* (
        lockdown: ReturnType<typeof ManagedPolicy.statements>,
        integrationID: string,
        connection?: Connection.Info,
      ) {
        const stored =
          connection?.type === "credential" ? yield* credentials.get(Credential.ID.make(connection.id)) : undefined
        const resource = ManagedPolicy.integrationResource(
          integrationID,
          stored ? ManagedPolicy.account(stored.value) : undefined,
        )
        return ManagedPolicy.decision(lockdown, "integration.use", resource) !== "deny"
      })

      const loadPreferences = Effect.fn("Config.loadPreferences")(function* (plist: AbsolutePath) {
        const result = yield* processes
          .run(ChildProcess.make("plutil", ["-convert", "json", "-o", "-", plist], { stdin: "ignore" }), {
            timeout: "10 seconds",
          })
          .pipe(Effect.flatMap(AppProcess.requireSuccess), Effect.option)
        if (Option.isNone(result)) {
          yield* Effect.logWarning("failed to convert managed preferences", { source: plist })
          return []
        }
        const text = yield* ConfigVariable.substitute({
          type: "virtual",
          source: plist,
          dir: path.dirname(plist),
          text: ConfigDiscovery.stripPreferenceMetadata(result.value.stdout.toString()),
        })
        const info = yield* parseInfo(text, plist)
        return info ? [new Document({ type: "document", path: plist, info })] : []
      })

      const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
        return [
          ...(yield* Effect.forEach(ConfigDiscovery.names, (file) => loadFile(path.join(directory, file))).pipe(
            Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
          )),
          new Directory({ type: "directory", path: directory }),
        ]
      })

      const load = Effect.fn("Config.load")(function* (sources: ConfigDiscovery.Sources) {
        const direct = yield* Effect.forEach(sources.direct, (filepath) => loadFile(filepath)).pipe(
          Effect.orDie,
          Effect.map((entries) => entries.filter((entry): entry is Document => entry !== undefined)),
        )

        const explicit = sources.explicit
          ? yield* loadFile(sources.explicit).pipe(
              Effect.map((config) => (config ? [config] : [])),
              Effect.orDie,
            )
          : []
        const content =
          options?.content !== undefined
            ? yield* ConfigVariable.substitute({
                type: "virtual",
                source: "OPENCODE_CONFIG_CONTENT",
                dir: location.directory,
                text: options.content,
              }).pipe(
                Effect.flatMap((text) => parseInfo(text, "OPENCODE_CONFIG_CONTENT")),
                Effect.map((info) => (info ? [new Document({ type: "document", info })] : [])),
                Effect.orDie,
              )
            : []

        // Managed settings load last so they override everything, and MDM
        // preferences outrank the system directory as in V1. Policies evaluate
        // in reverse load order, so managed policies split off and load first
        // to keep final file-based authority.
        const managed = [
          ...(sources.system?.present ? yield* loadDirectory(sources.system.path).pipe(Effect.orDie) : []),
          ...(sources.preferences ? yield* loadPreferences(sources.preferences).pipe(Effect.orDie) : []),
        ]
        const managedPolicies = managed
          .flatMap((entry) =>
            entry.type === "document" && entry.info.policies
              ? [
                  new ConfigManaged.Document({
                    type: "document",
                    path: entry.path,
                    info: new Info({ policies: entry.info.policies }),
                  }),
                ]
              : [],
          )
          .toReversed()
        const managedSettings = managed.map((entry) =>
          entry.type === "document"
            ? new ConfigManaged.Document({ ...entry, info: new Info({ ...entry.info, policies: undefined }) })
            : entry,
        )
        // Integration documents load right after managed policies: every remote, user, and project layer overrides
        // their settings, and since policies evaluate earliest-loaded first, only managed policies outrank theirs.
        // Global entries sit below explicit and direct files; project directories rank above them.
        const globalSupplementary = sources.global ? yield* loadDirectory(sources.global).pipe(Effect.orDie) : []
        const projectSupplementary = yield* Effect.forEach(
          sources.project.filter((root) => root.present),
          (root) => loadDirectory(root.path),
        ).pipe(
          Effect.orDie,
          Effect.map((entries) => entries.flat()),
        )
        const lockdown = ManagedPolicy.statements(managedPolicies)
        const integrated = yield* Effect.forEach(integrations.values(), (document) =>
          supplies(lockdown, document.integrationID, document.connection).pipe(
            Effect.map((allowed) =>
              allowed
                ? document
                : new ConfigIntegration.Document({ ...document, info: new Info({ policies: document.info.policies }) }),
            ),
          ),
        )
        const wellknownDocuments = yield* Effect.forEach(yield* loadWellknown().pipe(Effect.orDie), (entry) =>
          supplies(lockdown, entry.integrationID).pipe(
            Effect.map((allowed) =>
              allowed
                ? entry.documents
                : entry.documents.map(
                    (document) =>
                      new ConfigIntegration.WellKnownDocument({
                        ...document,
                        info: new Info({ policies: document.info.policies }),
                      }),
                  ),
            ),
          ),
        )
        return [
          ...managedPolicies,
          ...integrated,
          ...wellknownDocuments.flat(),
          ...globalSupplementary,
          ...explicit,
          ...direct,
          ...projectSupplementary,
          ...content,
          ...managedSettings,
        ]
      })

      const initial = yield* ConfigDiscovery.discover(options)
      let sources = initial
      let configs = yield* load(initial)
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const reloads = yield* PubSub.sliding<void>(1)
      // Readiness rescans recover writes made before a watch attached.
      const requestReload = PubSub.publish(reloads, undefined).pipe(Effect.asVoid)
      const watched = yield* FiberMap.make<string>()
      const reconcile = Effect.fn("Config.reconcileWatches")(function* (sources: ConfigDiscovery.Sources) {
        const plan = ConfigWatch.plan(sources)
        for (const key of Array.from(watched, ([key]) => key)) {
          if (!plan.has(key)) yield* FiberMap.remove(watched, key)
        }
        for (const [key, target] of plan) {
          yield* watcher
            .subscribe(target, requestReload)
            .pipe(
              Effect.flatMap(
                Stream.runForEach((update) => PubSub.publish(updates, update).pipe(Effect.andThen(requestReload))),
              ),
              FiberMap.run(watched, key, { onlyIfMissing: true, startImmediately: true }),
            )
        }
      })

      const reload = Effect.fn("Config.reload")(
        function* () {
          const discovered = yield* ConfigDiscovery.discover(options)
          const next = yield* load(discovered)
          yield* reconcile(discovered)
          const compatibilityChanged =
            !isDeepStrictEqual(sources.claude, discovered.claude) ||
            !isDeepStrictEqual(sources.agents, discovered.agents)
          if (isDeepStrictEqual(configs, next) && !compatibilityChanged) return
          sources = discovered
          configs = next
          yield* bus.publish(Event.Updated, {})
        },
        (effect) => reloadLock.withPermit(effect),
      )

      // Subscribe eagerly so synchronous watch readiness isn't dropped.
      const pendingReloads = yield* PubSub.subscribe(reloads)
      yield* Stream.fromSubscription(pendingReloads).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus.subscribe(Credential.Event.Switched).pipe(
        Stream.filterEffect((event) =>
          wellknown.entries().pipe(
            Effect.map((entries) => entries.some((entry) => entry.integrationID === event.data.integrationID)),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus.subscribe(WellKnown.Event.Updated).pipe(
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown sources", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Effect.sleep("10 minutes").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (!wellknown.snapshot().length) return Effect.void
            return Effect.gen(function* () {
              const changed = yield* wellknown
                .refresh()
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to refresh wellknown manifests", { error }).pipe(Effect.as(false)),
                  ),
                )
              if (!changed) yield* reload()
            }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to refresh wellknown config", { cause })))
          }),
        ),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* reloadLock.withPermit(reconcile(initial))

      const globalConfigFile = Effect.fnUntraced(function* () {
        const directory = initial.global ?? AbsolutePath.make(globalService.config)
        const candidates = ConfigDiscovery.names.map((name) => path.join(directory, name))
        return (yield* Effect.filter(candidates, fs.isFile)).at(-1) ?? path.join(directory, "opencode.jsonc")
      })

      const editGlobalConfig = Effect.fnUntraced(function* (
        method: string,
        mutate: (text: string, parsed: Record<string, unknown>) => string,
      ) {
        const filepath = yield* globalConfigFile()
        const text = (yield* fs.readFileStringSafe(filepath)) ?? "{}\n"
        const updated = yield* Effect.try({
          try: () => {
            const errors: ParseError[] = []
            const raw: unknown = parse(text, errors, { allowTrailingComma: true })
            const parsed =
              raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
            return mutate(text, parsed)
          },
          catch: (cause) => new FSUtil.FileSystemError({ method, cause }),
        })
        yield* fs.writeWithDirs(filepath, updated.endsWith("\n") ? updated : `${updated}\n`)
        yield* reload().pipe(
          Effect.provide(context),
          Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause })),
        )
      })

      const update = Effect.fn("Config.update")(
        function* (patch: Patch) {
          yield* editGlobalConfig("config.update", (text) =>
            applyEdits(
              text,
              modify(text, ["shell"], patch.shell ?? undefined, {
                formattingOptions: { tabSize: 2, insertSpaces: true },
              }),
            ),
          )
        },
        (effect) => updateLock.withPermit(effect),
      )

      const saveProvider = Effect.fn("Config.saveProvider")(
        function* (providerID: string, save: ProviderSchema.ConfigSave) {
          yield* editGlobalConfig("config.saveProvider", (text, parsed) => {
            const providersRaw = parsed.providers
            const providersMap =
              providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)
                ? (providersRaw as Record<string, unknown>)
                : {}
            const existingRaw = providersMap[providerID]
            const existing =
              existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
                ? { ...(existingRaw as Record<string, unknown>) }
                : {}

            if (save.name !== undefined) {
              if (save.name.trim()) existing.name = save.name.trim()
              else delete existing.name
            }
            if (save.package !== undefined) {
              if (save.package.trim()) existing.package = save.package.trim()
              else delete existing.package
            }

            const prevSettings =
              existing.settings && typeof existing.settings === "object" && !Array.isArray(existing.settings)
                ? { ...(existing.settings as Record<string, unknown>) }
                : {}
            if (save.baseURL === null) {
              delete prevSettings.baseURL
            } else if (typeof save.baseURL === "string") {
              if (save.baseURL.trim()) prevSettings.baseURL = save.baseURL.trim()
              else delete prevSettings.baseURL
            }
            if (save.apiKey === null) {
              delete prevSettings.apiKey
            }
            if (Object.keys(prevSettings).length > 0) existing.settings = prevSettings
            else delete existing.settings

            if (save.headers === null) {
              delete existing.headers
            } else if (save.headers !== undefined) {
              const cleaned = Object.fromEntries(
                Object.entries(save.headers).filter(([k, v]) => k.trim() && v !== undefined),
              )
              if (Object.keys(cleaned).length > 0) existing.headers = cleaned
              else delete existing.headers
            }

            if (save.models !== undefined) {
              const prevModels =
                !save.replaceModels &&
                existing.models &&
                typeof existing.models === "object" &&
                !Array.isArray(existing.models)
                  ? { ...(existing.models as Record<string, unknown>) }
                  : {}
              const existingModelsAll =
                existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
                  ? (existing.models as Record<string, unknown>)
                  : {}

              for (const model of save.models) {
                const id = model.id.trim()
                if (!id) continue
                const baseRaw = existingModelsAll[id]
                const entry =
                  baseRaw && typeof baseRaw === "object" && !Array.isArray(baseRaw)
                    ? { ...(baseRaw as Record<string, unknown>) }
                    : {}

                if (model.name !== undefined) {
                  if (model.name.trim()) entry.name = model.name.trim()
                  else delete entry.name
                }
                if (model.modelID !== undefined) {
                  if (model.modelID.trim()) entry.modelID = model.modelID.trim()
                  else delete entry.modelID
                }
                if (model.disabled !== undefined) {
                  if (model.disabled) entry.disabled = true
                  else delete entry.disabled
                }
                if (model.context !== undefined || model.output !== undefined) {
                  const prevLimit =
                    entry.limit && typeof entry.limit === "object" && !Array.isArray(entry.limit)
                      ? { ...(entry.limit as Record<string, unknown>) }
                      : {}
                  if (model.context !== undefined) {
                    if (model.context > 0) prevLimit.context = model.context
                    else delete prevLimit.context
                  }
                  if (model.output !== undefined) {
                    if (model.output > 0) prevLimit.output = model.output
                    else delete prevLimit.output
                  }
                  if (Object.keys(prevLimit).length > 0) entry.limit = prevLimit
                  else delete entry.limit
                }
                if (model.tools !== undefined || model.vision !== undefined || model.reasoning !== undefined) {
                  const prevCaps =
                    entry.capabilities && typeof entry.capabilities === "object" && !Array.isArray(entry.capabilities)
                      ? { ...(entry.capabilities as Record<string, unknown>) }
                      : {}
                  if (model.tools !== undefined) prevCaps.tools = model.tools
                  if (model.vision !== undefined) prevCaps.input = model.vision ? ["text", "image"] : ["text"]
                  if (model.reasoning !== undefined) {
                    prevCaps.reasoning = model.reasoning ? { supported: true, toggle: true } : { supported: false }
                  }
                  if (Object.keys(prevCaps).length > 0) entry.capabilities = prevCaps
                  else delete entry.capabilities
                }

                prevModels[id] = entry
              }

              if (Object.keys(prevModels).length > 0) existing.models = prevModels
              else delete existing.models
            }

            const value = Object.keys(existing).length > 0 ? existing : undefined
            return applyEdits(
              text,
              modify(text, ["providers", providerID], value, {
                formattingOptions: { tabSize: 2, insertSpaces: true },
              }),
            )
          })
        },
        (effect) => updateLock.withPermit(effect),
      )

      const removeProvider = Effect.fn("Config.removeProvider")(
        function* (providerID: string) {
          yield* editGlobalConfig("config.removeProvider", (text) =>
            applyEdits(
              text,
              modify(text, ["providers", providerID], undefined, {
                formattingOptions: { tabSize: 2, insertSpaces: true },
              }),
            ),
          )
        },
        (effect) => updateLock.withPermit(effect),
      )

      return Service.of({
        entries: Effect.fnUntraced(function* () {
          return configs
        }),
        compatibility: () =>
          Effect.all({
            claude: Effect.filter(sources.claude, fs.isDir),
            agents: Effect.filter(sources.agents, fs.isDir),
          }),
        changes: () => Stream.fromPubSub(updates),
        update,
        saveProvider,
        removeProvider,
        integration: Effect.fn("Config.integration")(function* (integrationID, document) {
          if (isDeepStrictEqual(integrations.get(integrationID), document)) return
          integrations.delete(integrationID)
          if (document) integrations.set(integrationID, document)
          yield* reload().pipe(
            Effect.provide(context),
            Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause })),
          )
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Watcher.node,
      Bus.node,
      FSUtil.node,
      Global.node,
      Location.node,
      Credential.node,
      WellKnown.node,
      AppProcess.node,
    ],
  })
}

export const node = configured()
