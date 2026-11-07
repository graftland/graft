# Scope close interruption attribution

Status: draft for the maintainer to review and submit. Tested against
`effect@4.1.2` and `@effect/vitest@4.1.2`. No upstream submission or product
change accompanies this draft.

## Request

Provide structured provenance for interruptions observed during finalization. A
resource owner needs to distinguish cancellation delivered to its closing fiber
from an independent interruption propagated by a finalizer. An interruptor fiber
ID identifies the initiator, not the target or the interruption occurrence.

This is a missing observation capability, not evidence that `Scope.close`
violates its documented contract. In the tested cases it preserves interruption
causes. Converting an independently interrupted finalizer to a defect is Graft's
policy; upstream need not adopt that policy.

## Reproduction

The runnable Effect-only tests are
[scope-close-attribution-effect.test.ts](../../packages/core/test/scope-close-attribution-effect.test.ts)
and their
[fixture](../../packages/core/test/scope-close-attribution-fixture.ts). They
import no Graft implementation. The separate
[adapter tests](../../packages/core/test/scope-close-attribution-release.test.ts)
run the same schedule with the existing `Release.close`.

Run from the repository root:

```sh
devenv shell -- pnpm vitest run --project @graftland/graft packages/core/test/scope-close-attribution-effect.test.ts packages/core/test/scope-close-attribution-release.test.ts
```

The following standalone test reduces the shared-initiator case to Effect APIs.
The owner first cancels a child. A scope finalizer then joins that child and
fails. A later finalizer suspends, allowing the same owner to cancel the closing
fiber. Thus the finalizer failure predates cancellation of the closer.

```ts
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { assert, it } from "@effect/vitest"

it.effect("cannot attribute two interruptions by their shared initiator", () =>
	Effect.gen(function* () {
		const owner = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
		const child = yield* Effect.forkScoped(Effect.never)
		yield* Fiber.interrupt(child)
		const childExit = yield* Fiber.await(child)
		assert(Exit.isFailure(childExit))
		const entered = yield* Deferred.make<void>()
		const resume = yield* Deferred.make<void>()
		const report = yield* Deferred.make<{
			readonly closed: Exit.Exit<void>
			readonly pending: Exit.Exit<void>
		}>()
		const scope = yield* Scope.make()
		yield* Scope.addFinalizer(
			scope,
			Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Deferred.await(resume)),
			),
		)
		yield* Scope.addFinalizer(scope, Fiber.join(child))
		const closer = yield* Effect.gen(function* () {
			const closed = yield* Effect.exit(Scope.close(scope, Exit.void))
			const pending = yield* Effect.exit(Effect.interruptible(Effect.void))
			yield* Deferred.succeed(report, { closed, pending })
			return yield* closed
		}).pipe(Effect.uninterruptible, Effect.forkScoped)
		yield* Deferred.await(entered)
		const cancelling = yield* Fiber.interruptAs(closer, owner).pipe(
			Effect.forkScoped({ startImmediately: true }),
		)
		yield* Deferred.succeed(resume, undefined)
		const { closed, pending } = yield* Deferred.await(report)
		yield* Fiber.join(cancelling)
		const outer = yield* Fiber.await(closer)
		assert(Exit.isFailure(outer))
		assert(Exit.isFailure(closed))
		assert(Exit.isFailure(pending))
		for (const cause of [childExit.cause, closed.cause, pending.cause]) {
			assert.isTrue(Cause.hasInterruptsOnly(cause))
			assert.deepStrictEqual([...Cause.interruptors(cause)], [owner])
		}
	}).pipe(Effect.scoped),
)
```

The test does not claim that stack annotations are byte-for-byte equal. Stack
traces are diagnostic context, not a specified target or occurrence identity. No
test parses formatted causes, stack traces, or error messages.

## Observations

All rows below are executable tests, not proposed behavior. The closer captures
its finalization exit under a mask before returning to interruptibility. The
fixture then re-emits that exit, preserving its failure in the outer fiber.

| Test name                                                                                | Observation in 4.1.2                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `observes raw masked finalization separately from pending cancellation`                  | Close succeeds under the mask; pending cancellation and the outer fiber exit are interrupted. Cancellation is not proof of failed cleanup. |
| `observes raw interruptible finalization separately from pending cancellation`           | The finalizer observes cancellation of the closer; both observations contain the owner's interruptor ID.                                   |
| `observes raw self finalization separately from pending cancellation`                    | Close contains the closer's self-interruption; pending cancellation contains the owner's ID. Both remain interrupts, not defects.          |
| `observes raw joined finalization separately from pending cancellation`                  | Joining a cancelled child fails independently, but its interruptor ID equals the closer's pending cancellation ID.                         |
| `cannot attribute two interruptions by their shared initiator`                           | The same ambiguity exists when cancellation arrives after the join has already failed.                                                     |
| `combines equal interrupt reasons without preserving their occurrences`                  | `Cause.combine` merges equal reasons; a cause is not an occurrence log.                                                                    |
| `does not turn a finalizer's self-interruption into pending cancellation`                | Explicit `Effect.interrupt` fails without installing a pending cancellation request.                                                       |
| `marks a self-interrupted finalizer while retaining pending cancellation`                | Graft marks the distinct self-interruption with `ReleaseInterrupted` and retains the external interruption.                                |
| `does not mark masked finalization as an independent interruption`                       | Graft preserves successful masked cleanup.                                                                                                 |
| `does not mark interruptible finalization as an independent interruption`                | Graft leaves externally delivered cancellation as an interrupt.                                                                            |
| `currently misclassifies a joined interruption when cancellation arrives before failure` | Graft produces no defect for an independent join failure.                                                                                  |
| `currently misclassifies a joined interruption when cancellation arrives after failure`  | The late pending read also misclassifies an already completed join failure.                                                                |
| `marks the same joined interruption when the closer has no pending cancellation`         | Without the colliding pending ID, Graft correctly marks the join failure.                                                                  |

