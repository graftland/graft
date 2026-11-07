import { ChildProcessSpawner } from "effect/process"

import { Plugin } from "@graftland/graft"

import { LocalTransport } from "../internal/directTransport"
import { make } from "../internal/localTransport"

export default Plugin.service(LocalTransport, make, {
	name: "@graftland/plugin-remote/host/local",
	inject: [ChildProcessSpawner.ChildProcessSpawner],
})
