import { Context } from "effect"
export class Peer extends Context.Service<Peer, string>()(
	"@graftland/plugin-remote/internal/Peer",
) {}
