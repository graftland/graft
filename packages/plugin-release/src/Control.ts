import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	// @effect-diagnostics-next-line nodeBuiltinImport:off -- Unix socket control is a Node transport adapter.
} from "node:http"
import { createConnection } from "node:net"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	FiberSet,
	FileSystem,
	Schema,
} from "effect"

import * as Policy from "@graftland/plugin-remote/Policy"

import { failure, json, protect } from "./internal/storage"
import {
	Apply,
	Build,
	Id,
	ReleaseError,
	summarize,
	summarizeRejection,
	type Releases,
} from "./Model"

export const Request = Schema.Union([
	Schema.TaggedStruct("approvals", {}),
	Schema.TaggedStruct("approve", { request: Policy.Approve }),
	Schema.TaggedStruct("revoke", {
		references: Schema.Array(Schema.NonEmptyString),
		who: Schema.NonEmptyString,
	}),
	Schema.TaggedStruct("build", { request: Build }),
	Schema.TaggedStruct("plan", { target: Id }),
	Schema.TaggedStruct("apply", { request: Apply }),
	Schema.TaggedStruct("rollback", {
		expected: Id,
		overrideRevocations: Schema.Boolean,
	}),
	Schema.TaggedStruct("history", {}),
	Schema.TaggedStruct("status", {}),
])
export type Request = typeof Request.Type
export const Reply = Schema.Struct({ ok: Schema.Boolean, value: Schema.Json })
export type Reply = typeof Reply.Type
const body = (message: IncomingMessage) =>
	Effect.callback<string, ReleaseError>((resume) => {
		let text = ""
		let bytes = 0
		message.setEncoding("utf8")
		message.on("data", (chunk: string) => {
			text += chunk
			bytes += new TextEncoder().encode(chunk).byteLength
			if (bytes > 1024 * 1024) {
				resume(failure("Control", "Control message exceeds one MiB"))
				message.destroy()
			}
		})
		message.once("end", () => resume(Effect.succeed(text)))
		message.once("error", (error) =>
			resume(
				ReleaseError.make({
					code: "Control",
					message: "Control connection failed",
					cause: Cause.fail(error),
				}),
			),
		)
		return Effect.sync(() => {
			if (!message.complete) message.destroy()
		})
	})
