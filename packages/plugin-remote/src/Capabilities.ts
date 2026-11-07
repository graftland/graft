/** Host-brokered capabilities. Credentials never cross the unit boundary. */
import {
	Array,
	Cause,
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
	Result,
	Schema,
	Stream,
	String,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Rpc, RpcGroup, type RpcClientError } from "effect/rpc"

import { type Graft } from "@graftland/graft"

import * as Contract from "./Contract"
import * as Policy from "./Policy"

export class Denied extends Schema.TaggedError<
	Denied,
	{ readonly brand: unique symbol }
>()("CapabilityDenied", {
	reason: Schema.Literals([
		"Unapproved",
		"Revoked",
		"DestinationDenied",
		"FileDenied",
		"ResponseLimit",
		"Unavailable",
	]),
}) {}
export const HttpRequest = Schema.Struct({
	grant: Schema.String,
	url: Schema.String,
})
export type HttpRequest = typeof HttpRequest.Type
export const FileRequest = Schema.Struct({
	grant: Schema.String,
	path: Schema.String,
})
export type FileRequest = typeof FileRequest.Type
export class Broker extends Context.Service<
	Broker,
	{
		readonly http: (
			request: HttpRequest,
		) => Effect.Effect<string, Denied | RpcClientError.RpcClientError>
		readonly read: (
			request: FileRequest,
		) => Effect.Effect<string, Denied | RpcClientError.RpcClientError>
	}
>()("@graftland/plugin-remote/Capabilities/Broker") {}
export const group = RpcGroup.make(
	Contract.operation(
		"@graftland/capabilities/http",
		1,
		Rpc.make("Http", {
			payload: HttpRequest,
			success: Schema.String,
			error: Denied,
		}),
	),
	Contract.operation(
		"@graftland/capabilities/read",
		1,
		Rpc.make("Read", {
			payload: FileRequest,
			success: Schema.String,
			error: Denied,
		}),
	),
)
export const service = Contract.service(Broker, group, {
	toHandlers: (value) => ({
		Http: (request) =>
			value.http(request).pipe(Effect.catchTag("RpcClientError", Effect.die)),
		Read: (request) =>
			value.read(request).pipe(Effect.catchTag("RpcClientError", Effect.die)),
	}),
	fromClient: (client) => ({ http: client.Http, read: client.Read }),
})
/** Creates a broker for one verified candidate; every capability request rechecks approval. */
export const make = Effect.fnUntraced(function* (
	entry: string,
	candidate: string,
	assignment: Policy.Assignment,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const environment = yield* Effect.context<Graft.Graft>()
	const admitted = Policy.check(entry, candidate).pipe(
		Effect.provideContext(environment),
		Effect.mapError((error) =>
			Denied.make({
				reason: error.reason === "Revoked" ? "Revoked" : "Unapproved",
			}),
		),
	)
	const clientContext = yield* Layer.build(FetchHttpClient.layer)
	const http = Context.get(clientContext, HttpClient.HttpClient)
	const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.timeout("5 seconds"),
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					yield* Effect.logError("Host capability failed", cause)
					if (Cause.hasInterrupts(cause))
						return yield* Effect.failCause(
							Cause.fromReasons<never>(
								Array.filter(cause.reasons, Cause.isInterruptReason),
							),
						)
					const error = Cause.findError(cause)
					if (Result.isSuccess(error) && Schema.is(Denied)(error.success)) {
						const denied: Denied = error.success
						return yield* denied
					}
					return yield* Denied.make({ reason: "Unavailable" })
				}),
			),
		)

	return Broker.of({
		http: (request) =>
			Effect.gen(function* () {
				yield* admitted
				const grant = Array.findFirst(
					assignment.grants,
					(grant) => grant._tag === "Http" && grant.id === request.grant,
				)
				if (Option.isNone(grant) || grant.value._tag !== "Http")
					return yield* Denied.make({ reason: "DestinationDenied" })
				const url = yield* Effect.try({
					try: () => new URL(request.url),
					catch: () => Denied.make({ reason: "DestinationDenied" }),
				})
				if (
					url.origin !== grant.value.origin ||
					url.username !== "" ||
					url.password !== "" ||
					!["https:", "http:"].includes(url.protocol)
				)
					return yield* Denied.make({ reason: "DestinationDenied" })
				const credential =
					grant.value.credential === undefined
						? undefined
						: yield* Config.Redacted(grant.value.credential)
				return yield* safe(
					Effect.gen(function* () {
						const response = yield* http
							.get(url.href, {
								headers:
									credential === undefined
										? {}
										: { Authorization: Redacted.value(credential) },
							})
							.pipe(
								Effect.provideService(FetchHttpClient.RequestInit, {
									redirect: "manual",
								}),
							)
						if (response.status >= 300 && response.status < 400)
							return yield* Denied.make({ reason: "DestinationDenied" })
						const bytes = yield* Stream.runFoldEffect(
							response.stream,
							() => new Uint8Array(),
							(before, chunk) =>
								before.byteLength + chunk.byteLength > 1048576
									? Denied.make({ reason: "ResponseLimit" })
									: Effect.succeed(new Uint8Array([...before, ...chunk])),
						)
						return new TextDecoder().decode(bytes)
					}).pipe(Effect.scoped),
				)
			}).pipe(
				Effect.catchTag("ConfigError", (error) =>
					Effect.logError("Host credential unavailable", error).pipe(
						Effect.andThen(Denied.make({ reason: "Unavailable" })),
					),
				),
			),

		read: (request) =>
			Effect.gen(function* () {
				yield* admitted
				const grant = Array.findFirst(
					assignment.grants,
					(grant) => grant._tag === "Files" && grant.id === request.grant,
				)
				if (Option.isNone(grant) || grant.value._tag !== "Files")
					return yield* Denied.make({ reason: "FileDenied" })
				const directory = grant.value.directory
				return yield* safe(
					Effect.gen(function* () {
						const root = yield* fs.realPath(directory)
						const target = yield* fs.realPath(path.resolve(root, request.path))
						const relative = path.relative(root, target)
						if (
							path.isAbsolute(relative) ||
							relative === ".." ||
							String.startsWith("../")(relative)
						)
							return yield* Denied.make({ reason: "FileDenied" })
						const stat = yield* fs.stat(target)
						if (stat.type !== "File")
							return yield* Denied.make({ reason: "FileDenied" })
						const bytes = yield* Stream.runFoldEffect(
							fs.stream(target, { bytesToRead: 1048577 }),
							() => new Uint8Array(),
							(before, chunk) =>
								before.byteLength + chunk.byteLength > 1048576
									? Denied.make({ reason: "ResponseLimit" })
									: Effect.succeed(new Uint8Array([...before, ...chunk])),
						)
						return new TextDecoder().decode(bytes)
					}),
				)
			}),
	})
})
