import { Graft, Plugin, type Fork } from "@graftland/graft"
import { Cause, Effect, Schema, type Scope } from "effect"
import type { Target, Mtls, None } from "../Targets"
import { Credentials, type Prepared } from "../Auth"
import { Connector, LocalTransport, WorkerTransport } from "../Transport"
import { CredentialsError } from "../Errors"
import local from "../host/local"
import worker from "../host/worker"
import { make as websocket } from "../host/websocket"
import * as Websocket from "./websocket"
import * as Assembly from "./assembly"
import { direct } from "./entry"
import type { ConfiguredRunner } from "./runner/Connection"

/** TS credentials are providers too; their declared dependencies belong to their own activation. */
const credentials = <D extends ReadonlyArray<Plugin.Dependency>>(
	auth: Mtls<D> | None | undefined,
) => {
	if (auth === undefined || auth._tag === "None")
		return Plugin.service(
			Credentials,
			Effect.succeed({ kind: "None", read: Effect.succeed({ _tag: "None" }) }),
			{ name: "remote-none-credentials" },
		)
	return Plugin.make({
		name: "remote-ts-credentials",
		inject: auth.inject,
		apply: Effect.fnUntraced(function* () {
			const context = yield* Effect.context<Plugin.Required<D>>()
			yield* Graft.provide(Credentials, {
				kind: "Certificate",
				read: auth.read.pipe(
					Effect.provideContext(context),
					Effect.mapBoth({
						onSuccess: (
							value,
						): Extract<Prepared, { readonly _tag: "Certificate" }> => ({
							_tag: "Certificate",
							value,
						}),
						onFailure: (error) =>
							CredentialsError.make({ cause: Cause.fail(error) }),
					}),
				),
			})
		}),
	})
}
export const launch = <D extends ReadonlyArray<Plugin.Dependency>>(
	target: Target<D>,
	input: Schema.Json,
	consumer: (target: Target<D> | ConfiguredRunner) => Plugin.Plugin,
): Effect.Effect<
	Fork.Fork<never, unknown>,
	never,
	Graft.Graft | Scope.Scope
> => {
	if (target._tag === "Local" || target._tag === "Worker")
		return direct(
			target._tag === "Local" ? local : worker,
			consumer(target),
			input,
			target._tag === "Local" ? LocalTransport : WorkerTransport,
		)
	if (
		target.transport._tag !== "Websocket" ||
		(target.auth !== undefined &&
			target.auth._tag !== "Mtls" &&
			target.auth._tag !== "None")
	)
		// Remaining keyed transports and token authenticators migrate in phase C.
		return Graft.plugin(consumer(target), input)
	const options = target.transport
	const transport = Plugin.service(
		Connector,
		Schema.decodeEffect(Websocket.Url)(options.url).pipe(
			Effect.map((url) => websocket(options, Websocket.properties(url))),
		),
		{ name: "remote-ts-websocket" },
	)
	return Assembly.host({
		transport: { plugin: transport, config: undefined },
		auth: { plugin: credentials(target.auth), config: undefined },
		consumer: consumer({
			_tag: "Connector",
			...(target.instance === undefined ? {} : { instance: target.instance }),
			...(target.lease === undefined ? {} : { lease: target.lease }),
			...(target.margin === undefined ? {} : { margin: target.margin }),
			...(target.expect === undefined ? {} : { expect: target.expect }),
		}),
		input,
	})
}
