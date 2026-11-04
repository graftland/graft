import { Array, Effect, Layer, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"
import WS from "ws"
import type { ClientCertificate } from "../Auth"
import type { WebsocketOptions } from "../Transport"
import { headerSize, maxPayload } from "./runner/Framing"

export const protocol = "graft-remote.v1"
export const path = "/graft"
export const payloadLimit = maxPayload + headerSize
export const Url = Schema.URLFromString.check(
	Schema.makeFilter((url) => url.protocol === "wss:", {
		expected: "a wss:// URL for mutual TLS",
	}),
)

export const constructor = (
	tls: WebsocketOptions["tls"],
	certificate: ClientCertificate,
) =>
	Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
		const settings =
			typeof options === "object" && !Array.isArray(options)
				? options
				: { protocols: options }
		return new WS(url, settings.protocols, {
			...tls,
			cert: certificate.cert,
			key: Redacted.value(certificate.key),
			headers: settings.headers,
			perMessageDeflate: false,
			maxPayload: payloadLimit,
			rejectUnauthorized: true,
			minVersion: "TLSv1.3",
		})
	})

export const connect = Effect.fnUntraced(function* (
	options: WebsocketOptions,
	certificate: ClientCertificate,
) {
	const url = yield* Schema.decodeEffect(Url)(options.url)
	const address = url.pathname === "/" ? new URL(path, url).href : url.href
	const services = yield* Layer.build(constructor(options.tls, certificate))
	return yield* Socket.makeWebSocket(address, {
		protocols: protocol,
		openTimeout: options.openTimeout ?? "10 seconds",
	}).pipe(Effect.provideContext(services))
})
