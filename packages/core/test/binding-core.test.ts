import { Array, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Bindings from "../src/internal/bindingCore"
import * as Core from "../src/internal/decisionCore"
import type { BindingDeclaration } from "../src/internal/decisionState"
import {
	exit,
	fire,
	pending,
	report,
	request,
	succeed,
} from "./change-model/scenarios"

const operation = (
	identity: string,
	tag = identity,
	provenance = "contract-sha256",
) => ({ identity, tag, provenance })
const service = (...identities: ReadonlyArray<string>): BindingDeclaration => ({
	key: "weather",
	unary: true,
	operations: Array.map(identities, (id) => operation(id)),
})
it("accepts one provider's exact operation subset without comparing package versions (I4, I8)", () => {
	assert.isTrue(
		Option.isNone(
			Bindings.validate(
				service("forecast@1"),
				service("forecast@1", "alerts@2"),
			),
		),
	)
})
it("never combines partial providers to cover a consumer contract (I8, I12)", () => {
	const required = service("forecast@1", "alerts@1")
	assert.equal(
		Option.getOrThrow(Bindings.validate(required, service("forecast@1")))
			.reason,
		"MissingOperation",
	)
	assert.equal(
		Option.getOrThrow(Bindings.validate(required, service("alerts@1"))).reason,
		"MissingOperation",
	)
})
it("rejects unexplained provenance under the same immutable operation identity (I4, I8)", () => {
	const provided = {
		...service("forecast@1"),
		operations: [operation("forecast@1", "forecast@1", "different-contract")],
	}
	assert.equal(
		Option.getOrThrow(Bindings.validate(service("forecast@1"), provided))
			.reason,
		"ProvenanceMismatch",
	)
})
it("rejects a changed wire tag before installing a compatible identity (I4, I8)", () => {
	const provided = {
		...service("forecast@1"),
		operations: [operation("forecast@1", "DifferentWireTag")],
	}
	assert.equal(
		Option.getOrThrow(Bindings.validate(service("forecast@1"), provided))
			.reason,
		"WireTagMismatch",
	)
})
it("rejects duplicate operation identities and streaming declarations before relying on unary completion (I8, I12)", () => {
	assert.equal(
		Option.getOrThrow(
			Bindings.validate(
				service("forecast@1"),
				service("forecast@1", "forecast@1"),
			),
		).reason,
		"DuplicateOperation",
	)
	assert.equal(
		Option.getOrThrow(
			Bindings.validate(
				{ ...service("forecast@1"), unary: false },
				service("forecast@1"),
			),
		).reason,
		"UnsupportedCallShape",
	)
})

const descriptor = (
	provides: ReadonlyArray<BindingDeclaration>,
	requires: ReadonlyArray<BindingDeclaration> = [],
): Core.Description => ({
	artifact: "fixture",
	configuration: "config",
	environment: "node",
	protocol: 1,
	overlap: true,
	members: 1,
	provides,
	requires,
	probes: [],
})
const topology = (provided = service("forecast@1", "alerts@1")): Core.State => {
	const s = Core.make({
		authority: "bindings",
		maxUnits: 4,
		instances: [
			{
				id: "provider",
				target: { identity: "old", placement: "Worker", overlap: true },
			},
			{
				id: "consumer",
				target: { identity: "consumer", placement: "Process", overlap: true },
			},
		],
		bindings: [
			{ consumer: "consumer", provider: "provider", service: "weather" },
		],
	})
	return {
		...s,
		units: HashMap.map(s.units, (u) => ({
			...u,
			description: Option.some(
				u.instance === "provider"
					? descriptor([provided])
					: descriptor([], [service("forecast@1")]),
			),
			endpoint: Option.some({
				host: "127.0.0.1",
				port: 12345,
				credential: u.id,
			}),
		})),
	}
}
const replacing = (s = topology(), provided = service("forecast@1")) =>
	Core.reduce(s, {
		_tag: "Submit",
		request: { ...request(s, "provider"), description: descriptor([provided]) },
		now: s.now,
	})
it("rejects incompatible fixed bindings before reserving or executing a Change (I3, I8, I12)", () => {
	const s = topology()
	const rejected = replacing(s, service("forecast@2"))
	assert.equal(rejected.reply._tag, "Rejected")
	assert.equal(HashMap.size(rejected.state.changes), 0)
	assert.strictEqual(rejected.state.claims, s.claims)
})
it("reserves every affected binding and stages the consumer's actual incarnation before activation (I2, I3, I8)", () => {
	const submitted = replacing()
	const c = HashMap.get(submitted.state.changes, "change-1").pipe(
		Option.getOrThrow,
	)
	assert.isTrue(
		HashSet.has(c.request.writes, Bindings.key("consumer", "weather")),
	)
	const running = Array.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
		] satisfies ReadonlyArray<Core.CommandKind>,
		submitted.state,
		(s, k) =>
			k === "Start"
				? report(s, pending(s, c.id, k), {
						_tag: "Started",
						value: descriptor([service("forecast@1")]),
						endpoint: {
							host: "127.0.0.1",
							port: 23456,
							credential: "candidate",
						},
					})
				: succeed(s, c.id, k),
	)
	const installs = Array.filter(
		Array.fromIterable(HashMap.values(running.commands)),
		(cmd) => cmd.change === c.id && cmd.kind === "Install",
	)
	assert.lengthOf(installs, 2)
	const consumer = Option.getOrThrow(
		Array.findFirst(installs, (c) => c.unit === "consumer@0"),
	)
	assert.equal(consumer.token.incarnation, "bindings/consumer@0")
	assert.equal(consumer.target.placement, "Process")
	const candidate = Option.getOrThrow(
		Array.findFirst(installs, (c) => c.unit === "provider@1"),
	)
	assert.equal(candidate.view?.routes.length, 0)
	const partial = report(running, candidate)
	assert.equal(Option.getOrThrow(Core.get(partial, c.id)).phase, "Installing")
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(partial.commands)),
			(c) => c.kind === "Activate",
		),
	)
	const committed = report(partial, consumer)
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(committed.commands)),
			(c) => c.kind === "Activate" && c.unit === "consumer@0",
		),
	)
	assert.equal(
		Option.getOrThrow(
			HashMap.get(committed.routes, Bindings.key("consumer", "weather")),
		).unit,
		"provider@1",
	)
	const live = HashMap.get(
		committed.routes,
		Bindings.key("consumer", "weather"),
	).pipe(Option.getOrThrow)
	assert.equal(live.version, Core.cell(committed, live.id).version)
	const activated = Array.findFirst(
		HashMap.values(committed.commands),
		(c) => c.kind === "Activate" && c.unit === "consumer@0",
	).pipe(Option.getOrThrow)
	assert.equal(activated.view?.routes[0]?.version, live.version)
})

