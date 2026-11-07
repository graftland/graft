import { Array, Effect, Option } from "effect"

import { Trust } from "@graftland/graft"
import * as Policy from "@graftland/plugin-remote/Policy"

import type { Event, Journal, Release, Status } from "../Model"
import { changes } from "./changes"
import { equal, failure, verify } from "./storage"

interface Pending {
	readonly intent: Event
	readonly remaining: ReadonlyArray<string>
	readonly accepted: ReadonlyArray<string>
	readonly compensation: ReadonlyArray<string> | undefined
	readonly degraded: boolean
}
interface Replay {
	readonly publications: ReadonlyArray<Trust.Publication>
	readonly approvals: ReadonlyArray<Policy.Approval>
	readonly status: Status
	readonly release: Release
	readonly override: boolean
	readonly pending: Pending | undefined
}
const corrupt = (message: string) =>
	failure("Journal", "Inconsistent release journal: " + message)

/** Reconstruct acceptance from completed transactions before trusting the checkpoint. */
export const validate = Effect.fnUntraced(function* (
	store: string,
	journal: Journal,
) {
	const [bootstrap, ...events] = journal.events
	if (bootstrap?.kind !== "Bootstrap" || bootstrap.current !== bootstrap.target)
		return yield* corrupt("missing accepted bootstrap")
	const first = yield* verify(store, bootstrap.current)
	const replay = yield* Effect.reduce(
		events,
		(): Replay => ({
			approvals: [],
			publications: [],
			status: {
				current: bootstrap.current,
				previous: null,
				state: "Ready",
				revocations: Array.dedupe(first.revocations),
			},
			release: first,
			override: false,
			pending: undefined,
		}),
		Effect.fnUntraced(function* (state, event) {
			const pending = state.pending
			if (event.kind !== "Commit" && event.current !== state.status.current)
				return yield* corrupt(
					"event current id disagrees with accepted checkpoint",
				)
			switch (event.kind) {
				case "Projection": {
					const change = event.projection
					if (
						change === undefined ||
						event.at === undefined ||
						event.target !== state.status.current
					)
						return yield* corrupt("invalid projection audit record")
					const previous = Array.findFirst(
						state.publications,
						(item) =>
							item.projection === change.after.projection &&
							item.view === change.after.view,
					)
					const before = Option.getOrElse(previous, () => ({
						projection: change.after.projection,
						view: change.after.view,
						values: [],
					}))
					if (!(yield* equal(before, change.before)))
						return yield* corrupt(
							"projection history disagrees with the preceding view",
						)
					return {
						...state,
						publications: [
							...Array.filter(
								state.publications,
								(item) =>
									item.projection !== change.after.projection ||
									item.view !== change.after.view,
							),
							change.after,
						],
					}
				}
				case "Approval":
					if (
						pending !== undefined ||
						event.target !== state.status.current ||
						event.approval === undefined
					)
						return yield* corrupt("approval has no accepted checkpoint")
					return { ...state, approvals: [...state.approvals, event.approval] }
				case "Revocation":
					if (
						pending !== undefined ||
						event.target !== state.status.current ||
						event.revocations === undefined ||
						event.who === undefined ||
						event.at === undefined
					)
						return yield* corrupt("invalid revocation audit record")
					return {
						...state,
						approvals: retainApprovals(state.approvals, event.revocations),
						status: {
							...state.status,
							revocations: Array.dedupe([
								...state.status.revocations,
								...event.revocations,
							]),
						},
					}
				case "Bootstrap":
					return yield* corrupt("duplicate bootstrap")
				case "Startup":
					if (event.target !== state.status.current)
						return yield* corrupt("startup selected an unaccepted release")
					return {
						...state,
						status: { ...state.status, state: "Ready" as const },
						pending: undefined,
					}
				case "Intent":
					if (
						pending !== undefined ||
						state.status.state !== "Ready" ||
						event.target === state.status.current ||
						event.entries === undefined ||
						Array.dedupe(event.entries).length !== event.entries.length
					)
						return yield* corrupt("invalid transition intent")
					return {
						...state,
						status: { ...state.status, state: "Applying" as const },
						pending: {
							intent: event,
							remaining: event.entries,
							accepted: [],
							compensation: undefined,
							degraded: false,
						},
					}
				case "Outcome": {
					if (
						pending === undefined ||
						pending.compensation !== undefined ||
						event.target !== pending.intent.target ||
						event.entry === undefined ||
						event.entry !== pending.remaining[0] ||
						event.outcome === undefined
					)
						return yield* corrupt(
							"outcome does not belong to the pending entry",
						)
					const accepted = event.outcome._tag === "Accepted"
					return {
						...state,
						pending: {
							...pending,
							remaining: Array.drop(pending.remaining, 1),
							accepted: accepted
								? [...pending.accepted, event.entry]
								: pending.accepted,
							compensation: accepted
								? undefined
								: Array.reverse(pending.accepted),
							degraded:
								event.outcome._tag === "RecoveryFailed" ||
								event.outcome._tag === "Stuck",
						},
					}
				}
				case "Compensation":
					if (
						pending === undefined ||
						pending.compensation === undefined ||
						event.entry === undefined ||
						event.entry !== pending.compensation[0] ||
						event.target !== state.status.current ||
						event.outcome === undefined
					)
						return yield* corrupt(
							"compensation does not match accepted entry order",
						)
					return {
						...state,
						pending: {
							...pending,
							compensation: Array.drop(pending.compensation, 1),
							degraded: pending.degraded || event.outcome._tag !== "Accepted",
						},
					}
				case "Rejected":
					if (
						pending === undefined ||
						pending.compensation === undefined ||
						pending.compensation.length !== 0 ||
						event.target !== pending.intent.target
					)
						return yield* corrupt("rejection has incomplete compensation")
					return {
						...state,
						status: {
							...state.status,
							state: pending.degraded
								? ("Degraded" as const)
								: ("Ready" as const),
						},
						pending: undefined,
					}
				case "Commit": {
					if (
						pending === undefined ||
						pending.compensation !== undefined ||
						pending.remaining.length !== 0 ||
						event.current !== pending.intent.target ||
						event.target !== pending.intent.target ||
						(event.overrideRevocations === true) !==
							(pending.intent.overrideRevocations === true)
					)
						return yield* corrupt("commit has no fully accepted intent")
					const next = yield* verify(store, event.target)
					const changed = yield* changes(state.release, next)
					const required = Array.map(changed, (change) => change.entry)
					if (!(yield* equal(required, pending.accepted)))
						return yield* corrupt("commit is missing entry outcomes")
					const revocations = Array.dedupe([
						...state.status.revocations,
						...next.revocations,
					])
					if (
						event.overrideRevocations !== true &&
						Array.some(next.references, (reference) =>
							Array.contains(revocations, reference),
						)
					)
						return yield* corrupt(
							"commit restores a revoked reference without an override",
						)
					return {
						publications: state.publications,
						approvals: retainApprovals(
							state.approvals,
							Array.filter(
								next.revocations,
								(ref) => !Array.contains(state.status.revocations, ref),
							),
						),
						release: next,
						override: event.overrideRevocations === true,
						pending: undefined,
						status: {
							current: event.target,
							previous: state.status.current,
							state: "Ready" as const,
							revocations,
						},
					}
				}
			}
		}),
	)
	// A failed journal write may leave an unfinished intent explicitly fenced in memory and on disk.
	const expected =
		replay.pending !== undefined && journal.status.state === "Degraded"
			? { ...replay.status, state: "Degraded" as const }
			: replay.status
	if (!(yield* equal(expected, journal.status)))
		return yield* corrupt(
			"current, previous, completion, or revocations disagree with transaction history",
		)
	return replay
})

const retainApprovals = (
	records: ReadonlyArray<Policy.Approval>,
	refs: ReadonlyArray<string>,
) =>
	Array.filter(
		records,
		(record) =>
			!Array.some(
				record.statement.assignment.grants,
				(grant) =>
					Array.contains(refs, grant.id) ||
					(grant._tag === "Http" &&
						grant.credential !== undefined &&
						Array.contains(refs, "env:" + grant.credential)),
			),
	)
