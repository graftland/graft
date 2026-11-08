/** Inspection infrastructure for explicitly embedded CLI composition roots. */
import { Context, Layer } from "effect"

import { Kernel } from "@graftland/graft"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

export class Address extends Context.Service<Address, Control.Address>()(
	"@graftland/cli/internal/inspection/Address",
) {}

export const layer = Layer.effect(Address, Control.serve()).pipe(
	Layer.provide(
		Kernel.layer({
			authority: "cli-inspection",
			maxUnits: 8,
			instances: [],
		}).pipe(Layer.provide(Units.layer)),
	),
)
