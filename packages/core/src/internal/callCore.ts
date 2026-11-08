/** Production call admission and completion decisions. No transport or business values enter this module. */
import { Array, Cause, HashMap, HashSet, Option } from "effect"

import * as Bindings from "./bindingCore"
import type {
	BindingRoute,
	CallControl,
	CallEvidence,
	CallFact,
	CallMemberIdentity,
	CallMessage,
	CallWaiter,
	Command,
	CommandKind,
	State,
	Unit,
	Working,
} from "./decisionState"
import * as Executions from "./executionState"
import * as Attempt from "./groupAttempt"
import * as Preparation from "./preparationCore"

export const initial = () => ({
	activeCalls: HashSet.empty<string>(),
	calls: HashMap.empty<string, CallFact>(),
	callsByUnit: HashMap.empty<string, HashSet.HashSet<string>>(),
	callWaiters: HashMap.empty<string, CallWaiter>(),
	waitingByBinding: HashMap.empty<string, HashSet.HashSet<string>>(),
	callRequests: HashMap.empty<string, string>(),
	cancelledCalls: HashSet.empty<string>(),
	callSeen: HashSet.empty<string>(),
	callHistory: [],
	callLimits: { concurrency: 64, waiters: 64, wait: 5000 },
	nextCallCommand: 1,
})
const id = (
	u: Unit,
	identity: CallMemberIdentity,
	session: string,
	request: string,
): string =>
	`${u.incarnation.length}:${u.incarnation}/${identity.member.length}:${identity.member}/${identity.term}/${identity.generation}/${session.length}:${session}/${request}`
const ids = (s: State, unit: string): HashSet.HashSet<string> =>
	Option.getOrElse(HashMap.get(s.callsByUnit, unit), () => HashSet.empty())
const issue = (
	s: Working,
	kind: CommandKind,
	unit: string,
	call: CallControl,
	status?: CallFact,
): Working =>
	Option.match(HashMap.get(s.units, unit), {
		onNone: () => s,
		onSome: (u) => {
			const first = Array.head(Array.fromIterable(HashMap.values(u.members)))
			if (Option.isNone(first)) return s
			const recipient =
				call.route !== undefined &&
				Array.contains(["CallRegister", "CallCancel", "CallCompleteAck"], kind)
					? {
							member: call.route.provider,
							term: call.route.term,
							generation: call.route.generation,
						}
					: call.member
			const selected = HashMap.filter(
				u.members,
				(_, id) => id === recipient.member,
			)
			const command: Command = {
				subjects: HashSet.make(recipient.member),
				placement: u.placement,
				resolutions: HashMap.empty(),
				descriptions: HashMap.empty(),
				policies: HashMap.empty(),
				members: Executions.grants(u.members),
				id: `call-command/${s.nextCallCommand}`,
				change: "$calls",
				unit,
				kind,
				call: { ...call, member: recipient },
				...(status === undefined ? {} : { callStatus: status }),
				token: {
					authority: s.authority,
					change: "$calls",
					unit,
					incarnation: u.incarnation,
					members: Executions.tokens(selected),
					view: 0,
				},
				target: first.value.target,
				dispatched: true,
				participant: "",
				timer: Option.none(),
				status: Option.none(),
				disposition: "Pending",
				report: Option.none(),
			}
			return {
				...s,
				nextCallCommand: s.nextCallCommand + 1,
				commands: HashMap.set(s.commands, command.id, command),
				emitted: Array.append(s.emitted, command),
			}
		},
	})