The two `currently misclassifies` tests deliberately assert the current faulty
result. They characterize a known limitation; their passing does not establish
correct attribution. Initial assertions requiring defects failed in both cases.

## Source evidence

These are observations of the installed 4.1.2 source, not tests of every
possible execution schedule.

| Source                             | Relevant behavior                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/Scope.ts:550-593`             | Close masks finalizers by default. Repeated close returns immediately even while an earlier close is running.                                                                                                                     |
| `src/internal/effect.ts:4006-4076` | Close claims the scope by setting its state to `Closed` before executing finalizers; sequential finalizers run in reverse registration order and their exits are combined. Parallel finalization runs finalizers in other fibers. |
| `src/internal/effect.ts:592-606`   | External interruption records a pending cause on its target fiber.                                                                                                                                                                |
| `src/internal/effect.ts:4631-4711` | `Effect.interrupt` creates a failure with the current fiber's ID; it does not set pending cancellation. Restoring interruptibility observes the pending cause.                                                                    |
| `src/Cause.ts:382-405`             | `Interrupt.fiberId` is the optional initiator ID. There is no structured target or occurrence identity.                                                                                                                           |
| `src/internal/core.ts:283-345`     | Cause combination deduplicates equal reasons; pending interruption merging also has no distinct signal identity.                                                                                                                  |
| `src/internal/core.ts:601-630`     | Failure propagation merges pending interruptions when interruptibility is restored.                                                                                                                                               |

The existing Graft adapter uses only public APIs: it closes under a mask, then
captures `Effect.interruptible(Effect.void)`, and matches reasons by interruptor
ID. Reading pending cancellation after close includes requests received during
cleanup, but cannot identify the provenance of earlier finalizer failures.
Moving the read before close misses those requests. Neither read is a valid
linearization point for general attribution.

## Expected semantics and proposed public API

Keep the current behavior of `Scope.close`. Add an opt-in observation API, with
names subject to upstream review:

| Proposal                               | Required meaning                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Scope.closeWithReport(scope, exit)`   | Report the original finalization exit separately from cancellation delivered to the closer. Preserve complete causes and normal cancellation propagation.                                                                       |
| Per-finalizer interruption attribution | Distinguish cancellation delivered to the executing finalizer fiber, an independently raised or propagated interruption, and unknown provenance. Parallel finalizers must be attributed relative to their own executing fibers. |
| Runtime interruption provenance        | Carry an opaque signal identity and target identity through runtime-generated interrupt reasons and joins. The initiator alone is insufficient. Do not deduplicate distinct signals solely because their initiators match.      |
| Explicit unknown                       | Manually constructed or replayed causes without sufficient provenance remain unknown. Do not infer origin from an optional ID or a stack trace.                                                                                 |

A report must be observable before restoring the closing fiber's
interruptibility (for example, by a caller already inside
`uninterruptibleMask`). Returning a successful report must not silently clear
pending cancellation. Whether upstream prefers a masked callback or a returned
report needs API review.

A delivered cancellation is not evidence that a finalizer succeeded: retain its
actual exit. Likewise, an independently failed finalizer remains a failed
finalizer even if its interruptor later cancels the closer. Keep the body exit,
finalization exit, cancellation request, and completion evidence separate.

This is an API direction, not an implemented solution. A report containing only
an aggregate cause and pending initiator IDs would reproduce the same bug.
Runtime provenance design, parallel finalizers, imported causes, and transport
encoding need upstream validation. The prototype does not prove the proposed API
sufficient for every manually re-emitted cause.

## Graft disposition before upstream support

The verdict is split at the boundary: marking an independent cleanup failure as
a defect is a Graft ownership policy expressible with public Effect APIs. That
conversion itself is not a forbidden workaround. General, reliable attribution
from the existing aggregate causes is the missing Effect capability.

Accordingly, the current module must not be certified as a general attribution
adapter or treated as fixed by renaming it. Mark the capability as **incomplete,
with a known shared-initiator false negative; pending upstream provenance**. Do
not patch Effect internals, fabricate unique interruptor IDs, parse traces, or
add a separate execution fiber merely to conceal this ambiguity. Calling the
current heuristic a complete solution would bypass the upstream requirement,
even though its building blocks are public APIs.

No production code is changed in this prototype. In particular,
`internal/activation.ts:551-556` and `internal/tasks.ts:35-38` assume that an
unmarked pure interruption is pending cancellation and discard it. The adapter
counterexample invalidates that assumption in general; it does not by itself
prove that every current activation schedule reaches the counterexample. Event
dispatch has similar pure-interruption filtering. Audit reachable schedules
before making end-to-end claims.

For phases 1 and 2, do not derive cleanup success or `Accepted` from an unmarked
interrupt or an already-closed scope. Preserve the original failed exit and mark
its attribution as unresolved. This is truthful reporting of missing evidence,
not an alternative implementation of attribution. A sole scope owner should
record the settled finalization exit before publishing execution completion.
Waiting cancellation does not cancel the runtime-owned Change; unit exit proves
termination, not successful cleanup. No global coordination is needed for this
per-execution evidence.
