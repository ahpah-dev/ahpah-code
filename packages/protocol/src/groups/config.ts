import { Config } from "@opencode/schema/config"
import { ConfigShell } from "@opencode/schema/config/shell"
import { Location } from "@opencode/schema/location"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.shells", "/api/config/shell", {
      success: Schema.Array(ConfigShell.Option),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "config.shells",
        summary: "List available shells",
        description: "Return shells available to terminal and agent execution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("config.update", "/api/experimental/config", {
      payload: Config.Patch,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.config.update",
        summary: "Update global configuration",
        description: "Patch supported fields in the highest-precedence global configuration document.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("config.fetchProviderModels", "/api/provider/fetch-models", {
      query: LocationQuery,
      payload: Provider.FetchModelsRequest,
      success: Location.response(Provider.FetchModelsResponse),
      error: [InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.fetchProviderModels",
          summary: "Fetch models from provider",
          description: "Query a provider base URL for its available models.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.getProvider", "/api/provider/:providerID/config", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(Provider.ConfigState),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.getProvider",
          summary: "Get provider configuration",
          description: "Retrieve the effective and persisted configuration for a provider.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("config.saveProvider", "/api/provider/:providerID/config", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      payload: Provider.ConfigSave,
      success: Location.response(Provider.ConfigState),
      error: [InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.saveProvider",
          summary: "Save provider configuration",
          description: "Persist provider settings and custom models into global configuration.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("config.removeProvider", "/api/provider/:providerID/config", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: [InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.removeProvider",
          summary: "Remove provider configuration",
          description: "Remove a provider override or custom provider from global configuration.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Location-scoped configuration routes." }))