const control = (c: CallFact): CallControl => ({
	key: c.key,
	member: {
		member: c.consumerMember,
		term: c.consumerTerm,
		generation: c.consumerGeneration,
	},
	session: c.session,
	request: c.request,
	service: c.service,
	route: c.route,
})
const affected = (s: Working, c: CallFact): Working => {
	const observed = Array.reduce(
		[c.provider, c.consumer],
		HashSet.empty<string>(),
		(set, id) =>
			Option.match(HashMap.get(s.units, id), {
				onNone: () => set,
				onSome: (u) =>
					HashSet.union(
						HashSet.add(set, u.owner),
						HashMap.reduce(u.members, HashSet.empty<string>(), (ids, member) =>
							HashSet.union(
								ids,
								Option.getOrElse(
									HashMap.get(s.observers, member.instance),
									HashSet.empty<string>,
								),
							),
						),
					),
			}),
	)
	const owners = HashSet.filter(observed, (id) =>
		Option.exists(
			HashMap.get(s.changes, id),
			(change) =>
				HashSet.has(change.requiredExits, c.provider) ||
				HashSet.has(change.requiredExits, c.consumer) ||
				(Option.isNone(change.conclusion) &&
					Array.some([c.provider, c.consumer], (unit) =>
						Option.exists(HashMap.get(s.units, unit), (u) => u.owner === id),
					)),
		),
	)
	return {
		...s,
		changed: HashSet.union(s.changed, owners),
		changes: HashSet.reduce(owners, s.changes, (changes, id) =>
			HashMap.modify(changes, id, (change) => ({
				...change,
				cause: Cause.combine(change.cause, c.cause),
			})),
		),
	}
}
const save = (s: Working, c: CallFact): Working =>
	issue(
		affected(
			{
				...s,
				activeCalls: c.credit
					? HashSet.add(s.activeCalls, c.key)
					: HashSet.remove(s.activeCalls, c.key),
				calls: HashMap.set(s.calls, c.key, c),
			},
			c,
		),
		"PublishCall",
		c.consumer,
		control(c),
		c,
	)
const reject = (
	s: Working,
	u: Unit,
	message: Extract<CallMessage, { _tag: "Request" }>,
	reason: string,
): Working =>
	issue(s, "CallReject", u.id, {
		key: id(u, message, message.session, message.request),
		member: message,
		session: message.session,
		request: message.request,
		service: message.service,
		reason,
	})
const available = (s: State, route: BindingRoute): boolean =>
	Option.exists(
		HashMap.get(s.units, route.unit),
		(u) =>
			u.incarnation === route.incarnation &&
			u.evidence === "Missing" &&
			u.phase === "Running" &&
			Option.exists(
				HashMap.get(u.members, route.provider),
				(member) =>
					member.term === route.term &&
					member.generation === route.generation &&
					Preparation.authorized(s, member.instance, member.target) &&
					(Executions.healthy(s, member.instance) ||
						startup(s, u, member.instance)),
			),
	)

const cooperative = (s: State, u: Unit, member: string) =>
	Option.flatMap(HashMap.get(s.memberOperationsByUnit, u.id), (ids) =>
		Array.findFirst(
			Array.flatMap(Array.fromIterable(ids), (id) =>
				Option.toArray(HashMap.get(s.memberOperations, id)),
			),
			(operation) =>
				operation.incarnation === u.incarnation &&
				HashSet.has(operation.members, member) &&
				(operation.phase === "Serving" ||
					operation.phase === "Installing" ||
					operation.phase === "Activating"),
		),
	)
const startup = (s: State, u: Unit, member: string): boolean =>
	Option.exists(
		HashMap.get(s.changes, u.owner),
		(c) =>
			HashSet.has(Attempt.units(c), u.id) &&
			!c.failure &&
			Array.contains(
				["Serving", "Readiness", "Probing", "Installing"],
				c.phase,
			),
	) || Option.isSome(cooperative(s, u, member))

