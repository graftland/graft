import { Context } from "effect"

import { GraftKey, type Activation, type Runtime } from "./runtime"

/** Internal view of the same context key; the public service does not expose the graph. */
export class RuntimeContext extends Context.Service<
	RuntimeContext,
	{
		readonly runtime: Runtime
		readonly activation: Activation
	}
>()(GraftKey) {}
