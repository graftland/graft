import { Graft, Plugin } from "@graftland/graft"
import { Console, Context, Effect, Schema, type Scope } from "effect"
import type { NetAddress } from "effect/net"
import type { LegacyAuthenticator } from "../Auth"
import { Supervisor } from "../Supervisor"
import * as Auth from "./auth/listener"
import { follow } from "./follow"
import * as Channel from "./socketChannel"
import * as Server from "./websocketServer"

export class ListenerConfigError extends Schema.TaggedError<
	ListenerConfigError,
	{ readonly brand: unique symbol }
>()("ListenerConfigError", { detail: Schema.String }) {
	override get message() {
		return this.detail
	}
}
const Listening = Schema.fromJsonString(
	Schema.Union([
		Schema.Struct({
			event: Schema.Literal("Listening"),
			port: Schema.NullOr(Schema.Int),
		}),
		Schema.Struct({ event: Schema.Literal("Listening"), path: Schema.String }),
	]),
)
export interface Binding {
	readonly server: Parameters<typeof Server.listen>[0]
	readonly address: Parameters<typeof Server.listen>[1]
	readonly listening: (
		address: NetAddress.SocketAddress,
	) => { readonly port: number | null } | { readonly path: string }
}

/** The selected authenticator and the listening socket share a private plugin's lifetime. */
export const start = <
	E,
	const D extends ReadonlyArray<Plugin.Dependency>,
>(options: {
	readonly auth: string
	readonly protocol: "ws" | "wss" | "unix"
	readonly inject: D
	readonly bind: (
		auth: LegacyAuthenticator,
	) => Effect.Effect<Binding, E, Plugin.Required<D> | Scope.Scope>
}) => {
	class Selected extends Context.Service<Selected, LegacyAuthenticator>()(
		options.auth,
	) {}
	return Graft.plugin(
		Plugin.make({
			name: "remote-listener",
			inject: [Supervisor, Selected, ...options.inject],
			apply: Effect.fnUntraced(function* () {
				const auth = yield* Selected
				if (auth._tag === "Mtls" && options.protocol !== "wss")
					return yield* ListenerConfigError.make({
						detail: "Mutual TLS requires wss://",
					})
				const supervisor = yield* Supervisor
				const binding = yield* options.bind(auth)
				if (options.protocol !== "unix")
					yield* Auth.warn(auth, options.protocol === "ws")
				const listener = yield* Server.listen(
					binding.server,
					binding.address,
					Auth.authenticate(auth, options.protocol !== "unix"),
				)
				yield* Plugin.fork(
					listener.run((socket) =>
						Channel.fromSocket(socket).pipe(Effect.flatMap(supervisor.accept)),
					),
				)
				const message = yield* Schema.encodeEffect(Listening)({
					event: "Listening",
					...binding.listening(listener.address),
				})
				yield* Console.log(message)
			}),
		}),
	).pipe(
		Effect.flatMap((fork) => follow(fork, (cause) => Effect.failCause(cause))),
	)
}