const select = (
	s: State,
	u: Unit,
	message: Extract<CallMessage, { _tag: "Request" }>,
): Option.Option<BindingRoute> => {
	const attempt = cooperative(s, u, message.member)
	if (Option.isSome(attempt))
		return Array.findFirst(
			Bindings.memberView(s, attempt.value).routes,
			(route) =>
				route.consumer === message.member &&
				route.service === message.service &&
				available(s, route),
		)

	const committed = HashMap.get(
		s.routes,
		Bindings.key(message.member, message.service),
	)
	if (!startup(s, u, message.member))
		return Option.filter(committed, (r) => available(s, r))
	const c = HashMap.get(s.changes, u.owner)
	return Option.isSome(c) &&
		HashSet.has(Attempt.units(c.value), u.id) &&
		!c.value.failure
		? Array.findFirst(
				Bindings.view(s, c.value).routes,
				(r) =>
					r.consumer === message.member &&
					r.service === message.service &&
					available(s, r),
			)
		: Option.filter(committed, (r) => available(s, r))
}
const addIndex = (s: State, c: CallFact) =>
	Array.reduce([c.provider, c.consumer], s.callsByUnit, (index, unit) =>
		HashMap.set(
			index,
			unit,
			HashSet.add(
				Option.getOrElse(HashMap.get(index, unit), () => HashSet.empty()),
				c.key,
			),
		),
	)
