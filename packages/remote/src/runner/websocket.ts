import { Graft, Plugin } from "@graftland/graft"
import {
	Cause,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
} from "effect"
import {
	MtlsAuthenticator,
	NoAuthenticator,
	type LegacyAuthenticator,
} from "../Auth"
import { ConfigDirectory } from "@graftland/loader"
import { createSecureServer } from "node:http2"
import { Url, path as upgradePath } from "../internal/websocket"
import * as Legacy from "../internal/listener"
import { Listener } from "../Transport"
import type { TlsPolicy } from "../Auth"
import { TransportError } from "../Errors"
import * as Server from "../internal/websocketServer"
import { properties } from "../internal/websocket"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for an HTTP/1.1 upgrade server
import { createServer } from "node:http"

const url = (protocol: "ws:" | "wss:") =>
	Url.check(
		Schema.makeFilter((url) => url.protocol === protocol, {
			expected: protocol + "//",
		}),
		Schema.makeFilter(
			(url) => url.pathname === "/" || url.pathname === upgradePath,
			{
				expected: "a listener URL with no path or /graft",
			},
		),
	)
const ws = {
	url: url("ws:"),
	cert: Schema.optionalKey(Schema.Never),
	key: Schema.optionalKey(Schema.Never),
}
const wss = { url: url("wss:"), cert: Schema.String, key: Schema.String }
const auth = Schema.String.pipe(
	Schema.withDecodingDefaultKey(Effect.succeed(NoAuthenticator.key)),
)
export const Config = Schema.Union([
	Schema.Struct({
		...ws,
		auth: auth.check(
			Schema.makeFilter((key) => key !== MtlsAuthenticator.key, {
				expected: "wss:// for mutual TLS",
			}),
		),
	}).pipe(
		Schema.extendTo(
			{ _tag: Schema.Literal("ws") },
			{ _tag: () => Option.some<"ws">("ws") },
		),
	),
	Schema.Struct({
		...wss,
		auth,
	}).pipe(
		Schema.extendTo(
			{ _tag: Schema.Literal("wss") },
			{ _tag: () => Option.some<"wss">("wss") },
		),
	),
])

export const TransportConfig = Schema.Union([
	Schema.Struct({
		...ws,
	}).pipe(
		Schema.extendTo(
			{ _tag: Schema.Literal("ws") },
			{ _tag: () => Option.some<"ws">("ws") },
		),
	),
	Schema.Struct({
		...wss,
	}).pipe(
		Schema.extendTo(
			{ _tag: Schema.Literal("wss") },
			{ _tag: () => Option.some<"wss">("wss") },
		),
	),
])

const factory = Effect.fnUntraced(function* (
	config: typeof TransportConfig.Type,
	tls: Option.Option<TlsPolicy>,
) {
	if (config._tag === "ws") return createServer
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* ConfigDirectory.pipe(
		Effect.map(Option.getOrElse(() => ".")),
	)
	const cert = yield* fs.readFileString(path.resolve(directory, config.cert))
	const key = yield* fs.readFileString(path.resolve(directory, config.key))
	return () =>
		createSecureServer({
			allowHTTP1: true,
			cert,
			key,
			minVersion: "TLSv1.3",
			...Option.match(tls, {
				onNone: () => ({}),
				onSome: (tls) => ({ ...tls, ca: [...tls.ca] }),
			}),
		})
})
const bind = Effect.fnUntraced(function* (
	config: typeof Config.Type,
	auth: LegacyAuthenticator,
) {
	const server = yield* factory(
		config,
		auth._tag === "Mtls"
			? Option.some({
					ca: [auth.ca],
					minVersion: "TLSv1.3",
					requestCert: true,
					rejectUnauthorized: true,
				})
			: Option.none(),
	)
	return {
		server,
		address: {
			host: config.url.hostname,
			port: Number(config.url.port || (config._tag === "wss" ? 443 : 80)),
		},
		listening: (address) => ({
			port: address._tag === "UnixPathAddress" ? null : address.port,
		}),
	} satisfies Legacy.Binding
})
export const legacy = Plugin.make({
	name: "remote-websocket-listener",
	config: Config,
	apply: (config) =>
		Legacy.start({
			auth: config.auth,
			protocol: config._tag,
			inject: [FileSystem.FileSystem, Path.Path],
			bind: (auth) => bind(config, auth),
		}),
})

/** Configured Listener; authentication is supplied to bind, never injected here. */
export const capability = Plugin.make({
	name: "remote-websocket-capability",
	config: TransportConfig,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory.pipe(
			Effect.map(Option.getOrElse(() => ".")),
		)
		yield* Graft.provide(Listener, {
			properties: properties(config.url),
			bind: (tls) =>
				factory(config, tls).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
					Effect.provideService(ConfigDirectory, Option.some(directory)),
					Effect.flatMap((server) =>
						Server.bind(server, {
							host: config.url.hostname,
							port: Number(
								config.url.port || (config._tag === "wss" ? 443 : 80),
							),
						}),
					),
					Effect.mapBoth({
						onSuccess: (server) => ({
							ready: server.ready.pipe(
								Effect.andThen(
									Schema.encodeEffect(Listening)({
										event: "Listening",
										port:
											server.address._tag === "UnixPathAddress"
												? null
												: server.address.port,
									}).pipe(Effect.orDie, Effect.flatMap(Console.log)),
								),
							),
							serve: server.serve,
						}),
						onFailure: (error) =>
							TransportError.make({ cause: Cause.fail(error) }),
					}),
				),
		})
	}),
})
const Listening = Schema.fromJsonString(
	Schema.Struct({
		event: Schema.Literal("Listening"),
		port: Schema.NullOr(Schema.Int),
	}),
)

export default capability
