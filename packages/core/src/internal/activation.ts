/**
 * The supervision loop of a single fork.
 *
 * Each iteration acquires the fork's dependencies, runs `apply` in a fresh
 * activation, waits until the specification or a dependency changes, and
 * tears the activation down. Teardown follows a fixed order instead of
 * relying on finalizer registration order:
 *
 * 1. stop `apply` if it is still running;
 * 2. withdraw everything the activation published and close it to further
 *    publishing, so nobody new can lease it;
 * 3. wait until every consumer has released those provisions;
 * 4. close the activation scope (child forks, resources, handlers);
 * 5. release the leases the activation itself holds, whatever happened before.
 */
import {
	Array as Arr,
	Cause,
	Context,
	Duration,
	Effect,
	Equal,
	Exit,
	Fiber,
	HashMap,
	MutableRef,
	Option,
	Pull,
	Schedule,
	Scope,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { Graft } from "../Graft"
import { ForkState } from "../Fork"
import { isOptional, type Update } from "../Plugin"
import {
	Realms,
	realmKey,
	type Activation,
	type Provision,
	type Runtime,
	type Spec,
} from "./runtime"

/** How long teardown waits for consumers before warning about a possible cycle. */
const drainWarning = Duration.seconds(10)

interface Resolution {
	readonly spec: Spec
	readonly missing: ReadonlyArray<string>
	readonly provisions: ReadonlyArray<Provision>
	/** Dependencies satisfied by the ambient context; they never change, so they take no lease. */
	readonly ambient: ReadonlyArray<readonly [service: string, value: unknown]>
	/** Realm keys of optional dependencies that were absent. */
	readonly absent: ReadonlyArray<string>
}

interface Running {
	readonly resolution: Resolution
	readonly activation: Activation
	readonly scope: Scope.Closeable
	/** Everything plugin code may require: the activation is where plugin requirements are discharged. */
	readonly context: Context.Context<unknown>
	/** The fiber running `apply`; teardown stops it before withdrawing anything. */
	readonly fiber: MutableRef.MutableRef<
		Fiber.Fiber<void | Update<unknown>, unknown> | undefined
	>
}

type Outcome =
	| { readonly _tag: "Restart" }
	| {
			readonly _tag: "Failed"
			readonly resolution: Resolution
			readonly cause: Cause.Cause<unknown>
	  }

const restart: Outcome = { _tag: "Restart" }

const resolve = (
	runtime: Runtime,
	registry: HashMap.HashMap<string, Provision>,
	realms: HashMap.HashMap<string, string>,
	spec: Spec,
): Resolution => {
	const lookups = Arr.map(spec.plugin.inject, (dependency) => {
		const key = isOptional(dependency) ? dependency.key : dependency
		const qualified = realmKey(realms, key.key)
		return {
			optional: isOptional(dependency),
			service: key.key,
			qualified,
			found: HashMap.get(registry, qualified),
			ambient: runtime.ambient.mapUnsafe.has(key.key),
		}
	})
	const unresolved = Arr.filter(lookups, (lookup) =>
		Option.isNone(lookup.found),
	)
	const absent = Arr.filter(unresolved, (lookup) => !lookup.ambient)
	return {
		spec,
		provisions: Arr.getSomes(Arr.map(lookups, (lookup) => lookup.found)),
		ambient: Arr.map(
			Arr.filter(unresolved, (lookup) => lookup.ambient),
			(lookup) =>
				[
					lookup.service,
					runtime.ambient.mapUnsafe.get(lookup.service),
				] as const,
		),
		missing: Arr.map(
			Arr.filter(absent, (lookup) => !lookup.optional),
			(lookup) => lookup.service,
		),
		absent: Arr.map(
			Arr.filter(absent, (lookup) => lookup.optional),
			(lookup) => lookup.qualified,
		),
	}
}

export const setState = (
	runtime: Runtime,
	id: number,
	state: ForkState,
	spec: Spec,
) =>
	TxSubscriptionRef.update(runtime.forks, (forks) =>
		HashMap.modify(forks, id, (entry) => ({
			...entry,
			state,
			accepted: spec,
			name: spec.plugin.name,
			input: spec.input,
		})),
	)

const waitDrained = (published: ReadonlyArray<Provision>) =>
	Effect.tx(
		Effect.gen(function* () {
			for (const provision of published) {
				const leases = yield* TxRef.get(provision.leases)
				if (leases > 0) return yield* Effect.txRetry
			}
		}),
	)

/**
 * Withdraws what an activation published, closes it to further publishing,
 * and waits until no consumer holds a lease on any of it.
 */
export const withdraw = Effect.fnUntraced(function* (
	runtime: Runtime,
	activation: Activation,
) {
	const published = yield* Effect.tx(
		Effect.gen(function* () {
			const current = yield* TxRef.get(activation.published)
			const published = Option.getOrElse(current, () => [])
			yield* TxRef.set(activation.published, Option.none())
			if (published.length > 0) {
				yield* TxRef.update(runtime.registry, (registry) =>
					Arr.reduce(published, registry, (registry, provision) =>
						Option.exists(
							HashMap.get(registry, provision.key),
							(current) => current === provision,
						)
							? HashMap.remove(registry, provision.key)
							: registry,
					),
				)
			}
			return published
		}),
	)
	const drained = yield* Effect.timeoutOption(
		waitDrained(published),
		drainWarning,
	)
	if (Option.isNone(drained)) {
		const services = Arr.join(
			Arr.map(published, (provision) => provision.service),
			", ",
		)
		yield* Effect.logWarning(
			`Still waiting for consumers of ${services}; a teardown cycle may be holding them`,
		)
		yield* waitDrained(published)
	}
})

const reportFailure = (message: string, exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
		? Effect.logError(message, exit.cause)
		: Effect.void

export const supervise = Effect.fnUntraced(function* (
	runtime: Runtime,
	id: number,
	specRef: TxRef.TxRef<Spec>,
) {
	const realms = yield* Realms
	/** What the fork inherits from where it was loaded: references and ambient services. */
	const inherited = yield* Effect.context<never>()
	let retry:
		((input: unknown) => Pull.Pull<unknown, never, unknown>) | undefined

	const resolveCurrent = Effect.gen(function* () {
		const registry = yield* TxRef.get(runtime.registry)
		const spec = yield* TxRef.get(specRef)
		return resolve(runtime, registry, realms, spec)
	})

	/** Resolves to the new spec if the spec changed, or `None` if a dependency changed. */
	const waitChange = (resolution: Resolution) =>
		Effect.tx(
			Effect.gen(function* () {
				const current = yield* TxRef.get(specRef)
				if (current !== resolution.spec) return Option.some(current)
				if (
					resolution.provisions.length === 0 &&
					resolution.absent.length === 0
				)
					return yield* Effect.txRetry
				const registry = yield* TxRef.get(runtime.registry)
				const withdrawn = Arr.some(
					resolution.provisions,
					(provision) =>
						!Option.exists(
							HashMap.get(registry, provision.key),
							(current) => current === provision,
						),
				)
				const appeared = Arr.some(resolution.absent, (key) =>
					HashMap.has(registry, key),
				)
				return withdrawn || appeared
					? Option.none<Spec>()
					: yield* Effect.txRetry
			}),
		)

	const acquire = Effect.gen(function* () {
		const { resolution, dynamic } = yield* Effect.tx(
			Effect.gen(function* () {
				const resolution = yield* resolveCurrent
				if (resolution.missing.length === 0) {
					for (const provision of resolution.provisions)
						yield* TxRef.update(provision.leases, (n) => n + 1)
				}
				const dynamic = yield* TxRef.get(runtime.dynamic)
				return { resolution, dynamic }
			}),
		)
		if (resolution.missing.length > 0)
			return { _tag: "Missing" as const, resolution }
		const scope = yield* Scope.make()
		const published = yield* TxRef.make(
			Option.some<ReadonlyArray<Provision>>([]),
		)
		const activation: Activation = { fork: id, published }
		// Services published dynamically reach a plugin only through its own resolution, never by
		// inheritance from whoever loaded it; otherwise isolation could be bypassed.
		const base = new Map(inherited.mapUnsafe)
		for (const service of dynamic) base.delete(service)
		const context = Context.makeUnsafe<unknown>(
			new Map<string, unknown>([
				...base,
				...resolution.ambient,
				...Arr.map(
					resolution.provisions,
					(provision) => [provision.service, provision.value] as const,
				),
				[Scope.Scope.key, scope],
				[Graft.key, { runtime, activation }],
			]),
		)
		const running: Running = {
			resolution,
			activation,
			scope,
			context,
			fiber: MutableRef.make(undefined),
		}
		return { _tag: "Running" as const, running }
	})

	const pending = Effect.fnUntraced(function* (resolution: Resolution) {
		yield* setState(
			runtime,
			id,
			ForkState.Pending({ missing: resolution.missing }),
			resolution.spec,
		)
		yield* Effect.tx(
			Effect.gen(function* () {
				const next = yield* resolveCurrent
				const unchanged =
					next.spec === resolution.spec &&
					Equal.equals(next.missing, resolution.missing)
				if (unchanged) return yield* Effect.txRetry
			}),
		)
		return restart
	})

	/** Runs plugin code with the activation's context, which discharges whatever it requires. */
	const inActivation =
		(running: Running, spec: Spec) =>
		<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
			Effect.updateContext<A, E, unknown, never>(
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- this is where plugin requirements are discharged
				Effect.annotateLogs(effect, {
					"graft.fork": id,
					"graft.plugin": spec.plugin.name,
				}),
				() => running.context,
			)

	const run = Effect.fnUntraced(function* (running: Running) {
		const { resolution } = running
		let spec = resolution.spec
		yield* setState(runtime, id, ForkState.Loading(), spec)
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- plugin requirements and errors are erased; the activation provides the former and records the latter as the fork's Cause
		const fiber = yield* spec.plugin.decode(spec.input).pipe(
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- as above
			Effect.flatMap((config) => spec.plugin.apply(config)),
			Effect.withSpan(`graft.plugin ${spec.plugin.name}`),
			inActivation(running, spec),
			Effect.forkIn(running.scope),
		)
		MutableRef.set(running.fiber, fiber)
		const first = yield* Effect.raceFirst(
			Effect.asSome(Fiber.await(fiber)),
			Effect.as(waitChange(resolution), Option.none()),
		)
		if (Option.isNone(first)) return restart
		const exit = first.value
		if (exit._tag === "Failure")
			return { _tag: "Failed", resolution, cause: exit.cause } satisfies Outcome
		retry = undefined
		yield* setState(runtime, id, ForkState.Active(), spec)
		const update = exit.value
		while (true) {
			const next = yield* waitChange({ ...resolution, spec })
			if (Option.isNone(next) || update === undefined) return restart
			const candidate = next.value
			if (
				candidate.plugin !== spec.plugin ||
				candidate.revision !== spec.revision
			)
				return restart
			// The update races further changes, so a stuck update cannot hold up teardown.
			const handled = yield* Effect.raceFirst(
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the activation provides what decoding requires
				spec.plugin.decode(candidate.input).pipe(
					Effect.flatMap(update),
					Effect.catchCause((cause) =>
						Effect.as(
							Effect.logWarning(
								"Updating in place failed; restarting instead",
								cause,
							),
							false,
						),
					),
					inActivation(running, spec),
				),
				Effect.as(waitChange({ ...resolution, spec: candidate }), false),
			)
			if (!handled) return restart
			spec = candidate
			yield* setState(runtime, id, ForkState.Active(), spec)
		}
	})

	const teardown = (running: Running, exit: Exit.Exit<unknown, unknown>) =>
		Effect.gen(function* () {
			const fiber = MutableRef.get(running.fiber)
			// Only a still-running `apply` is stopped here; a finished one was already reported.
			if (fiber !== undefined && fiber.pollUnsafe() === undefined) {
				yield* Fiber.interrupt(fiber)
				const stopped = yield* Fiber.await(fiber)
				yield* reportFailure("Stopping the plugin failed", stopped)
			}
			yield* withdraw(runtime, running.activation)
			const closed = yield* Effect.exit(Scope.close(running.scope, exit))
			yield* reportFailure("Releasing the plugin's resources failed", closed)
		}).pipe(
			Effect.ensuring(
				Effect.tx(
					Effect.forEach(
						running.resolution.provisions,
						(provision) => TxRef.update(provision.leases, (n) => n - 1),
						{
							discard: true,
						},
					),
				),
			),
			Effect.annotateLogs({
				"graft.fork": id,
				"graft.plugin": running.resolution.spec.plugin.name,
			}),
		)

	const waitRetry = Effect.fnUntraced(function* (
		outcome: Extract<Outcome, { _tag: "Failed" }>,
	) {
		const { spec } = outcome.resolution
		// Reported only after teardown, so `Failed` always means "failed and cleaned up".
		yield* setState(
			runtime,
			id,
			ForkState.Failed({ cause: outcome.cause }),
			spec,
		)
		yield* Effect.logError(
			`Plugin "${spec.plugin.name}" failed`,
			outcome.cause,
		).pipe(
			Effect.annotateLogs({
				"graft.fork": id,
				"graft.plugin": spec.plugin.name,
			}),
		)
		const changed = Effect.asVoid(waitChange(outcome.resolution))
		if (spec.plugin.retry === undefined) {
			retry = undefined
			return yield* changed
		}
		const step = retry ?? (yield* Schedule.toStepWithSleep(spec.plugin.retry))
		retry = step
		const changedFirst = yield* Effect.raceFirst(
			Effect.as(changed, true),
			step(outcome.cause).pipe(
				Effect.as(false),
				Pull.catchDone(() => Effect.as(changed, true)),
			),
		)
		if (changedFirst) retry = undefined
	})

	while (true) {
		const outcome = yield* Effect.acquireUseRelease(
			acquire,
			(acquired) =>
				acquired._tag === "Missing"
					? pending(acquired.resolution)
					: run(acquired.running),
			(acquired, exit) =>
				acquired._tag === "Missing"
					? Effect.void
					: teardown(
							acquired.running,
							Exit.isSuccess(exit) && exit.value._tag === "Failed"
								? Exit.failCause(exit.value.cause)
								: exit,
						),
		)
		if (outcome._tag === "Failed") yield* waitRetry(outcome)
	}
})