const admit = (
	s: Working,
	u: Unit,
	message: Extract<CallMessage, { _tag: "Request" }>,
	route: BindingRoute,
): Working => {
	if (HashSet.size(s.activeCalls) >= s.callLimits.concurrency)
		return reject(s, u, message, "Saturated")
	const c: CallFact = {
		consumerMember: message.member,
		consumerTerm: message.term,
		consumerGeneration: message.generation,
		providerMember: route.provider,
		providerTerm: route.term,
		providerGeneration: route.generation,
		key: `${id(u, message, message.session, message.request)}/${route.incarnation.length}:${route.incarnation}`,
		consumer: u.id,
		consumerIncarnation: u.incarnation,
		provider: route.unit,
		providerIncarnation: route.incarnation,
		session: message.session,
		request: message.request,
		service: message.service,
		route,
		credit: true,
		dispatched: false,
		cancelled: false,
		result: "Pending",
		completion: Option.none(),
		cause: Cause.empty,
		sequence: 1,
	}
	const tags = Option.getOrElse(
		Option.map(u.description, (d) =>
			Array.flatMap(d.members, (m) =>
				Array.flatMap(m.requires, (b) =>
					m.instance === message.member && b.key === message.service
						? Array.map(b.operations, (o) => o.tag)
						: [],
				),
			),
		),
		() => [],
	)

	return issue(
		save(
			{
				...s,
				callsByUnit: addIndex(s, c),
				callRequests: HashMap.set(
					s.callRequests,
					id(u, message, message.session, message.request),
					c.key,
				),
				callSeen: HashSet.add(
					s.callSeen,
					id(u, message, message.session, message.request),
				),
			},
			c,
		),
		"CallRegister",
		route.unit,
		{ ...control(c), tags },
	)
}
const dequeue = (s: Working, w: CallWaiter): Working => {
	const u = HashMap.get(s.units, w.consumer)
	const binding = Option.match(u, {
		onNone: () => "",
		onSome: () => Bindings.key(w.message.member, w.message.service),
	})
	return {
		...s,
		callWaiters: HashMap.remove(s.callWaiters, w.key),
		waitingByBinding: HashMap.modify(s.waitingByBinding, binding, (ids) =>
			HashSet.remove(ids, w.key),
		),
	}
}
const enqueue = (
	s: Working,
	u: Unit,
	message: Extract<CallMessage, { _tag: "Request" }>,
): Working => {
	if (HashMap.size(s.callWaiters) >= s.callLimits.waiters)
		return reject(s, u, message, "WaiterOverflow")
	const key = id(u, message, message.session, message.request)
	const w: CallWaiter = {
		key,
		consumer: u.id,
		incarnation: u.incarnation,
		message,
		deadline: s.now + Math.min(Math.max(0, message.wait), s.callLimits.wait),
	}
	const binding = Bindings.key(message.member, message.service)
	return issue(
		{
			...s,
			callWaiters: HashMap.set(s.callWaiters, key, w),
			waitingByBinding: HashMap.set(
				s.waitingByBinding,
				binding,
				HashSet.add(
					Option.getOrElse(HashMap.get(s.waitingByBinding, binding), () =>
						HashSet.empty(),
					),
					key,
				),
			),
		},
		"CallArmTimer",
		u.id,
		{
			key,
			member: message,
			session: message.session,
			request: message.request,
			service: message.service,
			deadline: w.deadline,
		},
	)
}
const request = (
	s: Working,
	u: Unit,
	message: Extract<CallMessage, { _tag: "Request" }>,
): Working => {
	const key = id(u, message, message.session, message.request)
	if (
		!Number.isSafeInteger(s.callLimits.concurrency) ||
		s.callLimits.concurrency < 0 ||
		!Number.isSafeInteger(s.callLimits.waiters) ||
		s.callLimits.waiters < 0 ||
		!Number.isFinite(s.callLimits.wait) ||
		s.callLimits.wait < 0 ||
		!Number.isFinite(message.wait) ||
		message.wait < 0
	)
		return reject(s, u, message, "InvalidLimits")
	if (u.evidence !== "Missing" || u.kind !== "Execution" || !s.open)
		return reject(s, u, message, "Closed")
	if (message.nested) return reject(s, u, message, "NestedCompletion")
	if (HashSet.has(s.cancelledCalls, key))
		return reject(s, u, message, "CancelledBeforeDispatch")
	if (HashSet.has(s.callSeen, key) || HashMap.has(s.callWaiters, key))
		return reject(s, u, message, "Duplicate")
	const member = HashMap.get(u.members, message.member)
	if (
		Option.isNone(member) ||
		member.value.term !== message.term ||
		member.value.generation !== message.generation
	)
		return reject(s, u, message, "StaleGeneration")
	if (!Preparation.authorized(s, message.member, member.value.target))
		return reject(s, u, message, "Unauthorized")
	if (member.value.phase !== "Ready" && !startup(s, u, message.member))
		return reject(s, u, message, "Unavailable")
	if (!HashMap.has(s.bindings, Bindings.key(message.member, message.service)))
		return reject(s, u, message, "MissingBinding")
	return Option.match(select(s, u, message), {
		onSome: (r) => admit(s, u, message, r),
		onNone: () =>
			startup(s, u, message.member)
				? reject(s, u, message, "Unavailable")
				: enqueue(s, u, message),
	})
}
const finish = (s: Working, c: CallFact): Working => {
	const history = Array.append(s.callHistory, c.key)
	const expired = Array.take(
		history,
		Math.max(0, history.length - s.historyLimit),
	)
	return {
		...s,
		callHistory: Array.takeRight(history, s.historyLimit),
		calls: Array.reduce(expired, s.calls, (calls, key) =>
			HashMap.remove(calls, key),
		),
		callsByUnit: Array.reduce(expired, s.callsByUnit, (index, key) =>
			Option.match(HashMap.get(s.calls, key), {
				onNone: () => index,
				onSome: (c) =>
					Array.reduce([c.provider, c.consumer], index, (index, u) =>
						HashMap.modify(index, u, HashSet.remove(key)),
					),
			}),
		),
	}
}
const complete = (
	s: Working,
	u: Unit,
	message: Extract<CallMessage, { _tag: "Complete" }>,
): Working =>
	Option.match(HashMap.get(s.calls, message.key), {
		onNone: () =>
			issue(s, "CallCompleteAck", u.id, {
				key: message.key,
				member: message,
				session: "",
				request: "",
				service: "",
			}),
		onSome: (c) => {
			if (
				c.provider !== u.id ||
				c.providerIncarnation !== u.incarnation ||
				c.providerMember !== message.member ||
				c.providerTerm !== message.term ||
				c.providerGeneration !== message.generation
			)
				return s
			const quality: Working =
				message.cleanup._tag === "Failed"
					? {
							...s,
							units: HashMap.modify(s.units, u.id, (unit) => ({
								...unit,
								cleanup: message.cleanup,
								cause: Cause.combine(
									unit.cause,
									message.cleanup._tag === "Failed"
										? message.cleanup.cause
										: Cause.empty,
								),
							})),
						}
					: s
			const next = c.credit
				? finish(
						save(quality, {
							...c,
							credit: false,
							completion: Option.some(message.cleanup),
							cause: Cause.combine(
								c.cause,
								Cause.combine(
									message.cause,
									message.cleanup._tag === "Failed"
										? message.cleanup.cause
										: Cause.empty,
								),
							),
							sequence: c.sequence + 1,
						}),
						c,
					)
				: s
			return issue(next, "CallCompleteAck", u.id, control(c))
		},
	})
