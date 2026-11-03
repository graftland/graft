import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import {
	Array,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Stream,
} from "effect"
import { onboard, request } from "./hosting.ts"
import { ready } from "./lifecycle.ts"
import { quota } from "./quota.ts"

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	// Each run starts from empty tenant files, so its quotas and output repeat.
	const directory = "data"
	yield* fs.remove(directory, { recursive: true, force: true })
	yield* fs.makeDirectory(directory, { recursive: true })
	yield* Effect.log(
		"--- 1. Start one shared quota service and onboard Acorn (free) ---",
	)
	const shared = yield* Graft.plugin(quota)
	yield* ready(shared)
	const acorn = yield* onboard({
		id: "acorn",
		plan: "free",
		file: path.join(directory, "acorn.json"),
	})
	yield* request("acorn", {
		_tag: "Save",
		note: { id: "launch", text: "Acorn's private launch checklist" },
	})

	yield* Effect.log(
		"--- 2. Onboard Northstar (pro) while Acorn is serving requests ---",
	)
	const northstar = yield* onboard({
		id: "northstar",
		plan: "pro",
		file: path.join(directory, "northstar.json"),
	})
	const hidden = yield* request("northstar", { _tag: "Read", id: "launch" })
	yield* Effect.log("Northstar cannot read Acorn's launch note", {
		reply: Option.getOrUndefined(hidden),
	})
	yield* request("northstar", {
		_tag: "Save",
		note: { id: "launch", text: "Northstar's own launch checklist" },
	})

	yield* Effect.log(
		"--- 3. The same quota service reads each caller's Plan: free=1, pro=3 ---",
	)
	for (const id of ["acorn", "northstar"]) {
		const reply = yield* request(id, {
			_tag: "Save",
			note: { id: "handoff", text: "Support handoff" },
		})
		yield* Effect.log("Second note result", {
			tenant: id,
			reply: Option.getOrUndefined(reply),
		})
	}
	const tree = yield* Stream.runHead(Graft.forks)
	const lines = Array.flatMap(
		Option.getOrElse(tree, () => []),
		(fork) => [
			`${fork.name} #${fork.id}: ${fork.state._tag}`,
			...Array.map(
				fork.children,
				(child) => `  ${child.name} #${child.id}: ${child.state._tag}`,
			),
		],
	)
	yield* Effect.log(`Live plugin tree\n${Array.join(lines, "\n")}`)

	yield* Effect.log(
		"--- 4. Offboard Acorn. Watch Notes stopped before Storage flushed and closed ---",
	)
	yield* acorn.dispose
	const offline = yield* request("acorn", { _tag: "Read", id: "launch" })
	yield* Effect.log("Acorn's handler is gone", {
		noHandler: Option.isNone(offline),
	})
	const stillServing = yield* request("northstar", {
		_tag: "Read",
		id: "launch",
	})
	yield* Effect.log("Northstar still serves its own note", {
		reply: Option.getOrUndefined(stillServing),
	})
	const persisted = yield* fs.readFileString(path.join(directory, "acorn.json"))
	yield* Effect.log("Acorn's flushed JSON", persisted)

	yield* Effect.log(
		"--- 5. Shut down Northstar and inspect the two separate JSON files ---",
	)
	yield* northstar.dispose
	yield* Effect.log("Demo complete", { directory })
})

const main = program.pipe(
	Effect.scoped,
	// @effect-diagnostics-next-line strictEffectProvide:off -- this is the application entry point and owns the complete runtime
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(
				NodeServices.layer,
				Logger.layer([Logger.consolePretty()]),
			),
		),
	),
)

NodeRuntime.runMain(main)
