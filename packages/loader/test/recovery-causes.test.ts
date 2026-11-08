import {
	Array,
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	PlatformError,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Entry, Loader } from "../src/index.ts"
import { atomicWrite } from "../src/internal/atomicWrite.ts"
import { fixture, moduleLayer } from "./module-fixtures"
import { loaderService, run } from "./utils.ts"

it.effect.each(["stat", "read"])(
	"does not recover a composite NotFound from %s",
	(stage) =>
		run()(() =>
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
								moduleLayer({
									consumer: fixture("recovery-causes-consumer-6312"),
								}),
								ConfigProvider.layer(provider),
							),
						),
					),
				),
			)
		}),
)