const observeMessage = (s: Working, e: CallEvidence): Working =>
	Option.match(HashMap.get(s.units, e.unit), {
		onNone: () => s,
		onSome: (u) => {
			if (u.incarnation !== e.incarnation || u.spawn !== e.observer) return s
			if (e.message._tag === "Request") return request(s, u, e.message)
			if (e.message._tag === "Complete") return complete(s, u, e.message)
			const message = e.message
			const key = id(u, message, message.session, message.request)
			const waiting = HashMap.get(s.callWaiters, key)
			if (message._tag === "Cancel" && Option.isSome(waiting))
				return reject(
					dequeue(s, waiting.value),
					u,
					waiting.value.message,
					"CancelledBeforeDispatch",
				)
			return Option.match(
				Option.flatMap(HashMap.get(s.callRequests, key), (key) =>
					HashMap.get(s.calls, key),
				),
				{
					onNone: () => s,
					onSome: (c) => {
						if (message._tag === "Lost")
							return save(s, {
								...c,
								result: c.result === "Received" ? "Received" : "Unknown",
								cause: Cause.combine(c.cause, message.cause),
								sequence: c.sequence + 1,
							})
						if (message._tag === "Result")
							return c.result === "Received"
								? s
								: save(s, {
										...c,
										result: "Received",
										sequence: c.sequence + 1,
									})
						if (c.cancelled) return s
						return issue(
							save(s, { ...c, cancelled: true, sequence: c.sequence + 1 }),
							"CallCancel",
							c.provider,
							control(c),
						)
					},
				},
			)
		},
	})
export const observed = (s: Working, e: CallEvidence): Working => {
	if (e.message._tag !== "Cancel") return observeMessage(s, e)
	const u = HashMap.get(s.units, e.unit)
	if (
		Option.isNone(u) ||
		u.value.incarnation !== e.incarnation ||
		u.value.spawn !== e.observer
	)
		return s
	return observeMessage(
		{
			...s,
			cancelledCalls: HashSet.add(
				s.cancelledCalls,
				id(u.value, e.message, e.message.session, e.message.request),
			),
		},
		e,
	)
}
const reportedCommand = (s: Working, command: Command): Working => {
	if (command.call === undefined) return s
	const call = HashMap.get(s.calls, command.call.key)
	if (
		Option.isNone(call) ||
		command.kind !== "CallRegister" ||
		Option.isNone(command.report)
	)
		return s
	const c = call.value
	if (command.report.value._tag === "Failed")
		return issue(
			issue(s, "CallCancel", c.provider, control(c)),
			"CallReject",
			c.consumer,
			{ ...control(c), reason: "Unknown" },
		)

	return c.cancelled || !c.credit
		? s
		: issue(
				save(s, { ...c, dispatched: true, sequence: c.sequence + 1 }),
				"CallGrant",
				c.consumer,
				control(c),
			)
}
export const expired = (s: Working, key: string): Working =>
	Option.match(HashMap.get(s.callWaiters, key), {
		onNone: () => s,
		onSome: (w) =>
			s.now < w.deadline
				? s
				: Option.match(HashMap.get(s.units, w.consumer), {
						onNone: () => dequeue(s, w),
						onSome: (u) => reject(dequeue(s, w), u, w.message, "WaiterExpired"),
					}),
	})
