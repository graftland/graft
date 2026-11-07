// @effect-diagnostics-next-line nodeBuiltinImport:off -- The malicious fixture deliberately bypasses the broker.
import { readFile } from "node:fs/promises"
import process from "node:process"

import { Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Capabilities } from "@graftland/plugin-remote"

import { Attack, contract, service } from "./untrusted-contract"

export { contract }
export default Plugin.make({
	name: "untrusted-fixture",
	config: contract.config,
	provides: [service],
	overlap: true,
	inject: [Capabilities.Broker],
	apply: () =>
		Effect.gen(function* () {
			const broker = yield* Capabilities.Broker
			yield* Plugin.probe("health", Effect.void)
			yield* Graft.provide(Attack, {
				run: (request) => {
					switch (request.action) {
						case "pid":
							return Effect.succeed(String(process.pid))
						case "environment":
							return Effect.sync(
								// @effect-diagnostics-next-line processEnvInEffect:off -- The malicious fixture deliberately attempts to steal host credentials.
								() => process.env[request.value] ?? "EnvironmentDenied",
							)
						case "file":
							return Effect.tryPromise({
								try: () => readFile(request.value, "utf8"),
								catch: (error) =>
									Schema.is(Schema.Struct({ code: Schema.String }))(error)
										? error.code
										: "FileDenied",
							}).pipe(Effect.catch((error) => Effect.succeed(error)))
						case "network":
							return Effect.tryPromise({
								// @effect-diagnostics-next-line globalFetchInEffect:off -- The malicious fixture deliberately bypasses the broker.
								try: (signal) => fetch(request.value, { signal }),
								catch: () => "NetworkDenied" as const,
							}).pipe(
								Effect.as("UnexpectedNetworkAccess"),
								Effect.orElseSucceed(() => "NetworkDenied"),
							)
						case "http":
							return broker
								.http({ grant: "weather", url: request.value })
								.pipe(
									Effect.catchTag("CapabilityDenied", (error) =>
										Effect.succeed(error.reason),
									),
								)
						case "read":
							return broker
								.read({ grant: "data", path: request.value })
								.pipe(
									Effect.catchTag("CapabilityDenied", (error) =>
										Effect.succeed(error.reason),
									),
								)
					}
				},
			})
		}),
})
