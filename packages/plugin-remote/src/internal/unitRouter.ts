/** Stable unit-local RPC protocols whose physical endpoints follow installed core views. */
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Option,
	Queue,
	Ref,
	Scope,
	String,
} from "effect"
import { SecureRandom } from "effect/crypto"
import {
	RpcClient,
	RpcClientError,
	RpcSerialization,
	type RpcMessage,
} from "effect/rpc"
import type { Socket } from "effect/socket"

import type { Kernel } from "@graftland/graft"

import type * as Contract from "../Contract"
import * as CallFrames from "./callFrames"
import * as EncodedLimit from "./encodedLimit"
import { SingleHop } from "./ownedCalls"
import * as Network from "./unitNetwork"
import type * as Wire from "./unitProtocol"

type Protocol = RpcClient.Protocol["Service"]
type Id = RpcMessage.RequestEncoded["id"]
interface Slot {
	readonly session: string
	readonly service: Contract.Service
	readonly incoming: Queue.Queue<Protocol>
	readonly pinned: Ref.Ref<HashMap.HashMap<Id, Protocol>>
}
interface Staged {
	readonly scope: Scope.Closeable
	readonly protocols: HashMap.HashMap<string, Installed>
}
interface Installed {
	readonly scope: Scope.Closeable
	readonly route: Kernel.BindingRoute
	readonly protocol: Protocol
	readonly version: number
}
interface Views {
	readonly active: HashMap.HashMap<string, Installed>
	readonly views: HashMap.HashMap<string, Staged>
	readonly discarded: HashSet.HashSet<string>
}
interface Runtime {
	readonly emit: (message: Wire.CallMessage) => Effect.Effect<void>
	readonly waiting: Ref.Ref<
		HashMap.HashMap<
			string,
			Deferred.Deferred<Wire.CallControl, RpcClientError.RpcClientError>
		>
	>
	readonly connections: Ref.Ref<HashMap.HashMap<string, Installed>>
	readonly owner: Scope.Scope
	readonly slots: HashMap.HashMap<string, Slot>
	readonly state: Ref.Ref<Views>
}
export interface Router {
	readonly retire: (incarnation: string) => Effect.Effect<void>
	readonly decide: (command: Wire.Command) => Effect.Effect<void>
	readonly clientProtocol: (service: string) => Protocol
	readonly install: (
		token: Wire.Token,
		view: Kernel.RouteView,
	) => Effect.Effect<void, Socket.SocketError>
	readonly activate: (token: Wire.Token) => Effect.Effect<void>
	readonly discard: (token: Wire.Token) => Effect.Effect<void>
}
const key = (token: Wire.Token) =>
	`${token.authority}/${token.change}/${token.view}`
const error = (message: string) =>
	RpcClientError.RpcClientError.make({
		reason: RpcClientError.RpcClientDefect.make({
			message,
			cause: Cause.fail(message),
		}),
	})
const allowedHeaders = HashSet.make(
	"traceparent",
	"tracestate",
	"x-graft-origin",
	"x-graft-capability",
	"x-graft-ticket",
)
const metadata = (
	message: RpcMessage.FromClientEncoded,
): RpcMessage.FromClientEncoded =>
	message._tag === "Request"
		? {
				...message,
				headers: Array.filter(message.headers, ([name]) =>
					HashSet.has(allowedHeaders, String.toLowerCase(name)),
				),
			}
		: message
const requestKey = (session: string, request: string) => `${session}/${request}`
const connectionKey = (service: string, route: Kernel.BindingRoute) =>
	`${service}/${route.incarnation}`