export const resume = (s: Working, instance: string): Working =>
	HashSet.reduce(Bindings.outgoing(s, instance), s, (s, binding) =>
		HashSet.reduce(
			Option.getOrElse(HashMap.get(s.waitingByBinding, binding), () =>
				HashSet.empty<string>(),
			),
			s,
			(s, key) =>
				Option.match(HashMap.get(s.callWaiters, key), {
					onNone: () => s,
					onSome: (w) =>
						Option.match(HashMap.get(s.units, w.consumer), {
							onNone: () => dequeue(s, w),
							onSome: (u) =>
								Option.match(select(s, u, w.message), {
									onNone: () => expired(s, key),
									onSome: (r) =>
										s.now >= w.deadline
											? expired(s, key)
											: admit(dequeue(s, w), u, w.message, r),
								}),
						}),
				}),
		),
	)
const endCalls = (s: Working, u: Unit): Working =>
	HashSet.reduce(ids(s, u.id), s, (s, key) =>
		Option.match(HashMap.get(s.calls, key), {
			onNone: () => s,
			onSome: (c) => {
				if (
					c.provider === u.id &&
					c.providerIncarnation === u.incarnation &&
					c.credit
				)
					return finish(
						save(s, {
							...c,
							credit: false,
							result: c.result === "Received" ? "Received" : "Unknown",
							sequence: c.sequence + 1,
						}),
						c,
					)
				if (
					(c.consumer === u.id || c.provider === u.id) &&
					!c.credit &&
					c.result === "Pending"
				)
					return save(s, { ...c, result: "Unknown", sequence: c.sequence + 1 })
				if (c.consumer === u.id && c.credit)
					return issue(
						save(s, {
							...c,
							cancelled: true,
							result: c.result === "Received" ? "Received" : "Unknown",
							sequence: c.sequence + 1,
						}),
						"CallCancel",
						c.provider,
						control(c),
					)
				return s
			},
		}),
	)
export const outstanding = (
	s: State,
	units: HashSet.HashSet<string>,
): HashSet.HashSet<string> =>
	HashSet.reduce(units, HashSet.empty<string>(), (calls, unit) =>
		HashSet.union(
			calls,
			HashSet.filter(ids(s, unit), (id) =>
				Option.exists(HashMap.get(s.calls, id), (c) => c.credit),
			),
		),
	)
export const providerOutstanding = (s: State, unit: string): boolean =>
	HashSet.some(ids(s, unit), (id) =>
		Option.exists(
			HashMap.get(s.calls, id),
			(c) => c.credit && c.provider === unit,
		),
	)
export const memberOutstanding = (
	s: State,
	unit: string,
	members: HashSet.HashSet<string>,
): boolean =>
	HashSet.some(ids(s, unit), (id) =>
		Option.exists(
			HashMap.get(s.calls, id),
			(call) =>
				call.credit &&
				call.provider === unit &&
				HashSet.has(members, call.providerMember),
		),
	)
export const cancelProvider = (s: Working, unit: string): Working =>
	HashSet.reduce(ids(s, unit), s, (s, id) =>
		Option.match(HashMap.get(s.calls, id), {
			onNone: () => s,
			onSome: (c) =>
				c.credit && c.provider === unit
					? issue(
							save(s, { ...c, cancelled: true, sequence: c.sequence + 1 }),
							"CallCancel",
							c.provider,
							control(c),
						)
					: s,
		}),
	)

