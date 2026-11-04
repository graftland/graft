import { Peer } from "./Peer"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Schema,
	Stream,
} from "effect"
import {
	Authenticator,
	Credentials,
	type AuthenticatorApi,
	type CredentialsApi,
} from "../Auth"
import {
	Connector,
	Listener,
	type Accept,
	type Properties,
	type Session,
} from "../Transport"
import { AuthenticationFailed } from "../Errors"
import { Supervisor } from "./Supervisor"
import { follow } from "./follow"
import { connectionEnded, closedNormally } from "./runner/connectionEnded"
import { ServeLifecycle } from "./ServeLifecycle"

export class ListenerConfigError extends Schema.TaggedError<
	ListenerConfigError,
	{ readonly brand: unique symbol }
>()("ListenerConfigError", { detail: Schema.String }) {
	override get message() {
		return this.detail
	}
}

export class CapabilityContractError extends Schema.TaggedError<
	CapabilityContractError,
	{ readonly brand: unique symbol }
>()("CapabilityContractError", { plugin: Schema.String, key: Schema.String }) {
	override get message() {
		return `Capability ${this.plugin} became active without providing ${this.key}`
	}
}
export class CapabilityCombinationError extends Schema.TaggedError<
	CapabilityCombinationError,
	{ readonly brand: unique symbol }
>()("CapabilityCombinationError", { detail: Schema.String }) {
	override get message() {
		return this.detail
	}
}

export class CapabilityFailed extends Schema.TaggedError<
	CapabilityFailed,
	{ readonly brand: unique symbol }
