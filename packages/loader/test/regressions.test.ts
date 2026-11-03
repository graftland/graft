import { assert, describe, it } from "@effect/vitest"
import { Graft, Plugin } from "@nmnmcc/graft"
import { Effect, Exit, FileSystem, Layer, Path, Ref } from "effect"
import { Entry, Include, Loader, ModuleResolver } from "../src/index.ts"
import { echo, loaderService, makeJournal, run } from "./utils.ts"

/** What Node rejects with when an import cannot find a package or file. */
const notFound = (name: string) =>
	Object.assign(
		new Error(`Cannot find package '${name}' imported from /app/index.js`),
		{
			code: "ERR_MODULE_NOT_FOUND",
		},
	)

const resolverWith = (importer: (specifier: string) => Promise<unknown>) =>
	ModuleResolver.make({ base: "/app", importer }).pipe(
		Effect.provide(Path.layer),
	)

describe("module resolution", () => {
	it.effect(
		"tries the naming conventions even when the importer wraps the error",
		() =>
			Effect.gen(function* () {
				const plugin = Plugin.make({ name: "review", apply: () => Effect.void })
				const resolver = yield* resolverWith((specifier) =>
					specifier === "graft-plugin-review"
						? Promise.resolve({ default: plugin })
						: Promise.reject(
								Object.assign(new Error("Importing failed"), {
									cause: notFound(specifier),
								}),
							),
				)
				const resolved = yield* resolver.resolve("review")
				assert.strictEqual(resolved, plugin)
			}),
	)

	it.effect("keeps the cause when a plugin's own dependency is missing", () =>
		Effect.gen(function* () {
			const resolver = yield* resolverWith(() =>
				Promise.reject(notFound("left-pad")),
			)
			const error = yield* Effect.flip(resolver.resolve("foo"))
			assert.strictEqual(error._tag, "ModuleInvalid")
		}),
	)
})

describe("recovery", () => {
	it.effect("loads an entry again once its environment variable is fixed", () =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{
						id: "e",
						name: "echo",
						config: { text: new Entry.Env({ name: "MISSING" }) },
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.update("e", { config: { text: "fixed" } })
				yield* loader.ready
				yield* journal.expect(["start fixed"])
			}),
		),
	)

	it.effect("retries entries whose plugin could not be found", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const available = yield* Ref.make(false)
			const resolver = Layer.succeed(ModuleResolver.ModuleResolver, {
				resolve: (name) =>
					Effect.flatMap(Ref.get(available), (ok) =>
						ok
							? Effect.succeed<Plugin.Plugin>(echo(journal))
							: Effect.fail(
									ModuleResolver.ModuleNotFound.make({
										plugin: name,
										tried: [name],
									}),
								),
					),
			})
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "e", name: "echo", config: { text: "late" } },
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* journal.expect([])
				yield* Ref.set(available, true)
				yield* loader.retry
				yield* loader.ready
				yield* journal.expect(["start late"])
			}).pipe(
				Effect.scoped,
				Effect.provide(Graft.layer.pipe(Layer.provide(resolver))),
			)
		}),
	)
})

describe("empty config files", () => {
	it.effect("creates the first entry in a file with only comments", () =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = path.join(directory, "graft.yml")
				yield* fs.writeFileString(file, "# Nothing yet\n")
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				yield* loader.ready
				const created = yield* Effect.exit(
					loader.create({ name: "echo", config: { text: "first" } }),
				)
				assert.isTrue(Exit.isSuccess(created))
				yield* loader.ready
				yield* journal.expect(["start first"])
				const text = yield* fs.readFileString(file)
				assert.include(text, "# Nothing yet")
				assert.include(text, "text: first")
			}),
		),
	)
})
