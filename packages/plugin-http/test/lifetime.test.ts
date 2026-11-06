import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Stream,
	String,
} from "effect"
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/http"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"

import * as Http from "../src/Http.ts"
import { logs, request, run, start } from "./utils.ts"

it.live("interrupts a slow handler with 503 and runs its finalizer", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const entered = yield* Deferred.make<void>(),
			finished = yield* Deferred.make<void>()
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "slow",
				apply: () =>
					Http.mount(
						HttpRouter.add(
							"GET",
							"/slow",
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() =>
									Deferred.succeed(finished, undefined),
								)
								yield* Deferred.succeed(entered, undefined)
								return yield* Effect.never
							}),
						),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		const pending = yield* request(`${url}/slow`).pipe(Effect.forkScoped)
		yield* Deferred.await(entered)
		yield* fork.dispose
		assert.strictEqual((yield* Fiber.join(pending)).status, 503)
		const done = yield* Deferred.isDone(finished)
		assert.isTrue(done)
	}).pipe(run),
)

it.live("cuts an SSE body on unload before releasing layer resources", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const received = yield* Deferred.make<void>()
		const order = yield* Ref.make<ReadonlyArray<string>>([])
		const record = (value: string) =>
			Ref.update(order, (values) => Array.append(values, value))
		const body = Stream.concat(
			Stream.make("data: ready\n\n"),
			Stream.fromEffect(Effect.never),
		).pipe(Stream.encodeText, Stream.ensuring(record("body")))
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "sse",
				apply: () =>
					Http.mount(
						HttpRouter.add(
							"GET",
							"/events",
							HttpServerResponse.stream(body, {
								contentType: "text/event-stream",
							}),
						).pipe(
							Layer.provide(
								Layer.effectDiscard(Effect.addFinalizer(() => record("layer"))),
							),
						),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		const client = yield* HttpClient.HttpClient
		const consuming = yield* client.get(`${url}/events`).pipe(
			Effect.flatMap((response) =>
				Stream.runForEach(response.stream, () =>
					Deferred.succeed(received, undefined),
				),
			),
			Effect.forkScoped,
		)
		yield* Deferred.await(received)
		yield* fork.dispose
		const exit = yield* Fiber.await(consuming).pipe(Effect.timeout("2 seconds"))
		assert.isTrue(Exit.isFailure(exit))
		const closed = yield* Ref.get(order)
		assert.deepStrictEqual(closed, ["body", "layer"])
		assert.strictEqual((yield* request(`${url}/events`)).status, 404)
	}).pipe(run),
)

it.live(
	"logs a failing Mounts answer with its cause and serves other mounts",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const bad = yield* Graft.plugin(
				Plugin.make({
					name: "bad-answer",
					apply: () =>
						Event.on(Http.Mounts, () => Effect.die("mount answer defect")),
				}),
			)
			yield* bad.await
			const good = yield* Graft.plugin(
				Plugin.make({
					name: "good",
					apply: () =>
						Http.mount(
							HttpRouter.add("GET", "/ok", HttpServerResponse.text("ok")),
						).pipe(Effect.asVoid),
				}),
			)
			yield* good.await
			assert.strictEqual((yield* request(`${url}/ok`)).text, "ok")
			const entries = yield* logs
			assert.isTrue(
				Array.some(entries, (entry) =>
					String.includes("mount answer defect")(Cause.pretty(entry.cause)),
				),
			)
		}).pipe(run),
)

it.live("returns 500 and reports a handler defect exactly once", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "defect",
				apply: () =>
					Http.mount(
						HttpRouter.add("GET", "/defect", Effect.die("handler exploded")),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		assert.strictEqual((yield* request(`${url}/defect`)).status, 500)
		const entries = yield* logs
		assert.lengthOf(
			Array.filter(entries, (entry) =>
				String.includes("handler exploded")(Cause.pretty(entry.cause)),
			),
			1,
		)
	}).pipe(run),
)
