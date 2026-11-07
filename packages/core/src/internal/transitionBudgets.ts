import { Array, Clock, Effect, Record } from "effect"

import type { Budget, Requirements } from "../Change"

type Policy = Budget & Requirements

export type Deadlines = {
	readonly [K in keyof Policy]: K extends "probes" ? Policy[K] : number
}
const sum = (steps: Readonly<Record<string, number>>) =>
	Array.reduce(Record.values(steps), 0, (total, value) => total + value)

/** The same named startup and termination steps supply execution limits and reserves. */
export const derive = (policy: Deadlines) => {
	const startup = {
		allocate: policy.startup,
		start: policy.startup,
		describe: policy.startup,
		serve: policy.startup,
		ready: policy.startup,
	}
	const termination = { exit: policy.terminate, hostRelease: policy.terminate }
	const cleanup = sum(termination)
	const preparation = policy.terminate
	const recovery =
		sum(startup) + policy.probes.length * policy.probe + policy.trial + cleanup
	const safety = sum({
		preparation,
		recovery,
		drainPrevious: policy.drain,
		stopPrevious: policy.stop,
		terminatePrevious: cleanup,
		terminateCandidate: cleanup,
	})
	return {
		startup,
		preparation,
		termination,
		cleanup,
		recovery,
		safety,
		startupTotal: sum(startup),
		minimum: safety + policy.trial,
	}
}

/** All waits use the same monotonic Change deadline; reserves protect later obligations. */
export const remaining = Effect.fnUntraced(function* (
	started: bigint,
	total: number,
	limit: number,
	reserved = 0,
) {
	const elapsed =
		Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000
	return Math.max(0, Math.min(limit, total - elapsed - reserved))
})