const grant = Effect.fnUntraced(function* (
	runtime: Runtime,
	slot: Slot,
	message: RpcMessage.RequestEncoded,
): Effect.fn.Return<Wire.CallControl, RpcClientError.RpcClientError> {
	const nested = yield* SingleHop
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const pending = yield* Deferred.make<
				Wire.CallControl,
				RpcClientError.RpcClientError
			>()
			const key = requestKey(slot.session, globalThis.String(message.id))
			const accepted = yield* Ref.modify(runtime.waiting, (waiters) =>
				HashMap.size(waiters) >= 128
					? [false, waiters]
					: [true, HashMap.set(waiters, key, pending)],
			)
			if (!accepted)
				return yield* error("NotAdmitted: local control request limit exceeded")
			yield* runtime.emit({
				_tag: "Request",
				session: slot.session,
				request: globalThis.String(message.id),
				service: slot.service.key.key,
				lifecycle: true,
				nested,
				wait: 5000,
			})
			return yield* restore(Deferred.await(pending)).pipe(
				Effect.onInterrupt(() =>
					runtime.emit({
						_tag: "Cancel",
						session: slot.session,
						request: globalThis.String(message.id),
					}),
				),
				Effect.ensuring(Ref.update(runtime.waiting, HashMap.remove(key))),
			)
		}),
	)
})
const send = Effect.fnUntraced(function* (
	runtime: Runtime,
	slot: Slot,
	client: number,
	message: RpcMessage.FromClientEncoded,
): Effect.fn.Return<void, RpcClientError.RpcClientError> {
	if (message._tag === "Request") {
		if (message.discard === true)
			return yield* error(
				"NotAdmitted: discarded calls are not supported by unit contracts",
			)
		yield* EncodedLimit.check(message).pipe(
			Effect.mapError((cause) =>
				RpcClientError.RpcClientError.make({
					reason: RpcClientError.RpcClientDefect.make({
						message: "NotAdmitted: encoded unary message rejected",
						cause: Cause.fail(cause),
					}),
				}),
			),
		)
		const decision = yield* grant(runtime, slot, message)
		if (decision.route === undefined)
			return yield* error("Unknown: the core grant has no endpoint")
		const route = decision.route
		const selected = yield* Ref.get(runtime.connections).pipe(
			Effect.map((connections) =>
				HashMap.get(connections, connectionKey(slot.service.key.key, route)),
			),
		)
		if (Option.isNone(selected)) {
			yield* runtime.emit({
				_tag: "Cancel",
				session: slot.session,
				request: globalThis.String(message.id),
			})
			return yield* error("Unknown: the authorized endpoint is not installed")
		}
		yield* Ref.update(
			slot.pinned,
			HashMap.set(message.id, selected.value.protocol),
		)
		const filtered = metadata(message)
		if (filtered._tag !== "Request")
			return yield* error("The request envelope changed kind")
		return yield* selected.value.protocol.send(client, {
			...filtered,
			headers: [
				...Array.filter(
					filtered.headers,
					([name]) => String.toLowerCase(name) !== "x-graft-ticket",
				),
				["x-graft-ticket", decision.key],
			],
		})
	}
	const known = yield* Ref.get(slot.pinned)
	if (message._tag === "Interrupt")
		yield* runtime.emit({
			_tag: "Cancel",
			session: slot.session,
			request: globalThis.String(message.requestId),
		})
	const selected =
		message._tag === "Ack" || message._tag === "Interrupt"
			? HashMap.get(known, message.requestId)
			: Option.none<Protocol>()
	if (Option.isSome(selected)) yield* selected.value.send(client, message)
	if (message._tag === "Ack")
		yield* Ref.update(slot.pinned, HashMap.remove(message.requestId))
})
const decide = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Wire.Command,
) {
	const call = command.call
	if (call === undefined) return
	const waiter = yield* Ref.get(runtime.waiting).pipe(
		Effect.map((w) => HashMap.get(w, requestKey(call.session, call.request))),
	)
	if (Option.isNone(waiter)) return
	if (command.kind === "CallGrant") yield* Deferred.succeed(waiter.value, call)
	else
		yield* Deferred.fail(
			waiter.value,
			error(
				`${call.reason === "Unknown" ? "Unknown" : "NotAdmitted"}: ${call.reason ?? "Rejected"}`,
			),
		)
})
const run = (
	runtime: Runtime,
	slot: Slot,
	client: number,
	receive: Parameters<Protocol["run"]>[1],
): Effect.Effect<never> =>
	Effect.scoped(
		Queue.take(slot.incoming).pipe(
			Effect.flatMap((protocol) =>
				protocol
					.run(client, (frame) =>
						Effect.gen(function* () {
							if (frame._tag !== "ClientProtocolError") {
								yield* receive(frame)
								if (frame._tag === "Exit") {
									yield* runtime.emit({
										_tag: "Result",
										session: slot.session,
										request: globalThis.String(frame.requestId),
									})
									yield* Ref.update(
										slot.pinned,
										HashMap.remove(frame.requestId),
									)
								}
								return
							}
							const pinned = yield* Ref.get(slot.pinned)
							const ids = Array.flatMap(
								Array.fromIterable(pinned),
								([id, p]) => (p === protocol ? [id] : []),
							)
							yield* Effect.forEach(
								ids,
								(id) =>
									CallFrames.encode({
										_tag: "Lost",
										session: slot.session,
										request: globalThis.String(id),
										cause: Cause.fail(frame.error),
									}).pipe(Effect.orDie, Effect.flatMap(runtime.emit)),
								{ discard: true },
							)
							yield* receive({ ...frame, requestIds: ids })
							yield* Ref.update(slot.pinned, (pinned) =>
								Array.reduce(ids, pinned, (p, id) => HashMap.remove(p, id)),
							)
						}),
					)
					.pipe(Effect.forkScoped),
			),
			Effect.forever,
		),
	)
