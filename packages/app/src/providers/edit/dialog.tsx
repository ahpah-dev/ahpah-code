import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import type { ProviderConfigModel, ProviderFetchedModel } from "@opencode/client/promise"
import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { useGlobal } from "@/runtime/server/runtime"
import { showToast } from "@/shell/notifications/toast"
import {
  fetchedToConfigModel,
  formatTokenLimit,
  isValidProviderID,
  mergeFetchedModels,
  PROVIDER_PACKAGE_OPTIONS,
  slugifyProviderID,
  type ProviderPackageOption,
} from "./model"

export const DialogEditProvider: Component<{
  providerID?: string
  directory?: string
  defaultLocation?: boolean
  autoFetch?: boolean
  onSaved?: (providerID: string) => void
  onRemoved?: (providerID: string) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const data = useData()
  const global = useGlobal()

  const isNew = !props.providerID
  const location = !props.defaultLocation && props.directory ? { directory: props.directory } : undefined

  const [loading, setLoading] = createSignal(!isNew)
  const [saving, setSaving] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const [fetching, setFetching] = createSignal(false)

  const [providerID, setProviderID] = createSignal(props.providerID ?? "")
  const [idEdited, setIdEdited] = createSignal(!isNew)
  const [name, setName] = createSignal("")
  const [pkg, setPkg] = createSignal<string>(PROVIDER_PACKAGE_OPTIONS[0].id)
  const [baseURL, setBaseURL] = createSignal("")
  const [defaultBaseURL, setDefaultBaseURL] = createSignal<string | undefined>(undefined)
  const [apiKey, setApiKey] = createSignal("")
  const [hasCredential, setHasCredential] = createSignal(false)
  const [hasConfig, setHasConfig] = createSignal(false)
  const [models, setModels] = createSignal<ProviderConfigModel[]>([])

  const [fetchError, setFetchError] = createSignal<string | undefined>(undefined)
  const [fetchedEndpoint, setFetchedEndpoint] = createSignal<string | undefined>(undefined)
  const [fetchedModels, setFetchedModels] = createSignal<ProviderFetchedModel[]>([])
  const [fetchedFilter, setFetchedFilter] = createSignal("")
  const [selectedFetched, setSelectedFetched] = createSignal<Record<string, boolean>>({})

  const [newModelID, setNewModelID] = createSignal("")
  const [newModelName, setNewModelName] = createSignal("")
  const [newModelContext, setNewModelContext] = createSignal("")
  const [newModelTools, setNewModelTools] = createSignal(true)
  const [newModelVision, setNewModelVision] = createSignal(false)
  const [newModelReasoning, setNewModelReasoning] = createSignal(false)

  const [error, setError] = createSignal<string | undefined>(undefined)

  const packageOptions = createMemo<ProviderPackageOption[]>(() => {
    const current = pkg().trim()

    if (!current || PROVIDER_PACKAGE_OPTIONS.some((opt) => opt.id === current)) {
      return [...PROVIDER_PACKAGE_OPTIONS]
    }

    return [{ id: current, label: current }, ...PROVIDER_PACKAGE_OPTIONS]
  })

  const configuredModelIDs = createMemo(() => new Set(models().map((m) => m.id)))

  const catalogModelCount = createMemo(() => {
    const id = providerID().trim()

    if (!id || isNew) return 0

    const all = (data.location.model.list(location) ?? []).filter((m) => m.providerID === id)
    const configured = configuredModelIDs()

    return all.filter((m) => !configured.has(m.id)).length
  })

  const filteredFetched = createMemo(() => {
    const query = fetchedFilter().trim().toLowerCase()
    const items = fetchedModels()

    if (!query) return items

    return items.filter((item) => `${item.id} ${item.name ?? ""}`.toLowerCase().includes(query))
  })

  const selectedFetchedList = createMemo(() => fetchedModels().filter((item) => !!selectedFetched()[item.id]))

  const syncCatalogs = async () => {
    data.location.integration.invalidate(location)
    data.location.provider.invalidate(location)
    data.location.model.invalidate(location)
    await Promise.all([
      data.location.integration.sync(location),
      data.location.provider.sync(location),
      data.location.model.sync(location),
    ])
  }

  const runFetchModels = async (overrideURL?: string) => {
    const url = (overrideURL ?? baseURL()).trim() || defaultBaseURL()?.trim() || ""

    if (!url) {
      setFetchError(language.t("provider.edit.fetch.missingUrl"))

      return
    }

    setFetching(true)
    setFetchError(undefined)

    try {
      const response = await serverSDK.api.config.fetchProviderModels({
        location,
        providerID: providerID().trim() || undefined,
        baseURL: url,
        apiKey: apiKey().trim() || undefined,
        package: pkg().trim() || undefined,
      })

      const fetched = [...response.data.models]
      setFetchedModels(fetched)
      setFetchedEndpoint(response.data.endpoint)
      const existing = configuredModelIDs()
      const nextSelected: Record<string, boolean> = {}

      for (const item of fetched) {
        if (!existing.has(item.id)) nextSelected[item.id] = true
      }

      setSelectedFetched(nextSelected)

      if (fetched.length === 0) {
        setFetchError(language.t("provider.edit.fetch.empty"))
      }
    } catch (err) {
      setFetchError(formatServerError(err, language.t))
    } finally {
      setFetching(false)
    }
  }

  onMount(() => {
    if (isNew || !props.providerID) return

    const id = props.providerID
    void serverSDK.api.config
      .getProvider({ providerID: id, location })
      .then((res) => {
        const cfg = res.data
        setName(cfg.name)
        setPkg(cfg.package || PROVIDER_PACKAGE_OPTIONS[0].id)
        setBaseURL(cfg.baseURL ?? "")
        setDefaultBaseURL(cfg.defaultBaseURL)
        setHasCredential(cfg.hasCredential)
        setHasConfig(cfg.hasConfig)
        setModels([...cfg.models])

        if (props.autoFetch && (cfg.baseURL || cfg.defaultBaseURL)) {
          void runFetchModels(cfg.baseURL ?? cfg.defaultBaseURL)
        }
      })
      .catch((err) => {
        setError(formatServerError(err, language.t))
      })
      .finally(() => {
        setLoading(false)
      })
  })

  const addSelectedFetched = () => {
    const chosen = selectedFetchedList()

    if (chosen.length === 0) return

    setModels((prev) => mergeFetchedModels(prev, chosen))
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.edit.fetch.addedTitle", { count: chosen.length }),
    })
    setFetchedModels([])
    setSelectedFetched({})
    setFetchedFilter("")
  }

  const addManualModel = () => {
    const id = newModelID().trim()

    if (!id) return

    const contextNum = Number(newModelContext().trim())

    const entry: ProviderConfigModel = {
      id,
      name: newModelName().trim() || undefined,
      context: Number.isFinite(contextNum) && contextNum > 0 ? Math.floor(contextNum) : undefined,
      tools: newModelTools(),
      vision: newModelVision(),
      reasoning: newModelReasoning(),
    }

    setModels((prev) => {
      const idx = prev.findIndex((item) => item.id === id)

      if (idx === -1) return [...prev, entry]

      const next = [...prev]
      next[idx] = { ...next[idx], ...entry }

      return next
    })
    setNewModelID("")
    setNewModelName("")
    setNewModelContext("")
  }

  const updateModel = (id: string, patch: Partial<ProviderConfigModel>) => {
    setModels((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const removeModel = (id: string) => {
    setModels((prev) => prev.filter((item) => item.id !== id))
  }

  const save = async () => {
    const id = providerID().trim()

    if (!id) {
      setError(language.t("provider.edit.error.idRequired"))

      return
    }

    if (!isValidProviderID(id)) {
      setError(language.t("provider.edit.error.idInvalid"))

      return
    }

    setSaving(true)
    setError(undefined)

    try {
      await serverSDK.api.config.saveProvider({
        providerID: id,
        location,
        name: name().trim() || id,
        package: pkg().trim() || PROVIDER_PACKAGE_OPTIONS[0].id,
        baseURL: baseURL().trim() ? baseURL().trim() : null,
        apiKey: apiKey().trim() ? apiKey().trim() : undefined,
        models: models(),
        replaceModels: true,
      })
      await syncCatalogs()

      if (models().length > 0) {
        global.models.show(models().map((m) => ({ providerID: id, modelID: m.id })))
      }

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.edit.toast.saved.title", { provider: name().trim() || id }),
        description: language.t("provider.edit.toast.saved.description"),
      })
      props.onSaved?.(id)
      dialog.close()
    } catch (err) {
      setError(formatServerError(err, language.t))
    } finally {
      setSaving(false)
    }
  }

  const removeConfig = async () => {
    const id = providerID().trim()

    if (!id) return

    setRemoving(true)
    setError(undefined)

    try {
      await serverSDK.api.config.removeProvider({ providerID: id, location })
      await syncCatalogs()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.edit.toast.removed.title", { provider: name().trim() || id }),
      })
      props.onRemoved?.(id)
      dialog.close()
    } catch (err) {
      setError(formatServerError(err, language.t))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Dialog size="large" variant="settings">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={
            isNew
              ? language.t("provider.edit.title.add")
              : language.t("provider.edit.title.edit", { provider: name() || providerID() })
          }
          description={language.t("provider.edit.description")}
        />
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-2">
        <Show
          when={!loading()}
          fallback={
            <div class="flex flex-1 items-center justify-center gap-2 py-8 text-[13px] text-v2-text-text-muted">
              <Loader class="size-4 shrink-0" />
              <span>{language.t("common.loading")}</span>
            </div>
          }
        >
          <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pe-1">
            <Show when={error()}>
              {(message) => (
                <div
                  role="alert"
                  class="flex items-start gap-2 rounded-sm border border-v2-state-border-danger bg-v2-state-bg-danger px-3 py-2 text-[12px] text-v2-state-fg-danger"
                >
                  <Icon name="circle-ban-sign" size="small" class="mt-0.5 shrink-0" />
                  <span>{message()}</span>
                </div>
              )}
            </Show>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1.5 text-[12px] font-[530] text-v2-text-text-base">
                <span>{language.t("provider.edit.field.name")}</span>
                <TextInput
                  appearance="base"
                  class="!w-full"
                  placeholder={language.t("provider.edit.field.namePlaceholder")}
                  value={name()}
                  onInput={(event) => {
                    const value = event.currentTarget.value
                    setName(value)

                    if (isNew && !idEdited()) setProviderID(slugifyProviderID(value))
                  }}
                />
              </label>

              <label class="flex flex-col gap-1.5 text-[12px] font-[530] text-v2-text-text-base">
                <span>{language.t("provider.edit.field.id")}</span>
                <TextInput
                  appearance="base"
                  class="!w-full"
                  placeholder="my-provider"
                  value={providerID()}
                  readOnly={!isNew}
                  disabled={!isNew}
                  spellcheck={false}
                  onInput={(event) => {
                    setIdEdited(true)
                    setProviderID(event.currentTarget.value)
                  }}
                />
              </label>
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1.5 text-[12px] font-[530] text-v2-text-text-base">
                <span>{language.t("provider.edit.field.sdk")}</span>
                <Select
                  appearance="base"
                  surface="base"
                  class="!w-full"
                  options={packageOptions()}
                  current={packageOptions().find((opt) => opt.id === pkg()) ?? packageOptions()[0]}
                  value={(opt) => opt.id}
                  label={(opt) => opt.label}
                  onSelect={(opt) => opt && setPkg(opt.id)}
                />
              </label>

              <label class="flex flex-col gap-1.5 text-[12px] font-[530] text-v2-text-text-base">
                <span>{language.t("provider.edit.field.apiKey")}</span>
                <TextInput
                  appearance="base"
                  type="password"
                  class="!w-full"
                  placeholder={
                    hasCredential()
                      ? language.t("provider.edit.field.apiKeySavedPlaceholder")
                      : language.t("provider.edit.field.apiKeyPlaceholder")
                  }
                  value={apiKey()}
                  autocomplete="off"
                  spellcheck={false}
                  onInput={(event) => setApiKey(event.currentTarget.value)}
                />
              </label>
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-[12px] font-[530] text-v2-text-text-base">
                {language.t("provider.edit.field.baseUrl")}
              </label>
              <div class="flex items-center gap-2">
                <TextInput
                  appearance="base"
                  class="min-w-0 flex-1"
                  placeholder={defaultBaseURL() ?? "https://api.example.com/v1"}
                  value={baseURL()}
                  spellcheck={false}
                  onInput={(event) => setBaseURL(event.currentTarget.value)}
                />
                <Button
                  type="button"
                  variant="neutral"
                  size="normal"
                  disabled={fetching()}
                  aria-busy={fetching()}
                  onClick={() => void runFetchModels()}
                >
                  <Show when={fetching()} fallback={<Icon name="refresh" size="small" />}>
                    <Loader class="size-3.5 shrink-0" />
                  </Show>
                  <span>
                    {fetching() ? language.t("provider.edit.fetch.loading") : language.t("provider.edit.fetch.button")}
                  </span>
                </Button>
              </div>
              <Show when={defaultBaseURL() && !baseURL().trim()}>
                <span class="text-[11px] text-v2-text-text-faint">
                  {language.t("provider.edit.field.baseUrlDefault", { url: defaultBaseURL()! })}
                </span>
              </Show>
            </div>

            <Show when={fetchError()}>
              {(msg) => (
                <div
                  role="alert"
                  class="flex items-start gap-2 rounded-sm border border-v2-state-border-danger bg-v2-state-bg-danger px-3 py-2 text-[12px] text-v2-state-fg-danger"
                >
                  <Icon name="circle-ban-sign" size="small" class="mt-0.5 shrink-0" />
                  <span>{msg()}</span>
                </div>
              )}
            </Show>

            <Show when={fetchedModels().length > 0}>
              <div class="flex flex-col gap-2 rounded-sm border border-v2-border-border-base bg-v2-background-bg-base p-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <span class="text-[12px] font-[530] text-v2-text-text-base">
                      {language.t("provider.edit.fetch.results", { count: fetchedModels().length })}
                    </span>
                    <Show when={fetchedEndpoint()}>
                      {(ep) => <Badge>{ep()}</Badge>}
                    </Show>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="small"
                      variant="ghost-muted"
                      onClick={() => {
                        const next: Record<string, boolean> = {}
                        fetchedModels().forEach((m) => (next[m.id] = true))
                        setSelectedFetched(next)
                      }}
                    >
                      {language.t("provider.edit.fetch.selectAll")}
                    </Button>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost-muted"
                      onClick={() => {
                        const existing = configuredModelIDs()
                        const next: Record<string, boolean> = {}
                        fetchedModels().forEach((m) => {
                          if (!existing.has(m.id)) next[m.id] = true
                        })
                        setSelectedFetched(next)
                      }}
                    >
                      {language.t("provider.edit.fetch.selectNew")}
                    </Button>
                    <Button type="button" size="small" variant="ghost-muted" onClick={() => setSelectedFetched({})}>
                      {language.t("common.clear")}
                    </Button>
                  </div>
                </div>

                <TextInput
                  type="search"
                  appearance="small"
                  class="!w-full"
                  leadingIcon={<Icon name="magnifying-glass" size="small" />}
                  placeholder={language.t("provider.edit.fetch.searchPlaceholder")}
                  value={fetchedFilter()}
                  onInput={(event) => setFetchedFilter(event.currentTarget.value)}
                />

                <div class="flex max-h-44 flex-col gap-1 overflow-y-auto pe-1">
                  <For each={filteredFetched()}>
                    {(item) => {
                      const alreadyAdded = () => configuredModelIDs().has(item.id)
                      const limitLabel = () => formatTokenLimit(item.context)

                      return (
                        <div class="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-v2-overlay-simple-overlay-hover">
                          <Checkbox
                            appearance="compact"
                            checked={!!selectedFetched()[item.id]}
                            onChange={(checked) => setSelectedFetched((prev) => ({ ...prev, [item.id]: checked }))}
                          >
                            <span class="font-mono text-[12px] text-v2-text-text-base">{item.id}</span>
                          </Checkbox>
                          <div class="flex shrink-0 items-center gap-1.5">
                            <Show when={limitLabel()}>{(label) => <Badge>{label()}</Badge>}</Show>
                            <Show when={alreadyAdded()}>
                              <Badge>{language.t("provider.edit.fetch.alreadyAdded")}</Badge>
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>

                <div class="flex items-center justify-end gap-2 pt-1">
                  <Button type="button" size="small" variant="ghost" onClick={() => setFetchedModels([])}>
                    {language.t("common.cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="contrast"
                    disabled={selectedFetchedList().length === 0}
                    onClick={addSelectedFetched}
                  >
                    {language.t("provider.edit.fetch.addSelected", { count: selectedFetchedList().length })}
                  </Button>
                </div>
              </div>
            </Show>

            <div class="flex flex-col gap-2 rounded-sm border border-v2-border-border-base bg-v2-background-bg-base p-3">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="text-[12px] font-[530] text-v2-text-text-base">
                    {language.t("provider.edit.models.title")}
                  </span>
                  <Badge>{models().length}</Badge>
                </div>
                <Show when={catalogModelCount() > 0}>
                  <span class="text-[11px] text-v2-text-text-faint">
                    {language.t("provider.edit.models.catalogHint", { count: catalogModelCount() })}
                  </span>
                </Show>
              </div>

              <form
                class="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  addManualModel()
                }}
              >
                <TextInput
                  appearance="small"
                  class="min-w-[160px] flex-1"
                  placeholder={language.t("provider.edit.models.idPlaceholder")}
                  value={newModelID()}
                  spellcheck={false}
                  onInput={(event) => setNewModelID(event.currentTarget.value)}
                />
                <TextInput
                  appearance="small"
                  class="min-w-[130px] flex-1"
                  placeholder={language.t("provider.edit.models.namePlaceholder")}
                  value={newModelName()}
                  onInput={(event) => setNewModelName(event.currentTarget.value)}
                />
                <TextInput
                  appearance="small"
                  class="w-[92px]"
                  inputMode="numeric"
                  placeholder={language.t("provider.edit.models.contextPlaceholder")}
                  value={newModelContext()}
                  onInput={(event) => setNewModelContext(event.currentTarget.value)}
                />
                <div class="flex items-center gap-2">
                  <Checkbox appearance="compact" checked={newModelTools()} onChange={setNewModelTools}>
                    <span class="text-[11px]">{language.t("provider.edit.models.tools")}</span>
                  </Checkbox>
                  <Checkbox appearance="compact" checked={newModelVision()} onChange={setNewModelVision}>
                    <span class="text-[11px]">{language.t("provider.edit.models.vision")}</span>
                  </Checkbox>
                  <Checkbox appearance="compact" checked={newModelReasoning()} onChange={setNewModelReasoning}>
                    <span class="text-[11px]">{language.t("provider.edit.models.reasoning")}</span>
                  </Checkbox>
                </div>
                <Button type="submit" size="small" variant="neutral" icon="plus" disabled={!newModelID().trim()}>
                  {language.t("provider.edit.models.add")}
                </Button>
              </form>

              <Show
                when={models().length > 0}
                fallback={
                  <div class="py-3 text-center text-[12px] text-v2-text-text-faint">
                    {language.t("provider.edit.models.empty")}
                  </div>
                }
              >
                <div class="flex flex-col divide-y divide-v2-border-border-muted">
                  <For each={models()}>
                    {(model) => (
                      <div class="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span class="truncate font-mono text-[12px] font-[530] text-v2-text-text-base">
                            {model.id}
                          </span>
                          <Show when={model.name && model.name !== model.id}>
                            <span class="truncate text-[11px] text-v2-text-text-muted">{model.name}</span>
                          </Show>
                        </div>
                        <div class="flex shrink-0 flex-wrap items-center gap-2">
                          <Show when={formatTokenLimit(model.context)}>
                            {(limit) => <Badge>{limit()}</Badge>}
                          </Show>
                          <Checkbox
                            appearance="compact"
                            checked={model.tools ?? true}
                            onChange={(checked) => updateModel(model.id, { tools: checked })}
                          >
                            <span class="text-[11px]">{language.t("provider.edit.models.tools")}</span>
                          </Checkbox>
                          <Checkbox
                            appearance="compact"
                            checked={model.vision ?? false}
                            onChange={(checked) => updateModel(model.id, { vision: checked })}
                          >
                            <span class="text-[11px]">{language.t("provider.edit.models.vision")}</span>
                          </Checkbox>
                          <Checkbox
                            appearance="compact"
                            checked={model.reasoning ?? false}
                            onChange={(checked) => updateModel(model.id, { reasoning: checked })}
                          >
                            <span class="text-[11px]">{language.t("provider.edit.models.reasoning")}</span>
                          </Checkbox>
                          <IconButton
                            type="button"
                            size="small"
                            variant="ghost-muted"
                            icon={<Icon name="trash" size="small" />}
                            aria-label={language.t("provider.edit.models.remove", { model: model.id })}
                            onClick={() => removeModel(model.id)}
                          />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Show when={!isNew && hasConfig()}>
          <Button
            type="button"
            variant="danger"
            disabled={saving() || removing()}
            aria-busy={removing()}
            onClick={() => void removeConfig()}
          >
            {language.t("provider.edit.removeConfig")}
          </Button>
        </Show>
        <div class="ms-auto flex items-center gap-2">
          <Button type="button" variant="ghost" disabled={saving() || removing()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="contrast"
            disabled={loading() || saving() || removing()}
            aria-busy={saving()}
            onClick={() => void save()}
          >
            {saving() ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  )
}
