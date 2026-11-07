import { EventEmitter } from "node:events"

import { Effect } from "effect"

import Emittery from "emittery"

import { audit, snapshot, type Case, type Fixture } from "./model"

export const node = (spec: Case): Effect.Effect<Fixture> =>
	Effect.sync(() => {
		const state = audit()
		const emitter = new EventEmitter()
		emitter.setMaxListeners(spec.size)
		for (let i = 0; i < spec.size; i++)
			emitter.on("message", () => {
				state.handlers++
			})
		return {
			run: Effect.sync(() => {
				for (let i = 0; i < spec.calls; i++) emitter.emit("message")
				return 0
			}),
			close: Effect.sync(() => {
				emitter.removeAllListeners()
			}),
			read: snapshot(state),
		}
	})
export const emittery = (spec: Case): Effect.Effect<Fixture> =>
	Effect.sync(() => {
		const state = audit()
		const emitter = new Emittery<{ message: undefined }>()
		for (let i = 0; i < spec.size; i++)
			emitter.on("message", () => {
				state.handlers++
			})
		return {
			run: Effect.gen(function* () {
				for (let i = 0; i < spec.calls; i++)
					yield* Effect.promise(() =>
						spec.scenario === "events-parallel"
							? emitter.emit("message")
							: emitter.emitSerial("message"),
					)
				return 0
			}),
			close: Effect.sync(() => {
				emitter.clearListeners()
			}),
			read: snapshot(state),
		}
	})
