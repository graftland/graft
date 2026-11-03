import { NodeRuntime } from "@effect/platform-node"
import { run } from "../../src/Runner"
import { contract } from "./contract"

NodeRuntime.runMain(run(contract))
