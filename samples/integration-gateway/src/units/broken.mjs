import { make } from "./provider.mjs"

export { deployment } from "./provider.mjs"

/** Version 3 fails its health probe, so its upgrade must not take over. */
export default make(3, false)