const failedCommand = (
	s: Working,
	command: Command,
	cause: Cause.Cause<unknown>,
): Working => {
	const observed = {
		...s,
		units: HashMap.modify(s.units, command.unit, (u) => ({
			...u,
			cause: Cause.combine(u.cause, cause),
		})),
	}
	if (command.call === undefined) return observed
	return Option.match(HashMap.get(s.calls, command.call.key), {
		onNone: () => observed,
		onSome: (c) => {
			const updated: CallFact = {
				...c,
				cause: Cause.combine(c.cause, cause),
				result:
					(command.kind === "CallRegister" || command.kind === "CallGrant") &&
					c.result === "Pending"
						? "Unknown"
						: c.result,
				sequence: c.sequence + 1,
			}
			return command.kind === "PublishCall"
				? affected(
						{ ...observed, calls: HashMap.set(observed.calls, c.key, updated) },
						updated,
					)
				: save(observed, updated)
		},
	})
}
export const reported = (s: Working, command: Command): Working => {
	const observed =
		Option.isSome(command.report) && command.report.value._tag === "Failed"
			? failedCommand(s, command, command.report.value.cause)
			: s
	const next = reportedCommand(observed, command)
	return { ...next, commands: HashMap.remove(next.commands, command.id) }
}
export const disconnected = (
	s: Working,
	event: {
		readonly unit: string
		readonly incarnation: string
		readonly observer: string
	},
): Working =>
	Option.match(HashMap.get(s.units, event.unit), {
		onNone: () => s,
		onSome: (u) =>
			u.incarnation !== event.incarnation || u.spawn !== event.observer
				? s
				: HashSet.reduce(ids(s, u.id), s, (s, id) =>
						Option.match(HashMap.get(s.calls, id), {
							onNone: () => s,
							onSome: (c) =>
								c.result === "Pending"
									? save(s, {
											...c,
											result: "Unknown",
											sequence: c.sequence + 1,
										})
									: s,
						}),
					),
	})
const endedUnit = (s: Working, u: Unit): Working =>
	HashSet.reduce(
		HashMap.reduce(u.members, HashSet.empty<string>(), (ids, member) =>
			HashSet.union(ids, Bindings.outgoing(s, member.instance)),
		),
		endCalls(s, u),
		(s, key) =>
			Option.match(HashMap.get(s.bindings, key), {
				onNone: () => s,
				onSome: (b) =>
					Option.match(
						Option.flatMap(
							HashMap.get(s.instances, b.consumer),
							(i) => i.current,
						),
						{
							onNone: () => s,
							onSome: (consumer) =>
								issue(s, "RetireRoute", consumer, {
									member: Option.getOrElse(
										Option.map(Executions.current(s, b.consumer), (value) => ({
											member: b.consumer,
											term: value.member.term,
											generation: value.member.generation,
										})),
										() => ({ member: b.consumer, term: 0, generation: 0 }),
									),
									key: u.incarnation,
									session: "",
									request: "",
									service: b.service,
								}),
						},
					),
			}),
	)

export const closed = (s: Working): Working =>
	HashMap.reduce(s.callWaiters, s, (s, w) =>
		Option.match(HashMap.get(s.units, w.consumer), {
			onNone: () => dequeue(s, w),
			onSome: (u) => reject(dequeue(s, w), u, w.message, "Closed"),
		}),
	)
const endedWaiters = (s: Working, u: Unit): Working =>
	HashSet.reduce(
		HashMap.reduce(u.members, HashSet.empty<string>(), (ids, member) =>
			HashSet.union(ids, Bindings.incoming(s, member.instance)),
		),
		s,
		(s, binding) =>
			HashSet.reduce(
				Option.getOrElse(HashMap.get(s.waitingByBinding, binding), () =>
					HashSet.empty<string>(),
				),
				s,
				(s, key) =>
					Option.match(HashMap.get(s.callWaiters, key), {
						onNone: () => s,
						onSome: (w) =>
							w.consumer === u.id && w.incarnation === u.incarnation
								? dequeue(s, w)
								: s,
					}),
			),
	)
export const ended = (s: Working, u: Unit): Working =>
	endedUnit(endedWaiters(s, u), u)
