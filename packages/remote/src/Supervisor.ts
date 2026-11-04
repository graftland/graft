/** A listener hands an authenticated byte channel to the supervisor. */
import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { Peer } from "./Auth"
import type { Channel } from "./Transport"
import type { TransportError } from "./Errors"
export class Supervisor extends Context.Service<
	Supervisor,
	{
		readonly accept: (
			channel: Channel,
		) => Effect.Effect<void, TransportError, Peer | Scope.Scope>
	}
>()("@graftland/remote/Supervisor") {}
