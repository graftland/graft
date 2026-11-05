// Runs natively so the application importer uses Node's resolution hooks, not Vite's module runner.
import process from "node:process"

import {
	Array,
	Cause,
	Console,
	Deferred,
	Effect,
	Layer,
	Logger,
	Schema,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft, Plugin } from "@graftland/graft"
import { Include, ModuleResolver } from "@graftland/loader"

import { CapabilityFailed } from "../../src/internal/assembly"
import * as Importer from "../../src/internal/importer"
import { ChildApi, HostApi } from "./services-contract"

const resolver = Effect.fnUntraced(function* (directory: string) {
	const importer = yield* Importer.make(directory)
	return yield* ModuleResolver.make({ base: directory, importer })
})
const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const consumer = Effect.gen(function* () {
	const found = yield* Deferred.make<typeof ChildApi.Service>()
	yield* Graft.plugin(
		Plugin.make({
			name: "entry-consumer",
			inject: [ChildApi],
			apply: () =>
				ChildApi.pipe(
					Effect.flatMap((api) => Deferred.succeed(found, api)),
					Effect.asVoid,
				),
		}),
	)
	return yield* Deferred.await(found).pipe(
		Effect.raceFirst(
			Graft.forks.pipe(
				Stream.map((trees) => Array.flatMap(trees, failures)),
				Stream.filter((causes) => causes.length > 0),
				Stream.runHead,
				Effect.flatMap(Effect.fromOption),
				Effect.flatMap((causes) =>
					Effect.fail(
						CapabilityFailed.make({
							cause: Array.reduce(causes, Cause.empty, Cause.combine),
						}),
					),
				),
			),
		),
	)
})
const failures = (
	tree: import("@graftland/graft").Fork.ForkTree,
): ReadonlyArray<Cause.Cause<unknown>> => [
	...(tree.state._tag === "Failed" ? [tree.state.cause] : []),
	...Array.flatMap(tree.children, failures),
]
const provideHost = Graft.plugin(
	Plugin.service(
		HostApi,
		Effect.succeed({ double: (value: number) => Effect.succeed(value * 2) }),
		{ name: "entry-host-api" },
	),
).pipe(Effect.flatMap((fork) => fork.await))

const main = Effect.gen(function* () {
	const directory = yield* Schema.decodeUnknownEffect(Schema.String)(
		process.argv[2],
	)
	const modules = yield* resolver(directory)
	yield* Graft.provide(ModuleResolver.ModuleResolver, modules)
	yield* provideHost
	yield* Graft.plugin(Include.Include, {
		path: directory + "/host.yml",
		watch: false,
	})
	const api = yield* consumer
	const reply = yield* api.call(20)
	const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
		reply,
	)
	yield* Console.log(json)
})
NodeRuntime.runMain(
	main.pipe(
		Effect.scoped,
		Effect.provide(runtime),
		Effect.provideService(Logger.LogToStderr, true),
	),
)
