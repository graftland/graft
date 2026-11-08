import { String } from "effect"
import { assert, it } from "@effect/vitest"

import type * as Kernel from "@graftland/graft/Kernel"
import * as Units from "@graftland/plugin-remote/Units"

import { plan, type LoadedRelease } from "../src/index"

const target = (
	digest: string,
	input: string = "first",
	directory: string = "/release/first",
) =>
	Units.target({
		artifact: {
			directory,
			identity: {
				version: 1,
				algorithm: "sha256",
				digest: String.repeat(64)(digest),
				module: "plugin.js",
			},
		},
		input: { value: input },
		placement: "Worker",
	})
const entry = (
	id: string,
	target: Kernel.Target,
	probes: ReadonlyArray<string> = [],
) => ({ id, target, probes })
const release = (entries: LoadedRelease["entries"]): LoadedRelease => ({
	id: String.repeat(64)("a"),
	entries,
})

it("plans added, changed and removed members in one Change with a reason for each", () => {
	const first = target("a")
	const second = target("b")
	const result = plan(
		release([
			entry("same", first),
			entry("changed", second, ["ready"]),
			entry("new", first, ["ready", "online"]),
		]),
		[entry("same", first), entry("changed", first), entry("removed", first)],
	)
	assert.deepEqual(result.members, [
		{ instance: "changed", reason: "Changed" },
		{ instance: "new", reason: "Added" },
		{ instance: "removed", reason: "Removed" },
	])
	assert.deepEqual(result.operations, [
		{ _tag: "Deploy", instance: "changed", target: second },
		{ _tag: "Deploy", instance: "new", target: first },
		{ _tag: "Remove", instance: "removed" },
	])
	assert.deepEqual(result.probes, ["ready", "online"])
})

it("ignores artifact relocation but detects input and placement changes", () => {
	const first = target("a")
	assert.deepEqual(
		plan(release([entry("a", target("a", "first", "/release/second"))]), [
			entry("a", first),
		]).operations,
		[],
	)
	assert.deepEqual(
		plan(release([entry("a", target("a", "second"))]), [entry("a", first)])
			.members,
		[{ instance: "a", reason: "Changed" }],
	)
	assert.deepEqual(
		plan(release([entry("a", { ...first, placement: "Process" })]), [
			entry("a", first),
		]).members,
		[{ instance: "a", reason: "Changed" }],
	)
})

it("plans an empty release as removals and leaves both inputs unchanged", () => {
	const current = [entry("a", target("a"))]
	const desired = release([])
	assert.deepEqual(plan(desired, current).operations, [
		{ _tag: "Remove", instance: "a" },
	])
	assert.equal(current.length, 1)
	assert.equal(desired.entries.length, 0)
	assert.deepEqual(plan(desired, []).operations, [])
})

it("runs changed probe requirements even when code and input stay the same", () => {
	const first = target("a")
	assert.deepEqual(
		plan(release([entry("a", first, ["ready"])]), [entry("a", first)]).members,
		[{ instance: "a", reason: "Changed" }],
	)
	assert.deepEqual(
		plan(release([entry("a", first, ["ready"])]), [
			entry("a", first, ["ready"]),
		]).operations,
		[],
	)
})
