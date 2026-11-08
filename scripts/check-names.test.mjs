import { expect, it } from "vitest"

import { check, errorMismatches, exportNames } from "./check-names.mjs"

it("the repository follows the naming rules", () => {
	expect(check()).toEqual([])
})

it("finds an error class whose name differs from its tag", () => {
	const text = `export class Denied extends Schema.TaggedError<
	Denied,
	{ readonly brand: unique symbol }
>()("CapabilityDenied", { reason: Schema.String }) {}
export class Same extends Data.TaggedError("Same")<{}> {}`
	expect(errorMismatches(text)).toEqual([["Denied", "CapabilityDenied"]])
})

it("reads declarations, namespaces and multi-line re-exports", () => {
	const text = `export const Change = 1
export * as Plugin from "./Plugin"
export {
	Service,
	type Operations,
	install as Unit,
} from "./internal/policy"`
	expect(exportNames(text)).toEqual([
		"Change",
		"Plugin",
		"Service",
		"Operations",
		"Unit",
	])
})