const protocol = (runtime: Runtime, slot: Slot): Protocol =>
	RpcClient.Protocol.of({
		codecFor: RpcSerialization.json.codecFor,
		supportsAck: true,
		supportsTransferables: false,
		run: (client, receive) => run(runtime, slot, client, receive),
		send: (client, message) => send(runtime, slot, client, message),
	})
const install = Effect.fnUntraced(function* (
	runtime: Runtime,
	token: Wire.Token,
	view: Kernel.RouteView,
): Effect.fn.Return<void, Socket.SocketError> {
	const id = key(token)
	const existing = yield* Ref.get(runtime.state)
	const discarded = existing.discarded
	if (HashMap.has(existing.views, id) || HashSet.has(discarded, id)) return
	const scope = yield* Scope.fork(runtime.owner)
	const protocols = yield* Effect.forEach(
		Array.filter(Array.fromIterable(runtime.slots), ([name]) =>
			Array.some(view.routes, (r) => r.service === name),
		),
		([name, slot]) =>
			Effect.gen(function* () {
				const route = Array.findFirst(view.routes, (r) => r.service === name)
				if (Option.isNone(route))
					return yield* Effect.die(
						"Installed view is missing a declared dependency",
					)
				const connectionScope = yield* Scope.fork(scope)
				const connection = yield* Network.client(route.value, [
					slot.service,
				]).pipe(Scope.provide(connectionScope))
				const selected = connection.clientProtocol(name)
				yield* Ref.update(
					runtime.connections,
					HashMap.set(connectionKey(name, route.value), {
						protocol: selected,
						scope: connectionScope,
						route: route.value,
						version: route.value.version,
					}),
				)
				yield* Queue.offer(slot.incoming, selected)
				return [
					name,
					{
						scope: connectionScope,
						protocol: selected,
						version: route.value.version,
						route: route.value,
					},
				] satisfies readonly [string, Installed]
			}),
	).pipe(Effect.map(HashMap.fromIterable))
	const accepted = yield* Ref.modify(runtime.state, (state) =>
		HashSet.has(state.discarded, id) || HashMap.has(state.views, id)
			? [false, state]
			: [
					true,
					{
						...state,
						views: HashMap.set(state.views, id, { scope, protocols }),
					},
				],
	)
	if (!accepted) yield* Scope.close(scope, Exit.void)
})
const activate = Effect.fnUntraced(function* (
	runtime: Runtime,
	token: Wire.Token,
) {
	const accepted = yield* Ref.modify(runtime.state, (state) => {
		const staged = HashMap.get(state.views, key(token))
		if (Option.isNone(staged) || HashSet.has(state.discarded, key(token)))
			return [false, state]
		const newer = HashMap.some(staged.value.protocols, (next, name) =>
			Option.exists(
				HashMap.get(state.active, name),
				(current) => current.version > next.version,
			),
		)
		if (newer) return [false, state]
		return [
			true,
			{
				...state,
				active: HashMap.reduce(
					staged.value.protocols,
					state.active,
					(active, value, name) => HashMap.set(active, name, value),
				),
			},
		]
	})
	if (!accepted)
		return yield* Effect.die(
			"The route view was discarded, is missing or is older than the active binding",
		)
})
const discard = Effect.fnUntraced(function* (
	runtime: Runtime,
	token: Wire.Token,
) {
	const id = key(token)
	const staged = yield* Ref.modify(runtime.state, (state) => {
		const view = HashMap.get(state.views, id)
		const active = Option.isNone(view)
			? state.active
			: HashMap.filter(
					state.active,
					(value, name) =>
						!Option.exists(
							HashMap.get(view.value.protocols, name),
							(p) => p.protocol === value.protocol,
						),
				)
		return [
			view,
			{
				...state,
				active,
				discarded: HashSet.add(state.discarded, id),
				views: HashMap.remove(state.views, id),
			},
		]
	})
	if (Option.isSome(staged)) yield* Scope.close(staged.value.scope, Exit.void)
})
const retire = Effect.fnUntraced(function* (
	runtime: Runtime,
	incarnation: string,
) {
	const connections = yield* Ref.modify(runtime.connections, (connections) => [
		Array.filter(
			Array.fromIterable(HashMap.values(connections)),
			(p) => p.route.incarnation === incarnation,
		),
		HashMap.filter(connections, (p) => p.route.incarnation !== incarnation),
	])
	const scopes = yield* Ref.modify(runtime.state, (state) => {
		const views = HashMap.map(state.views, (v) => ({
			...v,
			protocols: HashMap.filter(
				v.protocols,
				(p) => p.route.incarnation !== incarnation,
			),
		}))
		const retired = Array.flatMap(
			Array.fromIterable(HashMap.values(state.views)),
			(v) =>
				Array.map(
					Array.filter(
						Array.fromIterable(HashMap.values(v.protocols)),
						(p) => p.route.incarnation === incarnation,
					),
					(p) => p.scope,
				),
		)
		const empty = Array.map(
			Array.filter(
				Array.fromIterable(HashMap.values(views)),
				(v) => HashMap.size(v.protocols) === 0,
			),
			(v) => v.scope,
		)
		return [
			HashSet.fromIterable([
				...Array.map(connections, (p) => p.scope),
				...retired,
				...empty,
			]),
			{
				...state,
				active: HashMap.filter(
					state.active,
					(p) => p.route.incarnation !== incarnation,
				),
				views: HashMap.filter(views, (v) => HashMap.size(v.protocols) > 0),
			},
		]
	})
	yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), {
		discard: true,
	})
})
export const make = Effect.fnUntraced(function* (
	services: ReadonlyArray<Contract.Service>,
	emit: (message: Wire.CallMessage) => Effect.Effect<void>,
): Effect.fn.Return<Router, never, Scope.Scope | SecureRandom.SecureRandom> {
	const random = yield* SecureRandom.SecureRandom
	const slots = yield* Effect.forEach(services, (service) =>
		Effect.gen(function* () {
			const slot: Slot = {
				session: yield* random.uuidV4(),
				service,
				incoming: yield* Queue.bounded<Protocol>(64),

				pinned: yield* Ref.make(HashMap.empty<Id, Protocol>()),
			}
			return [service.key.key, slot] satisfies readonly [string, Slot]
		}),
	).pipe(Effect.map(HashMap.fromIterable))
	const runtime: Runtime = {
		emit,
		waiting: yield* Ref.make(
			HashMap.empty<
				string,
				Deferred.Deferred<Wire.CallControl, RpcClientError.RpcClientError>
			>(),
		),
		connections: yield* Ref.make(HashMap.empty<string, Installed>()),
		owner: yield* Effect.scope,
		slots,
		state: yield* Ref.make<Views>({
			active: HashMap.empty(),
			views: HashMap.empty(),
			discarded: HashSet.empty(),
		}),
	}
	const protocols = HashMap.map(slots, (slot) => protocol(runtime, slot))
	return {
		retire: (incarnation) => retire(runtime, incarnation),
		decide: (command) => decide(runtime, command),
		clientProtocol: (service) =>
			Option.getOrElse(HashMap.get(protocols, service), () =>
				RpcClient.Protocol.of({
					codecFor: RpcSerialization.json.codecFor,
					supportsAck: true,
					supportsTransferables: false,
					run: () => Effect.never,
					send: () => error("The service is not declared by this unit"),
				}),
			),
		install: (token, view) => install(runtime, token, view),
		activate: (token) => activate(runtime, token),
		discard: (token) => discard(runtime, token),
	}
})
