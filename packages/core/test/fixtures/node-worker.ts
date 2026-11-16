/** Worker entry: serves the counter over the worker channel. */
import { Effect } from "effect"

import { layerProtocolWorker } from "../../src/node/index.ts"
import { serverProgram } from "./node-service.ts"

Effect.runFork(serverProgram(layerProtocolWorker))
