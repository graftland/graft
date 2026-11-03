import { assert } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array as Arr,
	ConfigProvider,
	Deferred,
	Effect,
	Equal,
	Layer,
	Ref,
	Schedule,
	Schema,
} from "effect"
import type { FileSystem, Path, Scope } from "effect"
import { Loader, ModuleResolver } from "../src/index.ts"

export interface Journal {
	readonly record: (event: string) => Effect.Effect<void>
	readonly expect: (expected: ReadonlyArray<string>) => Effect.Effect<void>
	/** Waits (in real time) until the journal holds exactly these events, then asserts it. */
	readonly eventually: (expected: ReadonlyArray<string>) => Effect.Effect<void>
}

/** A plugin that records when it starts and stops, and restarts on every config change. */
export const echo = (journal: Journal) =>
	Plugin.make({
		name: "echo",
		config: Schema.Struct({ text: Schema.String }),
		apply: ({ text }) =>
			Effect.acquireRelease(journal.record(`start ${text}`), () =>
				journal.record(`stop ${text}`),
			),
	})

export const makeJournal = Effect.gen(function* () {
	const ref = yield* Ref.make<ReadonlyArray<string>>([])
	const journal: Journal = {
		record: (event) => Ref.update(ref, Arr.append(event)),
		expect: (expected) =>
			Effect.map(Ref.get(ref), (entries) =>
				assert.deepStrictEqual(entries, expected),
			),
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

/** Runs a test in a graft whose environment has Node services, an env var and the given plugins. */
export const run =
	(plugins: (journal: Journal) => Readonly<Record<string, Plugin.Plugin>>) =>
	<A, E>(
		test: (
			journal: Journal,
		) => Effect.Effect<
			A,
			E,
			Graft.Graft | Scope.Scope | FileSystem.FileSystem | Path.Path
		>,
	) =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const environment = Layer.mergeAll(
				NodeServices.layer,
				ModuleResolver.fromRecord(plugins(journal)),
				ConfigProvider.layer(ConfigProvider.fromEnvRecord({ GREETING: "hi" })),
			)
			return yield* test(journal).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, environment)),
			)
		})

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
