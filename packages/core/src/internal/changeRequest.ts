import { Array, Duration, Effect, Option, Record } from "effect"

import * as Change from "../Change"
import { derive, type Deadlines } from "./transitionBudgets"

export interface Normalized {
	readonly instance: string
	readonly candidate: Change.Candidate
	readonly expected: number | undefined
	readonly strategy: Change.Strategy | undefined
	readonly budget: { readonly [K in keyof Change.Budget]: number }
	readonly requirements: {
		readonly trial: number
		readonly probes: ReadonlyArray<string>
	}
}

export const millis = (input: Duration.Input): number =>
	typeof input === "number" && (!Number.isFinite(input) || input < 0)
		? Number.NaN
		: Option.match(Duration.fromInput(input), {
				onNone: () => Number.NaN,
				onSome: Duration.toMillis,
			})

export const deadlines = (request: Normalized): Deadlines => ({
	...request.budget,
	...request.requirements,
})
/** Admission and execution derive reserves from the same named steps. */
export const reserves = (request: Normalized) => {
	const limits = derive(deadlines(request))
	return {
		startup: limits.startupTotal,
		cleanup: limits.cleanup,
		recovery: limits.recovery,
		minimum: limits.minimum,
	}
}

/** Candidates are immutable, detached driver values; transient allocation data is excluded. */
export const normalize = Effect.fnUntraced(function* (
	request: Change.Request,
	validateBudget: boolean = true,
): Effect.fn.Return<Normalized, Change.ChangeRejected> {
	const b = request.budget
	const defaults = Change.defaultBudget
	const normalized: Normalized = {
		instance: request.instance,
		candidate: {
			driver: request.candidate.driver,
			identity: request.candidate.identity,
			deployment: request.candidate.deployment,
		},
		expected: request.expected,
		strategy: request.strategy,
		budget: {
			total: millis(b?.total ?? defaults.total),
			startup: millis(b?.startup ?? defaults.startup),
			probe: millis(b?.probe ?? defaults.probe),
			drain: millis(b?.drain ?? defaults.drain),
			stop: millis(b?.stop ?? defaults.stop),
			terminate: millis(b?.terminate ?? defaults.terminate),
		},
		requirements: {
			trial: millis(
				request.requirements?.trial ?? Change.defaultRequirements.trial,
			),
			probes: Array.fromIterable(
				request.requirements?.probes ?? Change.defaultRequirements.probes,
			),
		},
	}
	if (validateBudget) yield* validate(normalized)
	return normalized
})

export const validate = (
	request: Normalized,
): Effect.Effect<void, Change.ChangeRejected> =>
	Array.every(
		Record.values(request.budget),
		(n) => Number.isFinite(n) && n > 0,
	) &&
	Number.isFinite(request.requirements.trial) &&
	request.requirements.trial >= 0 &&
	request.budget.total > reserves(request).minimum
		? Effect.void
		: Change.ChangeRejected.make({
				reason: {
					_tag: "InvalidBudget",
					message:
						"The total must cover trial, cleanup, and recovery, including the recovery trial",
				},
			})
