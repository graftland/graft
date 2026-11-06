import {
	Array,
	Context,
	Deferred,
	Effect,
	Layer,
	Queue,
	Ref,
	Schema,
	type Duration,
} from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { RpcSerialization, RpcServer, type RpcMessage } from "effect/rpc"

import { Graft, Plugin } from "@graftland/graft"

import * as Catalog from "./Catalog"
import * as Resources from "./Resources"
import { Server } from "./Server"
import * as Tools from "./Tools"

/** Raw JSON-RPC connection; tests can inspect interim results and notifications. */
export interface Connection {
	readonly send: (message: McpSchema.JsonRpcMessage) => Effect.Effect<void>
	readonly receive: Effect.Effect<McpSchema.JsonRpcMessage>
	readonly end: Effect.Effect<void>
	readonly closed: Effect.Effect<void>
}

const json = Schema.fromJsonString(McpSchema.JsonRpcMessage)
export const encode = Schema.encodeEffect(json)
export const decode = Schema.decodeUnknownEffect(json)

/** In-memory transport, loaded as an ordinary sibling of the core. */
export const transport = Effect.gen(function* () {
	const input = yield* Queue.unbounded<string>()
	const output = yield* Queue.unbounded<string>()
	const closed = yield* Deferred.make<void>()
	const ready = yield* Deferred.make<void>()
	const serialization = RpcSerialization.jsonRpc()
	const protocol = Layer.effect(
		RpcServer.Protocol,
		RpcServer.Protocol.make(
			Effect.fnUntraced(function* (write) {
				const parser = serialization.makeUnsafe()
				const disconnects = yield* Queue.unbounded<number>()
				const connected = yield* Ref.make(true)
				yield* Queue.take(input).pipe(
					Effect.flatMap((frame) =>
						Effect.forEach(
							parser.decode(
								frame,
							) as ReadonlyArray<RpcMessage.FromClientEncoded>,
							(message) => write(0, message),
							{ discard: true },
						),
					),
					Effect.forever,
					Effect.onExit(() =>
						Ref.set(connected, false).pipe(
							Effect.andThen(Queue.offer(disconnects, 0)),
							Effect.andThen(Deferred.succeed(closed, undefined)),
						),
					),
					Effect.forkScoped,
				)
				return {
					disconnects,
					send: (_id, response) => {
						const frame = parser.encode(response)
						return typeof frame === "string"
							? Effect.asVoid(Queue.offer(output, frame))
							: Effect.void
					},
					end: () => Effect.asVoid(Deferred.succeed(closed, undefined)),
					clientIds: Ref.get(connected).pipe(
						Effect.map((live) => new Set(live ? [0] : [])),
					),
					initialMessage: Effect.succeedNone,
					supportsAck: false,
					supportsTransferables: false,
					supportsSpanPropagation: false,
					supportsNotifications: true,
					codecFor: serialization.codecFor,
				}
			}),
		),
	)
	const plugin = Plugin.make({
		name: "@graftland/plugin-mcp-server/testing",
		inject: [Server],
		apply: Effect.fnUntraced(function* () {
			const options = yield* (yield* Server).options
			yield* Layer.build(McpServer.layer(options).pipe(Layer.provide(protocol)))
			yield* Deferred.succeed(ready, undefined)
		}),
	})
	const connection: Connection = {
		send: (message) =>
			encode(message).pipe(
				Effect.orDie,
				Effect.flatMap((frame) => Queue.offer(input, frame)),
				Effect.asVoid,
			),
		receive: Queue.take(output).pipe(Effect.flatMap(decode), Effect.orDie),
		end: Effect.asVoid(Queue.shutdown(input)),
		closed: Deferred.await(closed),
	}
	return { plugin, client: Deferred.await(ready).pipe(Effect.as(connection)) }
})

/** 2026 metadata keys come from the MCP 2026-07-28 lifecycle specification. */
export const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
} as const

