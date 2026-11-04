import { Graft, Plugin } from "@graftland/graft"
import { Config, Effect } from "effect"
import * as Remote from "../../src/index"
import { follow } from "../../src/internal/follow"
import { contract } from "./services-contract"

export default Plugin.make({
	name: "loader-remote-entry",
	config: contract.config,
	apply: Effect.fnUntraced(function* (config) {
		const fork = yield* Graft.plugin(
			Remote.plugin(contract, {
				contractModule: "remote-fixture",
				config,
				connect: {
					url: `wss://${yield* Config.String("RUNNER_HOST")}:${yield* Config.Port("RUNNER_PORT")}`,
					servername: yield* Config.String("RUNNER_SERVERNAME"),
					ca: yield* Config.String("RUNNER_CA"),
					auth: {
						mtls: {
							cert: yield* Config.String("RUNNER_CERT"),
							key: yield* Config.String("RUNNER_KEY"),
						},
					},
				},
			}),
		)
		yield* follow(fork, Effect.failCause)
	}),
})
