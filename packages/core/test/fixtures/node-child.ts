/** Child process entry: serves the counter over standard input and output. */
import { Effect } from "effect"

import { layerProtocolStdio } from "../../src/node/index.ts"
import { serverProgram } from "./node-service.ts"

await Effect.runPromise(serverProgram(layerProtocolStdio))