/** Read through notifications until the response for a request arrives. */
export const response = (
	connection: Connection,
	id: string | number,
): Effect.Effect<McpSchema.JsonRpcResponse> =>
	connection.receive.pipe(
		// @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off -- unmatched frames are consumed recursively rather than rejected
		Effect.flatMap((message) =>
			"id" in message && message.id === id && !("method" in message)
				? Effect.succeed(message)
				: response(connection, id),
		),
	)

const check = (condition: boolean, message: string) =>
	condition ? Effect.void : Effect.die(message)

/** Shared transport contract. The caller owns Graft and supplies a fresh connection. */
export const transportConformance = <E, R>(
	plugin: Plugin.Plugin<void>,
	connect: Effect.Effect<Connection, E, R>,
	expected: {
		readonly name: string
		readonly version: string
		readonly protocols: ReadonlyArray<string>
		readonly close?: Effect.Effect<void>
		/** Maximum time for close and disconnection; defaults to five seconds. */
		readonly closeTimeout?: Duration.Input
	},
) =>
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(plugin)
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- third-party errors are preserved as defects by this assertion harness
		yield* fork.await.pipe(Effect.orDie)
		const client = yield* connect
		yield* client.send({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: { _meta: metadata },
		})
		const discovery = yield* response(client, 1)
		const info = (
			discovery.result as
				| {
						_meta?: {
							"io.modelcontextprotocol/serverInfo"?: {
								name: string
								version: string
							}
						}
				  }
				| undefined
		)?._meta?.["io.modelcontextprotocol/serverInfo"]
		yield* check(
			info?.name === expected.name && info.version === expected.version,
			"Discovery must preserve the core's name and version",
		)
		yield* client.send({
			jsonrpc: "2.0",
			id: 10,
			method: "subscriptions/listen",
			params: {
				notifications: {
					toolsListChanged: true,
					resourceSubscriptions: ["test://conformance"],
				},
				_meta: metadata,
			},
		})
		const ack = yield* client.receive
		yield* check(
			"method" in ack &&
				ack.method === "notifications/subscriptions/acknowledged",
			"Listen must be acknowledged",
		)
		{
			const versions = (
				discovery.result as { supportedVersions: ReadonlyArray<string> }
			).supportedVersions
			yield* check(
				versions.length === expected.protocols.length &&
					Array.every(versions, (version) =>
						expected.protocols.includes(version),
					),
				"The transport must honor protocol filtering",
			)
		}
		const started = yield* Deferred.make<void>()
		const stopped = yield* Deferred.make<void>()
		const kit = Toolkit.make(
			Tool.make("conformance", { success: Schema.String }),
			Tool.make("cancel", { success: Schema.String }),
		)
		const contributor = yield* Graft.plugin(
			Tools.plugin({
				name: "@graftland/plugin-mcp-server/testing/contributor",
				toolkit: kit,
				handlers: Effect.succeed(
					kit.of({
						conformance: () => Effect.succeed("served"),
						cancel: () =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Deferred.succeed(stopped, undefined)),
							),
					}),
				),
			}),
		)
		yield* contributor.await
		const changed = yield* client.receive
		yield* check(
			"method" in changed &&
				changed.method === "notifications/tools/list_changed",
			"Contributions must notify the client",
		)
		yield* Resources.updated("test://conformance")
		const updated = yield* client.receive
		yield* check(
			"method" in updated &&
				updated.method === "notifications/resources/updated" &&
				(updated.params?.["_meta"] as Record<string, unknown> | undefined)?.[
					"io.modelcontextprotocol/subscriptionId"
				] === 10,
			"Updates must carry the listen subscription id",
		)
		yield* client.send({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "conformance", arguments: {}, _meta: metadata },
		})
		const result = yield* response(client, 2)
		yield* check(
			(result.result as { structuredContent?: unknown } | undefined)
				?.structuredContent === "served",
			"The transport must serve contributed tools",
		)
		yield* client.send({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "cancel", arguments: {}, _meta: metadata },
		})
		yield* Deferred.await(started)
		yield* client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 3, _meta: metadata },
		})
		yield* Deferred.await(stopped)
		yield* client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 10, _meta: metadata },
		})
		yield* (expected.close ?? client.end).pipe(
			Effect.andThen(client.closed),
			Effect.timeoutOrElse({
				duration: expected.closeTimeout ?? "5 seconds",
				orElse: () =>
					Effect.die(
						"Transport conformance: transport did not stop serving after close within closeTimeout",
					),
			}),
		)
		yield* contributor.dispose
		yield* fork.dispose
	})

