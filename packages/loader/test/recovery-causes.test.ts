import {
	Array,
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Loader, ModuleResolver } from "../src/index.ts"
import { atomicWrite } from "../src/internal/atomicWrite.ts"
import { loaderService, run } from "./utils.ts"

const missing = () =>
	Object.assign(
		new Error("Cannot find package 'demo' imported from /app/index.js"),
		{ code: "ERR_MODULE_NOT_FOUND" },
	)
const plugin = Plugin.make({ name: "fallback", apply: () => Effect.void })

it.effect.each(["failure", "defect", "interruption"])(
	"preserves an importer cleanup %s instead of trying a fallback",
	(kind) =>
		Effect.gen(function* () {
			const absent = missing()
			const cleanup = new Error("Importer cleanup failed")
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					Ref.update(calls, Array.append(name)).pipe(
						Effect.andThen(
							name === "demo"
								? Effect.acquireUseRelease(
										Effect.void,
										() => Effect.fail(absent),
										() =>
											kind === "failure"
												? Effect.fail(cleanup)
												: kind === "defect"
													? Effect.die(cleanup)
													: Effect.interrupt,
									)
								: Effect.succeed({ default: plugin }),
						),
					),
			})
			const exit = yield* Effect.exit(resolver.resolve("demo"))
			assert(Exit.isFailure(exit))
			assert.strictEqual(exit.cause.reasons.length, 2)
			const failures = Array.filter(exit.cause.reasons, Cause.isFailReason)
			assert.deepStrictEqual(
				Array.map(failures, (reason) =>
					reason.error._tag === "ModuleInvalid"
						? reason.error.cause
						: reason.error,
				),
				kind === "failure"
					? [absent, cleanup]
					: kind === "defect"
						? []
						: [absent],
			)
			if (kind === "defect")
				assert.deepStrictEqual(
					Array.map(
						Array.filter(exit.cause.reasons, Cause.isDieReason),
						(reason) => reason.defect,
					),
					[absent, cleanup],
				)
			assert.strictEqual(Cause.hasDies(exit.cause), kind === "defect")
			assert.strictEqual(
				Cause.hasInterrupts(exit.cause),
				kind === "interruption",
			)
			const attempted = yield* Ref.get(calls)
			assert.deepStrictEqual(attempted, ["demo"])
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect(
	"falls back after a lone missing candidate and successful cleanup",
	() =>
		Effect.gen(function* () {
			const released = yield* Ref.make(false)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					name === "demo"
						? Effect.acquireUseRelease(
								Effect.void,
								() => Effect.fail(missing()),
								() => Ref.set(released, true),
							)
						: Effect.succeed({ default: plugin }),
			})
			const resolved = yield* resolver.resolve("demo")
			const cleaned = yield* Ref.get(released)
			assert.strictEqual(resolved, plugin)
			assert.isTrue(cleaned)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect.each(["stat", "read"])(
	"does not recover a composite NotFound from %s",
	(stage) =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				yield* fs.writeFileString(file, "original")
				const absent = PlatformError.systemError({
					_tag: "NotFound",
					module: "FileSystem",
					method: stage,
				})
				const cleanup = PlatformError.systemError({
					_tag: "Unknown",
					module: "FileSystem",
					method: "cleanup",
				})
				const failure = Effect.acquireUseRelease(
					Effect.void,
					() => Effect.fail(absent),
					() => Effect.fail(cleanup),
				)
				const exit = yield* atomicWrite(
					file,
					"replacement",
					Option.none(),
				).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						stat: stage === "stat" ? () => failure : fs.stat,
						readFileString:
							stage === "read" ? () => failure : fs.readFileString,
					}),
					Effect.exit,
				)
				assert(Exit.isFailure(exit))
				assert.deepStrictEqual(
					Array.map(
						Array.filter(exit.cause.reasons, Cause.isFailReason),
						(reason) => reason.error,
					),
					[absent, cleanup],
				)
				const text = yield* fs.readFileString(file)
				const names = yield* fs.readDirectory(directory)
				assert.strictEqual(text, "original")
				assert.deepStrictEqual(names, ["graft.yml"])
			}),
		),
)

it.effect(
	"records every typed preparation failure when an entry update restarts",
	() =>
		Effect.gen(function* () {
			const first = new ConfigProvider.SourceError({
				message: "Configuration read failed",
			})
			const second = new ConfigProvider.SourceError({
				message: "Configuration cleanup failed",
			})
			const provider = ConfigProvider.make(() =>
				Effect.acquireUseRelease(
					Effect.void,
					() => Effect.fail(first),
					() => Effect.fail(second),
				),
			)
			const plugin = Plugin.make({
				name: "consumer",
				config: Schema.Unknown,
				apply: () => Effect.void,
			})
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "consumer", name: "consumer" },
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.update("consumer", {
					config: new Entry.Env({ name: "VALUE" }),
				})
				yield* loader.ready
				const record = yield* Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							Array.isArray(entry.message) &&
							Array.contains(entry.message, "Preparing an entry update failed"),
					),
					Stream.runHead,
				)
				const cause = Option.getOrThrow(record).cause
				assert.strictEqual(cause.reasons.length, 2)
				assert.isTrue(Cause.hasFails(cause))
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Graft.layer.pipe(
						Layer.provideMerge(
							Layer.merge(
								ModuleResolver.fromRecord({ consumer: plugin }),
								ConfigProvider.layer(provider),
							),
						),
					),
				),
			)
		}),
)
