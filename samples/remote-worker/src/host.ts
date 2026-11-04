import local from "@graftland/remote/host/local"
import { Graft, Plugin } from "@graftland/graft"
import * as Remote from "@graftland/remote"
import { Deferred, Effect } from "effect"
import { contract, Formatter, type Reply } from "./contract"

export const formatInChild = Effect.fn("formatInChild")(function* (
	options: Remote.Options,
) {
	const transport = yield* Graft.plugin(local)
	yield* transport.await
	const result = yield* Deferred.make<typeof Reply.Type>()
	const proxy = yield* Graft.plugin(Remote.plugin(contract, options), {
		prefix: "Worker: ",
	})
	yield* proxy.await
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "host-consumer",
			inject: [Formatter],
			apply: () =>
				Effect.gen(function* () {
					const formatter = yield* Formatter
					const reply = yield* formatter.format("hello")
					yield* Deferred.succeed(result, reply)
				}),
		}),
	)
	yield* consumer.await
	return yield* Deferred.await(result)
})