/** Shared kind lifetime contract; inspect observes the public protocol list. */
export const kindConformance = <Item, E, R>(
	kind: Catalog.Kind<Item>,
	sample: Item,
	inspect: Effect.Effect<ReadonlyArray<string>, E, R>,
	ownDisabled?: Item,
	changed?: Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		const contributor = (offeredKind = kind) =>
			Plugin.make({
				name: "@graftland/plugin-mcp-server/testing/kind",
				apply: () => Catalog.offer(offeredKind, sample),
			})
		const first = yield* Graft.plugin(contributor())
		yield* first.await
		if (changed !== undefined) yield* changed
		const ids = kind.identities(sample)
		const listed = yield* inspect
		yield* check(
			Array.every(ids, (id) => listed.includes(id)),
			"The kind must expose its item",
		)
		const second = yield* Graft.plugin(
			contributor({ ...kind, key: kind.key + "/competing" }),
		)
		yield* second.await
		if (changed !== undefined) yield* changed
		const conflicting = yield* inspect
		yield* check(
			Array.every(ids, (id) => !conflicting.includes(id)),
			"The kind must hide every conflicting party",
		)
		yield* second.dispose
		if (changed !== undefined) yield* changed
		yield* first.dispose
		if (changed !== undefined) yield* changed
		const withdrawn = yield* inspect
		yield* check(
			Array.every(ids, (id) => !withdrawn.includes(id)),
			"The kind must hide withdrawn items",
		)
		const disabledKind: Catalog.Kind<Item> = {
			...kind,
			key: kind.key + "/disabled",
			install: (item, annotations) =>
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the public kind erases its error type; the projection logs the full cause
				kind.install(
					item,
					Context.add(annotations, McpSchema.EnabledWhen, () => false),
				),
		}
		const disabled = yield* Graft.plugin(
			Plugin.make({
				name: "test/disabled-kind",
				apply: () => Catalog.offer(disabledKind, sample),
			}),
		)
		yield* disabled.await
		const hidden = yield* inspect
		yield* check(
			Array.every(ids, (id) => !hidden.includes(id)),
			"The kind must honour EnabledWhen",
		)
		yield* disabled.dispose
		if (ownDisabled !== undefined) {
			const own = yield* Graft.plugin(
				Plugin.make({
					name: "test/own-disabled-kind",
					apply: () => Catalog.offer(kind, ownDisabled),
				}),
			)
			yield* own.await
			const hiddenOwn = yield* inspect
			yield* check(
				Array.every(
					kind.identities(ownDisabled),
					(id) => !hiddenOwn.includes(id),
				),
				"The kind must honour the item's own EnabledWhen",
			)
			yield* own.dispose
		}
		const failing: Catalog.Kind<Item> = {
			...kind,
			key: kind.key + "/failed",
			install: (item, annotations) =>
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the public kind erases its error type; the projection logs the full cause
				kind
					.install(item, annotations)
					.pipe(Effect.andThen(Effect.die("Conformance install failure"))),
		}
		const failed = yield* Graft.plugin(
			Plugin.make({
				name: "test/failed-kind",
				apply: () => Catalog.offer(failing, sample),
			}),
		)
		yield* failed.await
		const partial = yield* inspect
		yield* check(
			Array.every(ids, (id) => !partial.includes(id)),
			"A failed install must remain hidden",
		)
		yield* failed.dispose
	})
