import { Context, Effect, Redacted, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Credentials } from "../src/Auth"
import { invocation } from "../src/internal/credentials"

class Token extends Context.Service<Token, string>()(
	"@graftland/plugin-remote/test/credential-scope.test/Token",
) {}

it.effect(
	"releases Effect credential resources with each connection scope",
	() =>
		Effect.gen(function* () {
			const released = yield* Ref.make(0)
			yield* Graft.provide(Token, "secret")
			const capability = invocation({
				url: "wss://localhost",
				auth: {
					bearer: {
						token: {
							inject: [Token],
							read: Effect.acquireRelease(
								Token.pipe(Effect.map(Redacted.make)),
								() => Ref.update(released, (n) => n + 1),
							),
						},
					},
				},
			})
			assert(capability !== undefined)
			const provider = yield* Graft.plugin(capability.plugin)
			yield* provider.await
			const consumer = yield* Graft.plugin(
				Plugin.make({
					name: "connection-credential-reader",
					inject: [Credentials],
					apply: Effect.fnUntraced(function* () {
						const credentials = yield* Credentials
						assert(credentials.kind === "Authorization")
						for (const expected of [1, 2]) {
							yield* Effect.scoped(credentials.read)
							const count = yield* Ref.get(released)
							assert.strictEqual(count, expected)
						}
					}),
				}),
			)
			yield* consumer.await
			yield* consumer.dispose
			yield* provider.dispose
			const count = yield* Ref.get(released)
			assert.strictEqual(count, 2)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