const applied = (value: import("./Model").Applied): Reply => ({
	ok: Array.every(
		value.outcomes,
		(item) => item._tag === "Admitted" && item.outcome._tag === "Accepted",
	),
	value: {
		status: value.status,
		outcomes: Array.map(value.outcomes, (item): Schema.Json =>
			item._tag === "Admitted"
				? {
						_tag: item._tag,
						entry: item.entry,
						compensation: item.compensation,
						outcome: summarize(item.outcome),
						phase: item.outcome.phase,
					}
				: {
						_tag: item._tag,
						entry: item.entry,
						compensation: item.compensation,
						rejection: summarizeRejection(item.rejection),
					},
		),
	},
})
export const dispatch = Effect.fnUntraced(function* (
	service: Releases["Service"],
	request: Request,
): Effect.fn.Return<Reply, ReleaseError> {
	switch (request._tag) {
		case "approvals":
			return { ok: true, value: yield* service.approvals }
		case "approve":
			return { ok: true, value: yield* service.approve(request.request) }
		case "revoke":
			yield* service.revoke(request.references, request.who)
			return { ok: true, value: null }
		case "build":
			return { ok: true, value: yield* service.build(request.request) }
		case "plan": {
			const plan = yield* service.plan(request.target)
			return {
				ok: plan.diagnostics.length === 0,
				value: {
					...plan,
					diagnostics: Array.map(plan.diagnostics, (item) => ({
						code: item.code,
						entry: item.entry,
						message: item.message,
					})),
				},
			}
		}
		case "apply": {
			const result = yield* service.apply(request.request)
			return applied(result)
		}
		case "rollback": {
			const result = yield* service.rollback(
				request.expected,
				request.overrideRevocations,
			)
			return applied(result)
		}
		case "history":
			return { ok: true, value: yield* service.history }
		case "status":
			return { ok: true, value: yield* service.observe }
	}
})
/** Scoped Unix socket. Directory permissions are the operator's authentication boundary. */
export const serve = Effect.fnUntraced(function* (
	socket: string,
	service: Releases["Service"],
) {
	const fs = yield* FileSystem.FileSystem
	if (yield* fs.exists(socket)) {
		const live = yield* Effect.callback<boolean, ReleaseError>((resume) => {
			const connection = createConnection(socket)
			connection.once("connect", () => resume(Effect.succeed(true)))
			connection.once("error", (error: NodeJS.ErrnoException) =>
				resume(
					error.code === "ECONNREFUSED"
						? Effect.succeed(false)
						: ReleaseError.make({
								code: "Control",
								message: "Cannot inspect existing control socket",
								cause: Cause.fail(error),
							}),
				),
			)
			return Effect.sync(() => connection.destroy())
		})
		if (live)
			return yield* failure("Busy", "The control socket already has an owner")
		yield* fs.remove(socket)
	}
	const requests = yield* FiberSet.make<void, never>()
	const run = yield* FiberSet.runtime(requests)<never>()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((request, response) => {
				run(
					body(request).pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.fromJsonString(Request)),
						),
						Effect.flatMap((request) => dispatch(service, request)),
						Effect.catchTag("ReleaseError", (error) =>
							Effect.succeed<Reply>({
								ok: false,
								value: { code: error.code, message: error.message },
							}),
						),
						// Intentional public redaction: raw causes may contain decoded secrets.
						Effect.catchCause(() =>
							Effect.succeed<Reply>({
								ok: false,
								value: {
									code: "Rejected",
									message:
										"Request rejected; inspect plan or application state",
								},
							}),
						),
						Effect.flatMap((reply) => json(reply)),
						Effect.matchCauseEffect({
							onFailure: () =>
								Effect.sync(() => {
									response.statusCode = 500
									response.end()
								}),
							onSuccess: (text) =>
								Effect.sync(() => {
									response.setHeader("content-type", "application/json")
									response.end(text)
								}),
						}),
					),
				)
			}),
		),
		(server) =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections()
				server.close((error) =>
					resume(error === undefined ? Effect.void : Effect.die(error)),
				)
			}),
	)
	yield* Effect.callback<void, ReleaseError>((resume) => {
		server.once("error", (error) =>
			resume(
				ReleaseError.make({
					code: "Control",
					message: "Cannot bind control socket",
					cause: Cause.fail(error),
				}),
			),
		)
		server.listen(socket, () => resume(Effect.void))
	})
	yield* fs.chmod(socket, 0o600)
}, protect)
/** One bounded local request. A disconnected caller does not cancel an admitted apply. */
export const call = Effect.fnUntraced(
	function* (socket: string, request: Request) {
		const text = yield* json(request)
		const headers = yield* Deferred.make<IncomingMessage, ReleaseError>()
		const client = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const client = httpRequest({
					socketPath: socket,
					path: "/",
					method: "POST",
					headers: { "content-type": "application/json" },
				})
				client.once("response", (response) =>
					Deferred.doneUnsafe(headers, Effect.succeed(response)),
				)
				client.once("error", (error) =>
					Deferred.doneUnsafe(
						headers,
						ReleaseError.make({
							code: "Control",
							message: "Cannot reach the release plugin",
							cause: Cause.fail(error),
						}),
					),
				)
				return client
			}),
			(client) => Effect.sync(() => client.destroy()),
		)
		yield* Effect.sync(() => client.end(text))
		const incoming = yield* Deferred.await(headers)
		return yield* body(incoming).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))),
		)
	},
	Effect.scoped,
	Effect.timeout("10 minutes"),
	protect,
)
