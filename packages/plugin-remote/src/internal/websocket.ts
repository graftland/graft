import { Array, Effect, Layer, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"

import WS from "ws"

import type { ClientCertificate } from "../Auth"
import type { Properties } from "../Transport"
import { headerSize, maxPayload } from "./runner/Framing"
import type { WebsocketOptions } from "./transportOptions"

interface PreparedCredentials {
	readonly certificate?: ClientCertificate
	readonly authorization?: Redacted.Redacted<string>
}

export const protocol = "graft-remote.v1"
export const path = "/graft"
export const payloadLimit = maxPayload + headerSize
export const Url = Schema.URLFromString.check(
	Schema.makeFilter(
		(url) => url.protocol === "wss:" || url.protocol === "ws:",
		{
			expected: "a ws:// or wss:// URL",
		},
	),
)

export const constructor = (
	tls: WebsocketOptions["tls"],
	credentials: PreparedCredentials = {},
) =>
	Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
		const settings =
			typeof options === "object" && !Array.isArray(options)
				? options
				: { protocols: options }
		return new WS(url, settings.protocols, {
			...tls,
			...(credentials.certificate === undefined
				? {}
				: {
						cert: credentials.certificate.cert,
						key: Redacted.value(credentials.certificate.key),
					}),
			headers: {
				...settings.headers,
				...(credentials.authorization === undefined
					? {}
					: { authorization: Redacted.value(credentials.authorization) }),
			},
			perMessageDeflate: false,
			maxPayload: payloadLimit,
			rejectUnauthorized: true,
			minVersion: "TLSv1.3",
		})
	})

export const open = Effect.fnUntraced(function* (
	options: WebsocketOptions,
	credentials: PreparedCredentials = {},
) {
	const url = yield* Schema.decodeEffect(Url)(options.url)
	if (credentials.certificate !== undefined && url.protocol !== "wss:")
		yield* Schema.decodeEffect(
			Url.check(
				Schema.makeFilter((url) => url.protocol === "wss:", {
					expected: "wss:// for mutual TLS",
				}),
			),
		)(options.url)
	const address = url.pathname === "/" ? new URL(path, url).href : url.href
	const services = yield* Layer.build(constructor(options.tls, credentials))
	return yield* Socket.makeWebSocket(address, {
		protocols: protocol,
		openTimeout: options.openTimeout ?? "10 seconds",
	}).pipe(Effect.provideContext(services))
})

export const properties = (url: URL): Properties => ({
	protocol: url.protocol === "wss:" ? "wss" : "ws",
	encrypted: url.protocol === "wss:",
	network: true,
	carries: url.protocol === "wss:" ? ["header", "certificate"] : ["header"],
})
