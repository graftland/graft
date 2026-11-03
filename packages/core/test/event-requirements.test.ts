import { assert, it } from "@effect/vitest"
import { expectTypeOf } from "vitest"
import { Context, Effect, Ref, Scope } from "effect"
import { Event, Graft } from "../src/index.ts"
import { run } from "./utils.ts"

class Renderer extends Context.Service<
	Renderer,
	{ readonly render: (text: string) => string }
>()("@graftland/graft/test/event-requirements.test/Renderer") {}
class Prefix extends Context.Service<Prefix, string>()(
	"@graftland/graft/test/event-requirements.test/Prefix",
) {}

const checkProvided = (
	effect: Effect.Effect<string, never, Graft.Graft>,
): void => assert.isTrue(Effect.isEffect(effect))

it("preserves last's service requirements while supplying its invocation scope", () => {
	const event = Event.middleware<string, string>("typed last")
	const dispatch = Event.waterfall(event, "hello", (text) =>
		Effect.gen(function* () {
			yield* Effect.acquireRelease(Effect.void, () => Effect.void)
			const renderer = yield* Renderer
			const prefix = yield* Prefix
			return renderer.render(prefix + text)
		}),
	)
	expectTypeOf<Effect.Services<typeof dispatch>>().toEqualTypeOf<
		Graft.Graft | Renderer | Prefix
	>()
	// Missing services must prevent assigning the dispatch to a Graft-only effect.
	expectTypeOf<typeof dispatch>().not.toExtend<
		Effect.Effect<string, never, Graft.Graft>
	>()
	const partial = dispatch.pipe(
		Effect.provideService(Renderer, { render: (text) => text }),
	)
	// Providing one service must not erase the remaining dependency.
	expectTypeOf<typeof partial>().not.toExtend<
		Effect.Effect<string, never, Graft.Graft>
	>()
	checkProvided(partial.pipe(Effect.provideService(Prefix, "prefix: ")))
	const scoped = Event.waterfall(event, "hello", (text) =>
		Effect.acquireRelease(Effect.succeed(text), () => Effect.void),
	)
	expectTypeOf<Effect.Services<typeof scoped>>().toEqualTypeOf<Graft.Graft>()
	checkProvided(scoped)

	const handler = (text: string, next: Event.Next<string, string>) =>
		Effect.flatMap(Renderer, (renderer) => next(renderer.render(text)))
	const on = Event.on(event, handler)
	const once = Event.once(event, handler)
	expectTypeOf<Effect.Services<typeof on>>().toEqualTypeOf<
		Graft.Graft | Scope.Scope | Renderer
	>()
	expectTypeOf<Effect.Services<typeof once>>().toEqualTypeOf<
		Graft.Graft | Scope.Scope | Renderer
	>()
	const filtered = Event.filtered(() => true)(dispatch)
	expectTypeOf<Effect.Services<typeof filtered>>().toEqualTypeOf<
		Graft.Graft | Renderer | Prefix
	>()
})

for (const middleware of [false, true]) {
	it.effect(
		`runs a service-dependent last with invocation cleanup ${middleware ? "with" : "without"} middleware`,
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>(
					"last services and scope",
				)
				const released = yield* Ref.make(false)
				if (middleware)
					yield* Event.on(event, (text, next) => next(text)).pipe(
						Effect.provideService(Renderer, {
							render: (text) => `middleware: ${text}`,
						}),
					)
				const dispatch = Event.waterfall(event, "hello", (text) =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(Effect.void, () =>
							Ref.set(released, true),
						)
						const renderer = yield* Renderer
						return renderer.render(text)
					}),
				)
				const provided: Effect.Effect<string, never, Graft.Graft> =
					dispatch.pipe(
						Effect.provideService(Renderer, {
							render: (text) => `dispatcher: ${text}`,
						}),
					)
				const result = yield* provided
				assert.strictEqual(result, "dispatcher: hello")
				const closed = yield* Ref.get(released)
				assert.isTrue(closed)
			}).pipe(run),
	)
}
