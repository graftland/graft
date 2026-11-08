import {
	Array,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Equal,
	FileSystem,
	Layer,
	Order,
	Path,
	Record,
	Ref,
	Schedule,
	Schema,
	String,
	type Scope,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert } from "@effect/vitest"

import { Graft, Kernel, Plugin } from "@graftland/graft"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { Loader, ModuleResolver } from "../src/index.ts"

export interface Journal {
	readonly events: Effect.Effect<ReadonlyArray<string>>
	readonly record: (event: string) => Effect.Effect<void>
	readonly expect: (
		expected: ReadonlyArray<string | ReadonlyArray<string>>,
	) => Effect.Effect<void>
	/** Waits (in real time) until the journal holds exactly these events, then asserts it. */
	readonly eventually: (expected: ReadonlyArray<string>) => Effect.Effect<void>
}

export const makeJournal = Effect.gen(function* () {
	const ref = yield* Ref.make<ReadonlyArray<string>>([])
	const journal: Journal = {
		events: Ref.get(ref),
		record: (event) => Ref.update(ref, Array.append(event)),
		expect: (expected) =>
			Effect.map(Ref.get(ref), (entries) => {
				const size = Array.reduce(expected, 0, (offset, group) => {
					const block = typeof group === "string" ? [group] : group
					assert.deepStrictEqual(
						Array.sort(
							Array.take(Array.drop(entries, offset), block.length),
							Order.String,
						),
						Array.sort(block, Order.String),
					)
					return offset + block.length
				})
				assert.lengthOf(entries, size)
			}),
		eventually: (expected) =>
			Ref.get(ref).pipe(
				Effect.filterOrFail((entries) => Equal.equals(entries, expected)),
				Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 60 }),
				Effect.ignore,
				Effect.andThen(Ref.get(ref)),
				Effect.map((entries) => assert.deepStrictEqual(entries, expected)),
			),
	}
	return journal
})

class JournalService extends Context.Service<JournalService, Journal>()(
	"@graftland/loader/test/utils/JournalService",
) {}
export class FixtureDirectory extends Context.Service<
	FixtureDirectory,
	string
>()("@graftland/loader/test/utils/FixtureDirectory") {}
const inspection = Kernel.layer({
	authority: "embedded-loader-test",
	maxUnits: 16,
	instances: [],
}).pipe(Layer.provide(Units.layer), Layer.provideMerge(NodeServices.layer))

/** Runs embedded composition evidence with real module files and a journal service. */
export const run = (
	modules: Readonly<Record<string, string>> = {},
	provider?: Layer.Layer<never>,
) =>
	Effect.fnUntraced(function* <A, E>(
		test: (
			journal: Journal,
		) => Effect.Effect<
			A,
			E,
			| Graft.Graft
			| Scope.Scope
			| FileSystem.FileSystem
			| Path.Path
			| FixtureDirectory
			| ModuleResolver.ModuleResolver
		>,
	) {
		return yield* Effect.gen(function* () {
			const journal = yield* makeJournal
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const cache = new URL("../.cache/embedded-fixtures", import.meta.url)
				.pathname
			yield* fs.makeDirectory(cache, { recursive: true })
			const base = yield* fs.makeTempDirectoryScoped({ directory: cache })
			const framework = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.String),
			)(new URL("../dist/index.js", import.meta.url).href)
			yield* fs.makeDirectory(path.join(base, "node_modules"))
			yield* fs.copy(
				new URL("./fixtures/echo", import.meta.url).pathname,
				path.join(base, "node_modules/echo"),
			)
			yield* Effect.forEach(
				Record.toEntries(modules),
				Effect.fnUntraced(function* ([name, directory]) {
					const target = path.join(base, "node_modules", name)
					yield* fs.copy(directory, target)
					const file = path.join(target, "index.mjs")
					const text = yield* fs.readFileString(file)
					yield* fs.writeFileString(
						file,
						String.replace('"@graftland/loader"', framework)(text),
					)
				}),
				{ discard: true },
			)
			const control = yield* Control.serve()
			const resolver = yield* ModuleResolver.make({ base, control })
			const environment = Layer.mergeAll(
				NodeServices.layer,
				Layer.succeed(FileSystem.FileSystem, {
					...fs,
					makeTempDirectoryScoped: (options) =>
						fs.makeTempDirectoryScoped({
							...options,
							directory: options?.directory ?? base,
						}),
				}),
				Layer.succeed(ModuleResolver.ModuleResolver, resolver),
				Layer.succeed(JournalService, journal),
				Layer.succeed(FixtureDirectory, base),
				provider ??
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({ GREETING: "hi" }),
					),
			)
			return yield* test(journal).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, environment)),
			)
		}).pipe(Effect.scoped, Effect.provide(inspection))
	})

export const fixture = (name: string): string =>
	new URL(`./fixtures/${name}`, import.meta.url).pathname

/** Gets the loader service published by a loader plugin. */
export const loaderService: Effect.Effect<
	(typeof Loader.Loader)["Service"],
	never,
	Graft.Graft | Scope.Scope
> = Effect.gen(function* () {
	const found = yield* Deferred.make<(typeof Loader.Loader)["Service"]>()
	const probe = Plugin.make({
		name: "probe",
		inject: [Loader.Loader],
		apply: () =>
			Effect.flatMap(Loader.Loader, (loader) =>
				Effect.asVoid(Deferred.succeed(found, loader)),
			),
	})
	yield* Graft.plugin(probe)
	return yield* Deferred.await(found)
})
