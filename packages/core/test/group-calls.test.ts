import { Array, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import { exit } from "./change-model/scenarios"
import { declaredMembers, rootRealms } from "./member-fact"

const setup = (): Core.State => {
	const base = Core.make({
		authority: "shared-calls",
		maxUnits: 3,
		realms: rootRealms,
		declarations: Array.map(
			declaredMembers(
				Array.map(["p1", "p2", "c1", "c2"], (id) => ({
					id,
					target: { identity: id, placement: "Worker", overlap: true },
				})),
			),
			(member) => ({ ...member, colocate: ["shared"] }),
		),
		bindings: [
			{ consumer: "c1", provider: "p1", service: "value" },
			{ consumer: "c2", provider: "p2", service: "value" },
		],
	})
	const unit = Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.values(base.units))),
	)
	return {
		...base,
		routes: HashMap.fromIterable(
			Array.map([1, 2], (n) => [
				`binding:2:c${n}:value`,
				{
					id: `binding:2:c${n}:value`,
					consumer: `c${n}`,
					provider: `p${n}`,
					service: "value",
					unit: unit.id,
					incarnation: unit.incarnation,
					term: 0,
					generation: 0,
					endpoint: {
						host: "127.0.0.1",
						port: 1234 + n,
						credential: `provider-${n}`,
					},
					version: 1,
				},
			]),
		),
	}
}
const observe = (state: Core.State, message: Core.CallMessage): Core.State => {
	const unit = Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.values(state.units))),
	)
	return Core.reduce(state, {
		_tag: "CallObserved",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		message,
		now: state.now,
	}).state
}
const request = (state: Core.State, member: string): Core.State =>
	observe(state, {
		_tag: "Request",
		member,
		term: 0,
		generation: 0,
		session: "same-session",
		request: "1",
		service: "value",
		lifecycle: false,
		nested: false,
		wait: 50,
	})
it("qualifies shared-unit credits by consumer and provider member generations, retaining results and cancellations until exact owned completion (I6, I7, F21)", () => {
	const admitted = request(request(setup(), "c1"), "c2")
	assert.equal(HashMap.size(admitted.calls), 2)
	const result = observe(admitted, {
		_tag: "Result",
		member: "c1",
		term: 0,
		generation: 0,
		session: "same-session",
		request: "1",
	})
	const cancelled = observe(result, {
		_tag: "Cancel",
		member: "c2",
		term: 0,
		generation: 0,
		session: "same-session",
		request: "1",
	})
	assert.equal(HashSet.size(cancelled.activeCalls), 2)
	const first = Option.getOrThrow(
		Array.findFirst(
			HashMap.values(cancelled.calls),
			(call) => call.consumerMember === "c1",
		),
	)
	const wrong = observe(cancelled, {
		_tag: "Complete",
		member: "p2",
		term: 0,
		generation: 0,
		key: first.key,
		cleanup: { _tag: "Completed" },
		cause: Cause.empty,
	})
	assert.equal(HashSet.size(wrong.activeCalls), 2)
	const completed = observe(wrong, {
		_tag: "Complete",
		member: "p1",
		term: 0,
		generation: 0,
		key: first.key,
		cleanup: { _tag: "Completed" },
		cause: Cause.empty,
	})
	assert.equal(HashSet.size(completed.activeCalls), 1)
	const duplicate = observe(completed, {
		_tag: "Complete",
		member: "p1",
		term: 0,
		generation: 0,
		key: first.key,
		cleanup: { _tag: "Completed" },
		cause: Cause.empty,
	})
	assert.equal(HashSet.size(duplicate.activeCalls), 1)
	const unit = Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.values(duplicate.units))),
	)
	assert.equal(HashSet.size(exit(duplicate, unit.id).activeCalls), 0)
})
