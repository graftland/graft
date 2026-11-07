import { Array, Duration, Effect, Option, Record } from "effect"

import * as Change from "../Change"

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

const millis = (input: Duration.Input): number =>
	typeof input === "number" && (!Number.isFinite(input) || input < 0)
		? Number.NaN
		: Option.match(Duration.fromInput(input), {
				onNone: () => Number.NaN,
				onSome: Duration.toMillis,
			})

/** Peak reserves cover recovery startup, both trials, and both retirement paths. */
export const reserves = (request: Normalized) => {
	const { budget: b, requirements: r } = request
	const cleanup = 2 * b.terminate
	const startup = 5 * b.startup + r.probes.length * b.probe
	const recovery = startup + r.trial + cleanup
	return {
		startup,
		cleanup,
		recovery,
		minimum: recovery + b.drain + b.stop + 2 * cleanup + r.trial,
	}
}

/** Candidates are immutable, detached driver values; transient allocation data is excluded. */
export const normalize = Effect.fnUntraced(function* (
	request: Change.Request,
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
	if (
		!Array.every(
			Record.values(normalized.budget),
			(n) => Number.isFinite(n) && n > 0,
		) ||
		!Number.isFinite(normalized.requirements.trial) ||
		normalized.requirements.trial < 0 ||
		normalized.budget.total <= reserves(normalized).minimum
	)
		return yield* Change.ChangeRejected.make({
			reason: {
				_tag: "InvalidBudget",
				message:
					"The total must cover trial, cleanup, and recovery, including the recovery trial",
			},
		})
	return normalized
})
