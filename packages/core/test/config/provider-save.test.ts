import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Credential } from "@opencode/core/credential"
import { WellKnown } from "@opencode/core/wellknown"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

function providerConfigLayer(directory: string, globalDirectory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  const built = AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
    Config.node.replace(Config.configured({ system: false })),
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
  return Layer.mergeAll(built, Watcher.testLayer)
}

describe("Config.saveProvider / removeProvider", () => {
  test("creates, updates baseURL/models while preserving jsonc comments, replaces models, and removes provider", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global")
    const projectDir = path.join(tmp.path, "project")
    await Promise.all([fs.mkdir(globalDir, { recursive: true }), fs.mkdir(projectDir, { recursive: true })])

    const configPath = path.join(globalDir, "opencode.jsonc")
    await fs.writeFile(
      configPath,
      `{\n  // Keep my comment\n  "providers": {}\n}\n`,
    )

    const layer = providerConfigLayer(projectDir, globalDir)

    await Effect.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.saveProvider!("my-vllm", {
          name: "My vLLM",
          package: "@opencode/ai/providers/openai-compatible",
          baseURL: "http://127.0.0.1:8000/v1",
          models: [{ id: "qwen-32b", name: "Qwen 32B", context: 65536, tools: true }],
        })

        const afterCreate = yield* Effect.promise(() => fs.readFile(configPath, "utf8"))
        expect(afterCreate).toContain("// Keep my comment")

        let saved = Config.latest(yield* cfg.entries(), "providers")?.["my-vllm"]
        expect(saved?.name).toBe("My vLLM")
        expect(saved?.package).toBe("@opencode/ai/providers/openai-compatible")
        expect(saved?.settings?.baseURL).toBe("http://127.0.0.1:8000/v1")
        expect(saved?.models?.["qwen-32b"]?.name).toBe("Qwen 32B")

        // Post-add edit: change baseURL and add a second model
        yield* cfg.saveProvider!("my-vllm", {
          baseURL: "http://127.0.0.1:9000/v1",
          models: [{ id: "deepseek-r1", reasoning: true }],
        })
        saved = Config.latest(yield* cfg.entries(), "providers")?.["my-vllm"]
        expect(saved?.settings?.baseURL).toBe("http://127.0.0.1:9000/v1")
        expect(Object.keys(saved?.models ?? {}).toSorted()).toEqual(["deepseek-r1", "qwen-32b"])

        // Replace models cleanly
        yield* cfg.saveProvider!("my-vllm", {
          replaceModels: true,
          models: [{ id: "llama-3.3-70b" }],
        })
        saved = Config.latest(yield* cfg.entries(), "providers")?.["my-vllm"]
        expect(Object.keys(saved?.models ?? {})).toEqual(["llama-3.3-70b"])

        // Remove provider override
        yield* cfg.removeProvider!("my-vllm")
        expect(Config.latest(yield* cfg.entries(), "providers")?.["my-vllm"]).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})
