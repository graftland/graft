import { Schema } from "effect"
import { Contract } from "../../src/index"

export class Rejected extends Schema.TaggedError<
	Rejected,
	{ readonly brand: unique symbol }
>()("Rejected", { value: Schema.Int }) {}
export const config = Schema.Struct({
	directory: Schema.String,
	mode: Schema.Literals([
		"normal",
		"leaked-handle",
		"wait",
		"fail",
		"crash",
		"cleanup-fail",
		"retry",
		"background-fail",
		"flood",
	]),
	value: Schema.Int,
})
export const contract = Contract.make({
	name: "remote-fixture",
	config,
	error: Rejected,
	module: new URL("./plugin.js", import.meta.url).href,
})
