import { Plugin, type Graft } from "@graftland/graft"
import { Cause, Effect } from "effect"
import { TlsTransport } from "../Transport"
import { TransportError } from "../Errors"
import * as Tls from "../internal/runner/Tls"
import * as Channel from "../internal/socketChannel"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	TlsTransport,
	Effect.succeed({
		connect: (options, certificate) =>
			Tls.connect({
				...options,
				tls: { ...certificate, ca: options.ca },
			}).pipe(
				Effect.flatMap(Channel.fromSocket),
				Effect.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
	}),
	{ name: "remote-tls-transport" },
)

export default plugin