>()("CapabilityFailed", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

const definition = Schema.declare(Plugin.isPlugin)
/** Entries resolve capability modules before assembling their private providers. */
export const Invocation = Schema.Struct({
	plugin: definition,
	config: Schema.Unknown,
})
const Input = Schema.Struct({
	transport: Invocation,
	auth: Invocation,
	consumer: definition,
	input: Schema.optionalKey(Schema.Unknown),
})
export type Input = typeof Input.Type

const subtree = (
	trees: ReadonlyArray<Fork.ForkTree>,
	id: number,
): Option.Option<Fork.ForkTree> =>
	Array.findFirst(trees, (tree) =>
		tree.id === id ? Option.some(tree) : subtree(tree.children, id),
	)
const active = (tree: Fork.ForkTree): boolean =>
	tree.state._tag === "Active" && Array.every(tree.children, active)
const failure = (tree: Fork.ForkTree): Effect.Effect<void, CapabilityFailed> =>
	tree.state._tag === "Failed"
		? Effect.fail(CapabilityFailed.make({ cause: tree.state.cause }))
		: Effect.forEach(tree.children, failure, { discard: true })

const probe = (name: string, key: Context.Key<unknown, unknown>) =>
	Plugin.make({
		name: "remote-capability-contract",
		inject: [Plugin.optional(key)],
		apply: Effect.fnUntraced(function* () {
			const value = yield* Effect.serviceOption(key)
			if (Option.isNone(value))
				return yield* CapabilityContractError.make({
					plugin: name,
					key: key.key,
				})
		}),
	})

/** Resolve the key in a fresh consumer after the provider subtree settles.
 * An optional consumer started earlier could still hold a pre-publication snapshot.
 */
const watch = (provider: Fork.Fork, key: Context.Key<unknown, unknown>) =>
	Plugin.fork(
		Graft.forks.pipe(
			Stream.map((trees) => subtree(trees, provider.id)),
			Stream.filter(Option.isSome),
			Stream.map((tree) => tree.value),
			Stream.tap(failure),
			Stream.map((tree) => ({ name: tree.name, active: active(tree) })),
			Stream.changesWith((left, right) => left.active === right.active),
			Stream.filter((tree) => tree.active),
			Stream.runForEach((tree) =>
				Effect.scoped(
					Graft.plugin(probe(tree.name, key)).pipe(
						Effect.flatMap((fork) => fork.await),
					),
				),
			),
		),
	)

const assembly = (
	keys: readonly [Context.Key<unknown, unknown>, Context.Key<unknown, unknown>],
) =>
	Plugin.make({
		name: "remote-assembly",
		config: Input,
		apply: Effect.fnUntraced(function* (input) {
			yield* Effect.forEach(
				[
					{ invocation: input.transport, key: keys[0] },
					{ invocation: input.auth, key: keys[1] },
				],
				Effect.fnUntraced(function* ({ invocation, key }) {
					const provider = yield* Graft.plugin(
						invocation.plugin,
						invocation.config,
					)
					yield* watch(provider, key)
				}),
			)
			const consumer = yield* Graft.plugin(input.consumer, input.input)
			// Capability publication can leave a transient Pending snapshot; business dependencies may remain Pending.
			yield* consumer.state.pipe(
				Stream.filter(
					(state) =>
						state._tag !== "Loading" &&
						(state._tag !== "Pending" ||
							!Array.some(keys, (key) =>
								Array.contains(state.missing, key.key),
							)),
				),
				Stream.runHead,
			)
			yield* follow(consumer, (cause) =>
				Effect.fail(CapabilityFailed.make({ cause })),
			)
		}),
	})
const hostAssembly = assembly([Connector, Credentials])
const runnerAssembly = assembly([Listener, Authenticator])

export const host = (input: Input) =>
	Graft.plugin(hostAssembly, input, { isolate: [Connector, Credentials] })
export const runner = (
	input: Omit<Input, "consumer">,
	consumer = listenerConsumer,
) =>
	Graft.plugin(
		runnerAssembly,
		{ ...input, consumer },
		{ isolate: [Listener, Authenticator] },
	)

export const compatible = (
	properties: Properties,
	kind: CredentialsApi["kind"],
): Effect.Effect<void, CapabilityCombinationError> => {
	if (
		kind === "Certificate" &&
		(properties.protocol !== "wss" ||
			!properties.encrypted ||
			!Array.contains(properties.carries, "certificate"))
	)
		return Effect.fail(
			CapabilityCombinationError.make({
				detail: "Mutual TLS requires encrypted wss with certificate evidence",
			}),
		)
	if (kind === "Authorization" && !Array.contains(properties.carries, "header"))
		return Effect.fail(
			CapabilityCombinationError.make({
				detail: "This transport cannot carry Authorization headers",
			}),
		)
	return Effect.void
}
const kind = (auth: AuthenticatorApi): CredentialsApi["kind"] =>
	auth._tag === "Mtls"
		? "Certificate"
		: auth._tag === "Header"
			? "Authorization"
			: "None"
const warn = (
	properties: Properties,
	credentials: CredentialsApi["kind"],
	side: "host" | "runner",
) =>
	Effect.all(
		[
			properties.network && !properties.encrypted
				? Effect.logWarning(
						credentials === "Authorization"
							? `${properties.protocol}:// ${side === "host" ? "connection" : "listener"} is unencrypted; credentials are transmitted in plaintext`
							: `${properties.protocol}:// ${side === "host" ? "connection" : "listener"} is unencrypted`,
					)
				: Effect.void,
			side === "runner" && properties.network && credentials === "None"
				? Effect.logWarning("WebSocket listener has no authentication")
				: Effect.void,
		],
		{ discard: true },
	)

export const directAuth = (properties: Properties, explicit: boolean) =>
	explicit &&
	(properties.protocol === "stdio" || properties.protocol === "command")
		? Effect.fail(
				CapabilityCombinationError.make({
					detail: `${properties.protocol} transports do not accept auth`,
				}),
			)
		: Effect.void

export const connectWith = (explicitAuth = false) =>
	Effect.gen(function* () {
		const connector = yield* Connector
		const credentials = yield* Credentials
		yield* directAuth(connector.properties, explicitAuth)
		yield* compatible(connector.properties, credentials.kind)
		yield* warn(connector.properties, credentials.kind, "host")
		const prepared = yield* credentials.read
		return yield* connector.connect(prepared)
	})

export const accept =
	(
		auth: AuthenticatorApi,
		properties: Properties,
		session: (identity: string) => Session,
	): Accept =>
	(handshake) => {
		const identity =
			auth._tag === "Header"
				? auth.authenticate(handshake.authorization)
				: auth._tag === "Mtls"
					? Option.match(handshake.certificate, {
							onNone: () =>
								Effect.fail(AuthenticationFailed.make({ reason: "missing" })),
							onSome: auth.authenticate,
						})
					: (properties.network
							? Effect.logWarning("WebSocket connection has no authentication")
							: Effect.void
						).pipe(Effect.as(auth.identity))
		return identity.pipe(Effect.map(session))
	}

export const makeListenerConsumer = (
	prepare: (
		properties: Properties,
		auth: AuthenticatorApi,
	) => Effect.Effect<void, CapabilityCombinationError> = () => Effect.void,
	ready: Effect.Effect<void> = Effect.void,
) =>
	Plugin.make({
		name: "remote-listener-consumer",
		inject: [
			Listener,
			Authenticator,
			Supervisor,
			Plugin.optional(ServeLifecycle),
		],
		apply: Effect.fnUntraced(function* () {
			const listener = yield* Listener
			const auth = yield* Authenticator
			const supervisor = yield* Supervisor
			const lifecycle = yield* Effect.serviceOption(ServeLifecycle)
			yield* prepare(listener.properties, auth)
			yield* compatible(listener.properties, kind(auth)).pipe(
				Effect.mapError((error) =>
					ListenerConfigError.make({ detail: error.detail }),
				),
			)
			yield* warn(listener.properties, kind(auth), "runner")
			const serving = yield* listener.bind(
				auth._tag === "Mtls" ? Option.some(auth.tls) : Option.none(),
			)
			const running = yield* Plugin.fork(
				serving
					.serve(
						accept(
							auth,
							listener.properties,
							(identity) => (channel) =>
								supervisor.accept(channel).pipe(
									Effect.catchCause((cause) =>
										listener.properties.protocol === "stdio"
											? closedNormally(cause)
												? Effect.void
												: Effect.failCause(cause)
											: connectionEnded(cause),
									),
									Effect.provideService(Peer, identity),
								),
						),
					)
					.pipe(
						Effect.onExit((exit) =>
							listener.properties.protocol === "stdio" &&
							Option.isSome(lifecycle)
								? Deferred.done(lifecycle.value.ended, exit)
								: Effect.void,
						),
					),
			)
			yield* serving.ready.pipe(Effect.raceFirst(Fiber.join(running)))
			yield* ready
		}),
	})

export const listenerConsumer = makeListenerConsumer()

export const connect = connectWith()
