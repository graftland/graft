import { Schema } from "effect"

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
export const Limits = Schema.Struct({
	control: PositiveInt,
	data: PositiveInt,
	log: PositiveInt,
})
export type Limits = typeof Limits.Type
export type Priority = keyof Limits
export const defaults: Limits = { control: 8, data: 16, log: 2 }
