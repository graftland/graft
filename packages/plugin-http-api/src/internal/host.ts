import {
	Array,
	Context,
	Effect,
	Exit,
	Option,
	Queue,
	Stream,
	SubscriptionRef,
} from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { OpenApi, type HttpApiGroup } from "effect/http-api"

import { Event, Graft, Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import type { Config } from "../Config"
import {
	Document,
	Groups,
	GroupsChanged,
	ServingMount,
	type Snapshot,
} from "../HttpApis"
import { compose } from "./compose"

export const host = Effect.fn("HttpApis.host")(function* (config: Config) {
	const routes = yield* Http.Routes
	const info = OpenApi.annotations(config)
	const initial = yield* Effect.fromResult(compose([], info))
	const document = yield* SubscriptionRef.make<Snapshot>(initial)
	const queue = yield* Queue.make<void>({ capacity: 1, strategy: "sliding" })
	const signal = Queue.offer(queue, undefined).pipe(Effect.asVoid)
	let previous = initial
	const sync = Effect.gen(function* () {
		const outcomes = yield* Event.settle(Groups)
		for (const outcome of outcomes)
			if (Exit.isFailure(outcome))
				yield* Effect.logError(
					"A plugin failed to say which API groups it serves",
					outcome.cause,
				)
		const state = yield* SubscriptionRef.get(routes)
		const groups = Array.filter(
			Array.flatMap(outcomes, (outcome) =>
				Exit.isSuccess(outcome) ? outcome.value : [],
			),
			(group) => {
				const mount = Context.getOption(
					(group as HttpApiGroup.Top).annotations,
					ServingMount,
				)
				return Option.isNone(mount) || Array.contains(state.served, mount.value)
			},
		)
		const next = yield* Effect.fromResult(compose(groups, info))
		for (const conflict of next.conflicts)
			if (
				!Array.some(
					previous.conflicts,
					(old) =>
						Array.join(old.groups, "\n") === Array.join(conflict.groups, "\n"),
				)
			)
				yield* Effect.logWarning(conflict)
		for (const broken of next.broken)
			if (!Array.some(previous.broken, (old) => old.group === broken.group))
				yield* Effect.logError(
					`Could not document group ${broken.group}`,
					broken.cause,
				)
		previous = next
		yield* SubscriptionRef.set(document, next)
	}).pipe(
		Effect.catchTag("CompositionError", (error) =>
			Effect.logError(
				"Could not compose the API document; keeping the previous snapshot",
				error,
			),
		),
	)
	yield* Event.on(GroupsChanged, () => signal)
	yield* sync
	yield* Plugin.fork(
		Queue.take(queue).pipe(Effect.andThen(sync), Effect.forever),
	)
	yield* Plugin.fork(
		Stream.runForEach(SubscriptionRef.changes(routes), () => signal),
	)
	yield* Graft.provide(Document, document)
	if (config.openapi !== false)
		yield* Http.mount(
			HttpRouter.add(
				"GET",
				config.openapi,
				Effect.map(SubscriptionRef.get(document), ({ spec }) =>
					HttpServerResponse.jsonUnsafe(spec),
				),
			),
		)
})
