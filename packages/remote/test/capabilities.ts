import { Graft, Plugin } from "@graftland/graft"
import { Effect, Layer } from "effect"
import local from "../src/host/local"
import websocket from "../src/host/websocket"
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
	Layer.effectDiscard(load([websocket, mtls])),
	Graft.layer,
)
