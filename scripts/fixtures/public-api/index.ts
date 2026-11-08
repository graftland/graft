import { Context, Effect, Layer, Schema } from "effect"
import { Command } from "effect/cli"
import { Rpc, RpcGroup } from "effect/rpc"

import { Commands } from "@graftland/cli/Commands"
import { Event, Graft, Plugin } from "@graftland/graft"
import { Group, Include, Loader, ModuleResolver } from "@graftland/loader"
import * as Remote from "@graftland/plugin-remote"

class Word extends Context.Service<Word, string>()("fixture/Word") {}
class Greeter extends Context.Service<
	Greeter,
	{ readonly read: Effect.Effect<string> }
>()("fixture/Greeter") {}
const config = Schema.Struct({ greeting: Schema.String })

export const plain = Plugin.make({ name: "plain", apply: () => Effect.void })
export const configured = Plugin.make({
	name: "configured",
	config,
	apply: ({ greeting }) => Effect.log(greeting),
})
export const injected = Plugin.make({
	name: "injected",
	inject: [Word],
	apply: () => Effect.asVoid(Word),
})
export const configuredAndInjected = Plugin.make({
	name: "both",
	config,
	inject: [Word],
	apply: ({ greeting }) =>
		Effect.flatMap(Word, (word) => Effect.log(greeting, word)),
})
export const service = Plugin.service(Word, Effect.succeed("hello"), {
	name: "word",
})
export const layer = Plugin.layer(Layer.succeed(Word, "hello"), {
	name: "layer",
	provides: [Word],
})
export const event = Event.make<[string]>("greeting")
export const middleware = Event.middleware<string, string>(
	"greeting middleware",
)
export const descriptor = Remote.Contract.service(
	Greeter,
	RpcGroup.make(
		Remote.Contract.operation(
			"@app/greeter/Read",
			1,
			Rpc.make("Read", { success: Schema.String }),
		),
	),
	{
		toHandlers: (value) => ({ Read: () => value.read }),
		fromClient: (client) => ({ read: Effect.orDie(client.Read()) }),
	},
)
export const declaration: Plugin.ProvidedContract = descriptor
export const operationCheck: Remote.Contract.OperationComparison =
	Remote.Contract.compareOperations(
		descriptor.operations,
		descriptor.operations,
	)
export const implementation = Plugin.make({
	name: "implementation",
	provides: [declaration],
	overlap: true,
	apply: () => Graft.provide(Greeter, { read: Effect.succeed("hello") }),
})
export const contract = Remote.Contract.make({
	name: "greeter",
	config,
	provides: [descriptor],
})
export const declaredError = Remote.Contract.make({
	name: "fallible",
	config,
	error: Schema.Literal("unavailable"),
})
export const loader = Loader.plugin
export const include = Include.Include
export const group = Group.Group
export const resolver = ModuleResolver.fromRecord({ plain })
export const load = Graft.plugin(Loader.plugin, [])
export const loadFile = Graft.plugin(Include.Include, { path: "graft.yml" })
export default Plugin.make({ name: "default", apply: () => Effect.void })

export const commands = Plugin.make({
	name: "fixture-commands",
	inject: [Commands],
	apply: () =>
		Effect.flatMap(Commands, (commands) =>
			commands.register(Command.make("example", {}, () => Effect.void)),
		),
})

export const capture = Remote.Artifact.capture({
	directory: "./built-plugin",
	entry: "index.js",
	store: "./artifacts",
})
export const probePlugin = Plugin.make({
	name: "public-probe",
	apply: () => Plugin.probe("health", Effect.void),
})

export const unitTarget = Remote.Units.target({
	artifact: {
		identity: {
			version: 1,
			algorithm: "sha256",
			digest: "a".repeat(64),
			entry: "plugin.js",
		},
		directory: "./captured",
	},
	contract: "contract.js",
	input: { greeting: "hello" },
	placement: "Worker",
})
export const connectControl = Remote.Control.connect
