import { Commands } from "@graftland/cli/Commands"
import { Command } from "effect/cli"
import { Event, Graft, Plugin } from "@graftland/graft"
import { Group, Include, Loader, ModuleResolver } from "@graftland/loader"
import * as Remote from "@graftland/plugin-remote"
import { Authenticator, Credentials } from "@graftland/plugin-remote/Auth"
import { Connector, Listener } from "@graftland/plugin-remote/Transport"
import { Context, Effect, Layer, Schema, Sink, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

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
	RpcGroup.make(Rpc.make("Read", { success: Schema.String })),
	{
		toHandlers: (value) => ({ Read: () => value.read }),
		fromClient: (client) => ({ read: Effect.orDie(client.Read()) }),
	},
)
export const contract = Remote.Contract.make({
	name: "greeter",
	config,
	module: "./greeter.js",
	provides: [descriptor],
})
export const declaredError = Remote.Contract.make({
	name: "fallible",
	config,
	error: Schema.Literal("unavailable"),
	module: "./greeter.js",
})
export const remote = Remote.plugin(contract, {
	connect: { local: {} },
	contractModule: "./contract.js",
	config: { greeting: "hello" },
})
export const loader = Loader.plugin
export const include = Include.Include
export const group = Group.Group
export const resolver = ModuleResolver.fromRecord({ plain })
export const load = Graft.plugin(Loader.plugin, [])
export const loadFile = Graft.plugin(Include.Include, { path: "graft.yml" })
export const authenticator = Plugin.service(
	Authenticator,
	Effect.succeed(Authenticator.of({ _tag: "None", identity: "fixture" })),
	{ name: "fixture-authenticator" },
)
export const credentials = Plugin.service(
	Credentials,
	Effect.succeed(
		Credentials.of({ kind: "None", read: Effect.succeed({ _tag: "None" }) }),
	),
	{ name: "fixture-credentials" },
)
export const connector = Plugin.service(
	Connector,
	Effect.succeed(
		Connector.of({
			properties: {
				protocol: "fixture",
				encrypted: false,
				network: false,
				carries: [],
			},
			connect: () =>
				Effect.succeed({ input: Stream.empty, output: Sink.drain }),
		}),
	),
	{ name: "fixture-connector" },
)
export const listener = Plugin.service(
	Listener,
	Effect.succeed(
		Listener.of({
			properties: {
				protocol: "fixture",
				encrypted: false,
				network: false,
				carries: [],
			},
			bind: () =>
				Effect.succeed({ ready: Effect.void, serve: () => Effect.void }),
		}),
	),
	{ name: "fixture-listener" },
)
export default Plugin.make({ name: "default", apply: () => Effect.void })

export const commands = Plugin.make({
	name: "fixture-commands",
	inject: [Commands],
	apply: () =>
		Effect.flatMap(Commands, (commands) =>
			commands.register(Command.make("example", {}, () => Effect.void)),
		),
})
