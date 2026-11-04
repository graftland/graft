import { Plugin } from "@graftland/graft"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { MtlsAuthenticator, NoAuthenticator, type Authenticator } from "../Auth"
import { Directory } from "../internal/config"
import { createSecureServer } from "node:http2"
import { Url, path as upgradePath } from "../internal/websocket"
import * as Listener from "../internal/listener"
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
const auth = Schema.String.pipe(
	Schema.withDecodingDefaultKey(Effect.succeed(NoAuthenticator.key)),
)
export const Config = Schema.Union([
	Schema.Struct({
		url: url("ws:"),
		cert: Schema.optionalKey(Schema.Never),
		key: Schema.optionalKey(Schema.Never),
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
		url: url("wss:"),
		cert: Schema.String,
		key: Schema.String,
		auth,
	}).pipe(
		Schema.extendTo(
			{ _tag: Schema.Literal("wss") },
			{ _tag: () => Option.some<"wss">("wss") },
		),
	),
])

const factory = Effect.fnUntraced(function* (
	config: typeof Config.Type,
	auth: Authenticator,
) {
	if (config._tag === "ws") return createServer
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* Directory
	const cert = yield* fs.readFileString(path.resolve(directory, config.cert))
	const key = yield* fs.readFileString(path.resolve(directory, config.key))
	return () =>
		createSecureServer({
			allowHTTP1: true,
			cert,
			key,
			minVersion: "TLSv1.3",
			...(auth._tag === "Mtls"
				? { ca: auth.ca, requestCert: true, rejectUnauthorized: true }
				: {}),
		})
})
const bind = Effect.fnUntraced(function* (
	config: typeof Config.Type,
	auth: Authenticator,
) {
	const server = yield* factory(config, auth)
	return {
		server,
		address: {
			host: config.url.hostname,
			port: Number(config.url.port || (config._tag === "wss" ? 443 : 80)),
		},
		listening: (address) => ({
			port: address._tag === "UnixPathAddress" ? null : address.port,
		}),
	} satisfies Listener.Binding
})
export default Plugin.make({
	name: "remote-websocket-listener",
	config: Config,
	apply: (config) =>
		Listener.start({
			auth: config.auth,
			protocol: config._tag,
			inject: [FileSystem.FileSystem, Path.Path],
			bind: (auth) => bind(config, auth),
		}),
})
