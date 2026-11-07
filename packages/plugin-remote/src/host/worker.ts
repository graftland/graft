import { Effect } from "effect"

import { Plugin } from "@graftland/graft"

import { WorkerTransport } from "../internal/directTransport"
import { start } from "../internal/workerTransport"

export default Plugin.service(WorkerTransport, Effect.succeed({ start }), {
	name: "@graftland/plugin-remote/host/worker",
})
