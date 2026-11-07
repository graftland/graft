import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"

import {
	Array,
	Effect,
	FiberSet,
	HashMap,
	Option,
	Queue,
	Ref,
	Schema,
} from "effect"

import { declarationMatches, Event, inbox, type Command } from "./wire"

export class WorkerFault extends Schema.TaggedError<
	WorkerFault,
	{ readonly brand: unique symbol }
>()("WorkerFault", {
	cause: Schema.Defect(),
}) {}

const launch = Effect.fnUntraced(function* (
	role: "consumer" | "provider",
	tag = "inspectWire",
	build = "prototype-contract-build-1",
) {
	const control = yield* Effect.acquireRelease(
		Effect.sync(() => new MessageChannel()),
		(channel) =>
			Effect.sync(() => {
				channel.port1.close()
				channel.port2.close()
			}),
	)
	const input = yield* inbox(control.port1)
	const events = yield* Queue.unbounded<
		Event,
		WorkerFault | Schema.SchemaError
	>()
	const trace = yield* Ref.make<ReadonlyArray<Event>>([])
	const alive = yield* Ref.make(true)
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const moduleUrl = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(new URL("../../../.cache/encoded-channel/worker.js", import.meta.url).href)
	const worker = yield* Effect.acquireRelease(
		Effect.sync(
			() =>
				new Worker(`import(${moduleUrl}).then(({ run }) => run())`, {
					eval: true,
					workerData: { role, control: control.port2, tag, build },
					transferList: [control.port2],
				}),
		),
		(value) => Effect.promise(() => value.terminate()),
	)
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			const error = (cause: Error) => {
				run(Queue.fail(events, WorkerFault.make({ cause })))
			}
			const exit = (code: number) => {
				run(
					Ref.set(alive, false).pipe(
						Effect.andThen(
							Queue.offer(events, { phase: "unit-exited", id: String(code) }),
						),
					),
				)
			}
			worker.on("error", error)
			worker.on("exit", exit)
			return { error, exit }
		}),
		({ error, exit }) =>
			Effect.sync(() => {
				worker.off("error", error)
				worker.off("exit", exit)
			}),
	)
	yield* Queue.take(input).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Event)),
		Effect.tap((event) => Ref.update(trace, (events) => [...events, event])),
		Effect.flatMap((event) => Queue.offer(events, event)),
		Effect.forever,
		Effect.tapCause((cause) => Queue.failCause(events, cause)),
		Effect.forkScoped,
	)
	const wait = Effect.fnUntraced(function* (phase: string, id?: string) {
		const matches = (event: Event) =>
			event.phase === phase && (id === undefined || event.id === id)
		const previousTrace = yield* Ref.get(trace)
		const previous = Array.findFirst(previousTrace, matches)
		if (Option.isSome(previous)) return previous.value
		return yield* Queue.take(events).pipe(
			Effect.repeat({ until: matches }),
			Effect.timeout("3 seconds"),
			Effect.tapError(() =>
				Effect.logError("Prototype wait timed out", { phase, id }),
			),
		)
	})
	const ready = yield* wait("ready")
	if (ready.declaration === undefined)
		return yield* Effect.die("Worker omitted its declaration")
	return {
		declaration: ready.declaration,
		wait,
		trace: Ref.get(trace),
		alive: Ref.get(alive),
		send: (command: Exclude<Command, { _tag: "Bind" }>) =>
			Effect.sync(() => control.port1.postMessage(command)),
		bind: (generation: string, port: MessagePort) =>
			Effect.sync(() =>
				control.port1.postMessage({ _tag: "Bind", generation, port }, [port]),
			),
		terminate: Effect.promise(() => worker.terminate()),
	}
})

export const start = Effect.fnUntraced(function* (
	generations: ReadonlyArray<string> = ["old"],
	consumerDeclaration?: { readonly tag?: string; readonly build?: string },
) {
	const providers = yield* Effect.forEach(
		generations,
		Effect.fnUntraced(function* (generation) {
			const provider = yield* launch("provider")
			return { ...provider, generation }
		}),
	)
	const consumer = yield* launch(
		"consumer",
		consumerDeclaration?.tag,
		consumerDeclaration?.build,
	)
	const compatible = Array.every(providers, (provider) =>
		declarationMatches(consumer.declaration, provider.declaration),
	)
	// Verify both declarations before delivering either data endpoint. The host
	// retains no endpoint capable of reading business requests or responses.
	if (compatible) {
		yield* Effect.forEach(
			providers,
			Effect.fnUntraced(function* (provider) {
				const channel = yield* Effect.acquireRelease(
					Effect.sync(() => new MessageChannel()),
					(channel) =>
						Effect.sync(() => {
							channel.port1.close()
							channel.port2.close()
						}),
				)
				yield* provider.bind(provider.generation, channel.port1)
				yield* consumer.bind(provider.generation, channel.port2)
				yield* provider.wait("bound", provider.generation)
				yield* consumer.wait("bound", provider.generation)
			}),
		)
	}
	const first = Array.head(generations)
	if (Option.isNone(first))
		return yield* Effect.die("The fixture needs a provider")
	const identity = consumer.declaration.identity
	const routes = yield* Ref.make(HashMap.make([identity, first.value]))
	const selected = yield* Ref.make(HashMap.empty<string, string>())
	const dispatch = Effect.fnUntraced(function* (
		id: string,
		mode: Extract<Command, { _tag: "Call" }>["mode"],
	) {
		if (!compatible) return "NotAdmitted"
		const current = yield* Ref.get(routes)
		const generation = yield* Effect.fromOption(HashMap.get(current, identity))
		const provider = yield* Effect.fromOption(
			Array.findFirst(
				providers,
				(provider) => provider.generation === generation,
			),
		)
		if (!(yield* provider.alive)) return "NotAdmitted"
		yield* Ref.update(selected, HashMap.set(id, generation))
		yield* consumer.send({ _tag: "Call", id, mode, generation })
		return "Dispatched"
	})
	return {
		consumer,
		providers,
		dispatch,
		select: (generation: string) =>
			Ref.update(routes, HashMap.set(identity, generation)),
		selected: Ref.get(selected),
		// Only use this when no terminal result was received. Registration
		// before dispatch deliberately makes the uncertainty boundary conservative.
		lostOutcome: (id: string) =>
			Ref.get(selected).pipe(
				Effect.map((calls) =>
					HashMap.has(calls, id) ? "Unknown" : "NotAdmitted",
				),
			),
	}
})
