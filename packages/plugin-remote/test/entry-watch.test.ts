import { pathToFileURL } from "node:url"

import {
	Array,
	ByteSize,
	Cause,
	Effect,
	FileSystem,
	Layer,
	Logger,
	MutableList,
	Option,
	PlatformError,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import * as Hmr from "@graftland/hmr"
import { Loader, ModuleResolver } from "@graftland/loader"

import * as Contract from "../src/Contract"
import { host } from "../src/internal/entry"

it.effect(
	"keeps entry observations through failed execution and restarts on a change",
	() =>
		Effect.gen(function* () {
			const activations = yield* Queue.unbounded<void>()
			const changes = yield* Queue.unbounded<void>()
			const watched = yield* Queue.unbounded<ReadonlyArray<string>>()
			const contract = Contract.make({
				name: "watched",
				config: Schema.Finite,
				module: "file:///implementation.mjs",
			})
			const resolver = {
				resolve: (name: string) =>
					Effect.succeed(
						name === "remote"
							? host
							: Plugin.make({
									name: "failed-provider",
									apply: () =>
										Queue.offer(activations, undefined).pipe(
											Effect.andThen(Effect.fail("Startup failed")),
										),
								}),
					),
				importModule: () => Effect.succeed({ contract }),
			}
			const observation = Effect.gen(function* () {
				const scope = yield* Effect.scope
				return {
					scope,
					watch: (files: ReadonlyArray<string>) =>
						Queue.offer(watched, files).pipe(Effect.asVoid),
					changes: Stream.fromQueue(changes),
				}
			})
			yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
			yield* Graft.plugin(Loader.plugin, [
				{
					id: "remote",
					name: "remote",
					config: {
						contract: "file:///contract.mjs",
						config: 1,
						connect: { local: {} },
					},
				},
			]).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				Effect.provideService(ModuleResolver.Watch, Option.some(observation)),
			)
			yield* Queue.take(activations)
			const files = yield* Queue.take(watched)
			assert.deepEqual(files, [
				"file:///contract.mjs",
				"file:///implementation.mjs",
			])
			yield* Queue.offer(changes, undefined)
			yield* Queue.take(activations)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Graft.layer.pipe(
					Layer.provideMerge(
						Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
					),
				),
			),
		),
)

it.effect(
	"reinstalls a failed remote observation and restarts on the next change",
	() =>
		Effect.gen(function* () {
			const implementation = "/source/implementation.mjs"
			const contractFile = "/source/contract.mjs"
			const version = yield* Ref.make("first")
			const activations = yield* Queue.unbounded<void>()
			const subscriptions = yield* Queue.unbounded<number>()
			const attempts = yield* Ref.make(0)
			const logs = MutableList.make<Cause.Cause<unknown>>()
			const failure = PlatformError.systemError({
				module: "FileSystem",
				method: "watch",
				_tag: "Unknown",
				cause: new Error("Transient observation failure"),
			})
			const contract = Contract.make({
				name: "watched",
				config: Schema.Finite,
				module: pathToFileURL(implementation).href,
			})
			const resolver = {
				resolve: (name: string) =>
					Effect.succeed(
						name === "remote"
							? host
							: Plugin.make({
									name: "failed-provider",
									apply: () =>
										Queue.offer(activations, undefined).pipe(
											Effect.andThen(Effect.fail("Startup failed")),
										),
								}),
					),
				importModule: () => Effect.succeed({ contract }),
			}
			const hmr = yield* Hmr.make({ base: import.meta.url })
			const observation = hmr.observation.pipe(
				Effect.provideService(
					FileSystem.FileSystem,
					FileSystem.makeNoop({
						realPath: (path) => Effect.succeed(path),
						stat: (path) =>
							Effect.succeed({
								type: String.endsWith(".mjs")(path) ? "File" : "Directory",
								size: ByteSize.bytes(5),
								mtime: Option.none(),
								ino: Option.none(),
								atime: Option.none(),
								birthtime: Option.none(),
								dev: 0n,
								mode: 0,
								nlink: Option.some(1n),
								uid: Option.none(),
								gid: Option.none(),
								rdev: Option.some(0n),
								blksize: Option.none(),
								blocks: Option.none(),
							}),
						readFile: (path) =>
							(path === contractFile
								? Effect.succeed("contract")
								: Ref.get(version)
							).pipe(Effect.map((text) => new TextEncoder().encode(text))),
						watch: () =>
							Stream.unwrap(
								Effect.gen(function* () {
									const attempt = yield* Ref.getAndUpdate(
										attempts,
										(n) => n + 1,
									)
									yield* Queue.offer(subscriptions, attempt)
									return attempt === 0 ? Stream.fail(failure) : Stream.never
								}),
							),
					}),
				),
				Effect.map((source) => ({
					...source,
					watch: (files: ReadonlyArray<string>, activation: Scope.Scope) =>
						source.watch(files, activation).pipe(
							Effect.mapError((cause) =>
								ModuleResolver.ModuleInvalid.make({
									specifier: "remote",
									cause,
								}),
							),
						),
				})),
			)
			yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
			yield* Graft.plugin(Loader.plugin, [
				{
					id: "remote",
					name: "remote",
					config: {
						contract: pathToFileURL(contractFile).href,
						config: 1,
						connect: { local: {} },
					},
				},
			]).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				Effect.provideService(ModuleResolver.Watch, Option.some(observation)),
				Effect.provide(
					Logger.layer([
						Logger.make(({ message, cause }) => {
							if (
								Array.isArray(message) &&
								message[0] === "Source observation failed; retrying"
							)
								MutableList.append(logs, cause)
						}),
					]),
				),
			)
			yield* Queue.take(activations)
			const first = yield* Queue.take(subscriptions)
			assert.equal(first, 0)
			yield* TestClock.adjust("2 seconds")
			const recorded = MutableList.toArray(logs)
			assert.equal(recorded.length, 1)
			const cause = recorded[0]
			assert.isDefined(cause)
			assert.equal(cause.reasons.length, 1)
			const reason = cause.reasons[0]
			assert.isDefined(reason)
			assert.isTrue(Cause.isFailReason(reason))
			if (Cause.isFailReason(reason)) assert.strictEqual(reason.error, failure)
			const second = yield* Queue.take(subscriptions)
			assert.equal(second, 1)
			yield* Ref.set(version, "second")
			// The fake stat stays unchanged; advance the retained digest audit.
			yield* TestClock.adjust("12 seconds")
			const size = yield* Queue.size(activations)
			assert.equal(size, 1)
			yield* Queue.take(activations)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Graft.layer.pipe(
					Layer.provideMerge(
						Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
					),
				),
			),
		),
)
