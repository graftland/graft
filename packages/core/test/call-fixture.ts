import { Array, Cause, HashMap, Option } from "effect"

import * as Bindings from "../src/internal/bindingCore"
import * as Core from "../src/internal/decisionCore"
import { declaredMembers, rootRealms } from "./member-fact"

export const setup = () => {
	const initial = Core.make({
		authority: "calls",
		maxUnits: 4,
		declarations: declaredMembers([
			{
				id: "provider",
				target: { identity: "provider", placement: "Worker", overlap: true },
			},
			{
				id: "consumer",
				target: { identity: "consumer", placement: "Worker", overlap: true },
			},
			{
				id: "other",
				target: { identity: "other", placement: "Worker", overlap: true },
			},
		]),
		realms: rootRealms,
		bindings: [
			{ consumer: "consumer", provider: "provider", service: "weather" },
			{ consumer: "consumer", provider: "other", service: "other" },
		],
	})
	const route: Core.BindingRoute = {
		id: Bindings.key("consumer", "weather"),
		consumer: "consumer",
		provider: "provider",
		service: "weather",
		unit: "provider@0",
		incarnation: "calls/provider@0",
		term: 0,
		version: 1,
		endpoint: { host: "127.0.0.1", port: 12345, credential: "secret" },
	}
	return {
		...initial,
		routes: HashMap.make(
			[route.id, route],
			[
				Bindings.key("consumer", "other"),
				{
					...route,
					id: Bindings.key("consumer", "other"),
					provider: "other",
					service: "other",
					unit: "other@0",
					incarnation: "calls/other@0",
				},
			],
		),
	}
}
export const observe = (
	s: Core.State,
	message: Core.CallMessage,
	unit = "consumer@0",
) => {
	const u = HashMap.get(s.units, unit).pipe(Option.getOrThrow)
	return Core.reduce(s, {
		_tag: "CallObserved",
		unit,
		incarnation: u.incarnation,
		observer: u.spawn,
		message,
		now: s.now,
	}).state
}
export const requested = (s = setup(), session = "session-a", request = "1") =>
	observe(s, {
		_tag: "Request",
		session,
		request,
		service: "weather",
		lifecycle: false,
		nested: false,
		wait: 50,
	})
export const one = (s: Core.State) =>
	Array.head(Array.fromIterable(HashMap.values(s.calls))).pipe(
		Option.getOrThrow,
	)
export const complete = (s: Core.State, key = one(s).key) =>
	observe(
		s,
		{
			_tag: "Complete",
			key,
			cleanup: { _tag: "Completed" },
			cause: Cause.empty,
		},
		"provider@0",
	)
export const registered = (s: Core.State): Core.State => {
	const command = Array.findFirst(
		HashMap.values(s.commands),
		(c) => c.kind === "CallRegister" && c.disposition === "Pending",
	).pipe(Option.getOrThrow)
	return Core.reduce(s, {
		_tag: "Reported",
		command: command.id,
		token: command.token,
		result: { _tag: "Succeeded" },
		now: s.now,
	}).state
}
export const result = (s: Core.State, session = "session-a") =>
	observe(one(s).dispatched ? s : registered(s), {
		_tag: "Result",
		session,
		request: "1",
	})