const installing = () => {
	const first = replacing()
	return Array.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
		] satisfies ReadonlyArray<Core.CommandKind>,
		first.state,
		(s, kind) =>
			kind === "Start"
				? report(s, pending(s, "change-1", kind), {
						_tag: "Started",
						value: descriptor([service("forecast@1")]),
						endpoint: {
							host: "127.0.0.1",
							port: 23456,
							credential: "candidate",
						},
					})
				: succeed(s, "change-1", kind),
	)
}
it("rejects a stale participant incarnation or view acknowledgement before route activation (I2, I8)", () => {
	const state = installing()
	const consumer = Array.findFirst(
		HashMap.values(state.commands),
		(c) => c.kind === "Install" && c.unit === "consumer@0",
	).pipe(Option.getOrThrow)
	for (const token of [
		{ ...consumer.token, view: consumer.token.view + 1 },
		{ ...consumer.token, incarnation: "recreated-consumer" },
	]) {
		const ignored = Core.reduce(state, {
			_tag: "Reported",
			command: consumer.id,
			token,
			result: { _tag: "Succeeded" },
			now: 0,
		}).state
		assert.equal(
			Option.getOrThrow(Core.get(ignored, "change-1")).phase,
			"Installing",
		)
		assert.isFalse(
			Array.some(
				Array.fromIterable(HashMap.values(ignored.commands)),
				(c) => c.kind === "Activate",
			),
		)
	}
})
it("discards partial staged views after a missing install acknowledgement without activating or changing the old route (I2, I5, I8)", () => {
	const state = installing()
	const partial = report(
		state,
		Array.findFirst(
			HashMap.values(state.commands),
			(c) => c.kind === "Install" && c.unit === "provider@1",
		).pipe(Option.getOrThrow),
	)
	const expired = fire(partial, "change-1", "Operation")
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(expired.commands)),
			(c) => c.kind === "Discard" && c.unit === "consumer@0",
		),
	)
	const discard = Array.findFirst(
		HashMap.values(expired.commands),
		(c) => c.kind === "Discard" && c.unit === "consumer@0",
	).pipe(Option.getOrThrow)
	const repeated = report(expired, discard, {
		_tag: "Failed",
		cause: Cause.fail("Discard reply unavailable"),
		creation: "Unknown",
	})
	assert.equal(
		Array.filter(
			Array.fromIterable(HashMap.values(repeated.commands)),
			(c) => c.kind === "Discard",
		).length,
		2,
	)
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(repeated.commands)),
			(c) => c.kind === "Terminate" && c.unit === "consumer@0",
		),
	)
	const candidateEnded = exit(repeated, "provider@1")
	assert.isTrue(
		Option.isNone(
			Option.getOrThrow(Core.get(candidateEnded, "change-1")).conclusion,
		),
	)
	const ended = exit(candidateEnded, "consumer@0")
	const result = Option.getOrThrow(
		Option.getOrThrow(Core.get(ended, "change-1")).conclusion,
	)
	assert.equal(result.outcome, "Aborted")
	assert.isTrue(Option.getOrThrow(Core.get(ended, "change-1")).member.healthy)
	assert.isTrue(
		Option.isNone(
			HashMap.get(ended.routes, Bindings.key("consumer", "weather")),
		),
	)
})

