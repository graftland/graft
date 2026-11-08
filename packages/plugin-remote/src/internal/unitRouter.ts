/** Stable unit-local RPC protocols whose physical endpoints follow installed core views. */
import {
	Array,
	Cause,
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
import {
	RpcClient,
	RpcClientError,
	RpcSerialization,
	type RpcMessage,
} from "effect/rpc"
import type { Socket } from "effect/socket"

import type { Kernel } from "@graftland/graft"

import type * as Contract from "../Contract"
import * as Network from "./unitNetwork"
import type * as Wire from "./unitProtocol"

type Protocol = RpcClient.Protocol["Service"]
type Id = RpcMessage.RequestEncoded["id"]
interface Slot {
	readonly service: Contract.Service
	readonly incoming: Queue.Queue<Protocol>
	readonly pinned: Ref.Ref<HashMap.HashMap<Id, Protocol>>
}
interface Staged {
	readonly scope: Scope.Closeable
	readonly protocols: HashMap.HashMap<string, Installed>
}
interface Installed {
	readonly protocol: Protocol
	readonly version: number
}
interface Views {
	readonly active: HashMap.HashMap<string, Installed>
	readonly views: HashMap.HashMap<string, Staged>
	readonly discarded: HashSet.HashSet<string>
}
interface Runtime {
	readonly owner: Scope.Scope
	readonly slots: HashMap.HashMap<string, Slot>
	readonly state: Ref.Ref<Views>
}
export interface Router {
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
const send = Effect.fnUntraced(function* (
	runtime: Runtime,
	slot: Slot,
	client: number,
	message: RpcMessage.FromClientEncoded,
): Effect.fn.Return<void, RpcClientError.RpcClientError> {
	const known = yield* Ref.get(slot.pinned)
	const active = yield* Ref.get(runtime.state)
	const current = Option.map(
		HashMap.get(active.active, slot.service.key.key),
		(i) => i.protocol,
	)
	const selected =
		message._tag === "Request"
			? current
			: message._tag === "Ack" || message._tag === "Interrupt"
				? HashMap.get(known, message.requestId)
				: current
	if (Option.isNone(selected))
		return yield* error("The binding has no installed endpoint")
	if (message._tag === "Request")
		yield* Ref.update(slot.pinned, HashMap.set(message.id, selected.value))
	yield* selected.value.send(client, metadata(message))
	if (message._tag === "Ack")
		yield* Ref.update(slot.pinned, HashMap.remove(message.requestId))
})
const run = (
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
							if (frame._tag !== "ClientProtocolError")
								return yield* receive(frame)
							const pinned = yield* Ref.get(slot.pinned)
							const ids = Array.flatMap(
								Array.fromIterable(pinned),
								([id, p]) => (p === protocol ? [id] : []),
							)
							yield* receive({ ...frame, requestIds: ids })
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
		run: (client, receive) => run(slot, client, receive),
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
				const connection = yield* Network.client(route.value, [
					slot.service,
				]).pipe(Scope.provide(scope))
				const selected = connection.clientProtocol(name)
				yield* Queue.offer(slot.incoming, selected)
				return [
					name,
					{ protocol: selected, version: route.value.version },
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
export const make = Effect.fnUntraced(function* (
	services: ReadonlyArray<Contract.Service>,
): Effect.fn.Return<Router, never, Scope.Scope> {
	const slots = yield* Effect.forEach(services, (service) =>
		Effect.gen(function* () {
			const slot: Slot = {
				service,
				incoming: yield* Queue.unbounded<Protocol>(),

				pinned: yield* Ref.make(HashMap.empty<Id, Protocol>()),
			}
			return [service.key.key, slot] satisfies readonly [string, Slot]
		}),
	).pipe(Effect.map(HashMap.fromIterable))
	const runtime: Runtime = {
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
