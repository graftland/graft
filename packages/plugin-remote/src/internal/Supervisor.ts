/** A listener hands an authenticated byte channel to the supervisor. */
import { Context, type Effect, type Scope } from "effect"

import type { TransportError } from "../Errors"
import type { Channel } from "../Transport"
import type { Peer } from "./Peer"

export class Supervisor extends Context.Service<
	Supervisor,
	{
		readonly accept: (
			channel: Channel,
		) => Effect.Effect<void, TransportError, Peer | Scope.Scope>
	}
>()("@graftland/plugin-remote/internal/Supervisor") {}
