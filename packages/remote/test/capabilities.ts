import { Graft, Plugin } from "@graftland/graft"
import { Effect, Layer } from "effect"
import local from "../src/host/local"
import tls from "../src/host/tls"
import mtls from "../src/host/auth/mtls"

const load = (
	plugins: ReadonlyArray<Plugin.Plugin<void, void, Graft.ServiceConflict>>,
) =>
	Effect.forEach(
		plugins,
		(plugin) => Graft.plugin(plugin).pipe(Effect.flatMap((fork) => fork.await)),
		{ discard: true },
	)
export const localRuntime = Layer.provideMerge(
	Layer.effectDiscard(load([local])),
	Graft.layer,
)
export const runnerRuntime = Layer.provideMerge(
	Layer.effectDiscard(load([tls, mtls])),
	Graft.layer,
)