it("retains an exact missing participant exit as Stuck after an install deadline (I2, I5, I8)", () => {
	const s = installing()
	const acknowledged = report(
		s,
		Array.findFirst(
			HashMap.values(s.commands),
			(c) => c.kind === "Install" && c.unit === "provider@1",
		).pipe(Option.getOrThrow),
	)
	const expired = fire(acknowledged, "change-1", "Operation")
	const ended = exit(expired, "provider@1")
	const stuck = fire(ended, "change-1", "Evidence")
	const before = Option.getOrThrow(Core.get(stuck, "change-1"))
	assert.equal(Option.getOrThrow(before.conclusion).outcome, "Stuck")
	assert.isTrue(HashSet.has(before.unconfirmedUnits, "consumer@0"))
	const late = exit(stuck, "consumer@0")
	const after = Option.getOrThrow(Core.get(late, "change-1"))
	assert.strictEqual(after.conclusion, before.conclusion)
	assert.equal(HashSet.size(after.unconfirmedUnits), 0)
	assert.isTrue(Option.isNone(Core.cell(late, "provider").writer))
})
it("rejects an unavailable selected provider before granting a new consumer execution (I3, I8, I12)", () => {
	const s = topology()
	const unavailable = {
		...s,
		instances: HashMap.modify(s.instances, "provider", (i) => ({
			...i,
			healthy: false,
		})),
	}
	const rejected = Core.reduce(unavailable, {
		_tag: "Submit",
		request: {
			...request(unavailable, "consumer"),
			description: descriptor([], [service("forecast@1")]),
		},
		now: 0,
	})
	assert.equal(rejected.reply._tag, "Rejected")
	assert.equal(HashMap.size(rejected.state.changes), 0)
})

it("rechecks provider availability before committing an installed consumer view (I3, I8)", () => {
	const s = installing()
	const lost = {
		...s,
		instances: HashMap.modify(s.instances, "consumer", (i) => ({
			...i,
			healthy: false,
		})),
	}
	const installed = Array.reduce(
		Array.filter(
			Array.fromIterable(HashMap.values(lost.commands)),
			(c) => c.kind === "Install",
		),
		lost,
		(s, c) => report(s, c),
	)
	assert.isTrue(
		Option.getOrThrow(HashMap.get(installed.changes, "change-1")).failure,
	)
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(installed.commands)),
			(c) => c.kind === "Activate",
		),
	)
})

it("refuses a provider Start report without an encoded endpoint before Serve (I4, I8)", () => {
	const first = replacing()
	const resolved = succeed(first.state, "change-1", "Resolve")
	const spawned = succeed(resolved, "change-1", "Spawn")
	const started = report(spawned, pending(spawned, "change-1", "Start"), {
		_tag: "Started",
		value: descriptor([service("forecast@1")]),
	})
	assert.isTrue(
		Option.getOrThrow(HashMap.get(started.changes, "change-1")).failure,
	)
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(started.commands)),
			(c) => c.kind === "Serve",
		),
	)
})
