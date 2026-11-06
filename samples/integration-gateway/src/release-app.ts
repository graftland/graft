import {
	Deferred,
	Effect,
	FileSystem,
	Path,
	Queue,
	Ref,
	Schema,
	Semaphore,
} from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import * as Release from "@graftland/plugin-release"
import type { CandidateOptions } from "@graftland/plugin-remote"

import { policy } from "./app.js"
import { consume, gateway, localBot } from "./gateway.js"

export const startReleases = Effect.fnUntraced(function* (
	directory: string,
	target: CandidateOptions["target"],
	multiple: boolean = false,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped({
		directory,
		prefix: "releases-",
	})
	const store = path.join(root, "store")
	const source = yield* fs.realPath(
		path.join(directory, "node_modules/@example/forecasts-release"),
	)
	const file = path.join(root, "graft.yml")
	const write = Effect.fnUntraced(function* (
		config: Schema.Json,
		audit: Schema.Json = {
			release: "unused",
			started: "unused",
			prefix: "initial",
		},
	) {
		const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
			[
				{
					id: "forecasts",
					name: "@graftland/plugin-remote",
					config: {
						package: source,
						entry: ".",
						contract: import.meta.resolve("@example/forecast-contract"),
						target,
						config,
						probes: ["health"],
					},
				},
				...(multiple
					? [
							{
								id: "audit",
								name: "@graftland/plugin-remote",
								config: {
									package: source,
									entry: "./audit",
									contract: import.meta
										.resolve("@example/forecast-contract/audit"),
									target,
									config: audit,
									probes: ["health"],
								},
							},
						]
					: []),
			],
		)
		yield* fs.writeFileString(file, text)
	})
	const input = { release: "unused", started: "unused", prefix: "initial" }
	yield* write(input)
	const initial = yield* Release.build(store, {
		file,
		references: ["credential:legacy"],
		revocations: [],
	})
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: (specifier) => import(specifier),
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	const ready = yield* Deferred.make<Release.Releases["Service"]>()
	yield* Graft.plugin(
		Plugin.make({
			name: "release-observer",
			inject: [Release.Releases],
			apply: Effect.fnUntraced(function* () {
				const service = yield* Release.Releases
				yield* Deferred.succeed(ready, service)
			}),
		}),
	)
	const socket = path.join(root, "control.sock")
	const options: Release.Options = {
		store,
		initial,
		socket,
		policy,
		host: {
			node: "22.22.0",
			effect: "4.1.2",
			graft: "0.0.0",
			placement: target._tag,
			filesystem: true,
			nativeModules: true,
			services: [],
			operations: [],
		},
	}
	const releaseFork = yield* Graft.plugin(Release.plugin(options))
	yield* releaseFork.await
	const releases = yield* Deferred.await(ready)
	const upstream = yield* localBot()
	const gatewayActivations = yield* Ref.make(0)
	const consumerActivations = yield* Ref.make(0)
	const sessionReady = yield* Deferred.make<string>()
	const gatewayFork = yield* Graft.plugin(
		gateway(upstream.url, gatewayActivations),
	)
	const consumerFork = yield* Graft.plugin(
		consume(consumerActivations, sessionReady),
	)
	yield* gatewayFork.await
	yield* consumerFork.await
	const session = yield* Deferred.await(sessionReady)
	const commands = yield* Semaphore.make(1)
	return {
		initial,
		root,
		store,
		file,
		options,
		socket,
		releases,
		releaseFork,
		upstream,
		session,
		gatewayActivations,
		consumerActivations,
		build: (
			config: Schema.Json,
			revocations: ReadonlyArray<string> = [],
			references: ReadonlyArray<string> = [],
			audit?: Schema.Json,
		) =>
			write(config, audit).pipe(
				Effect.andThen(releases.build({ file, revocations, references })),
			),
		ask: (city: string) =>
			commands.withPermit(
				upstream
					.message("release", city)
					.pipe(Effect.andThen(Queue.take(upstream.responses))),
			),
	}
})
