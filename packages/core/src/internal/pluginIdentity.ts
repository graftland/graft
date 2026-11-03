import { Equal, Hash } from "effect"
import type { Plugin } from "../Plugin"

/** Runtime keys use object identity, regardless of a definition's construction or equality protocol. */
export class PluginIdentity implements Equal.Equal {
	private readonly plugin: Plugin

	constructor(plugin: Plugin) {
		this.plugin = plugin
	}

	[Equal.symbol](that: Equal.Equal): boolean {
		return that instanceof PluginIdentity && this.plugin === that.plugin
	}

	[Hash.symbol](): number {
		// Hash.random caches by reference without consulting or changing the plugin's own protocols.
		return Hash.random(this.plugin)
	}
}
