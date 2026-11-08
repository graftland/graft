/** Capability-protected metadata control from outside the kernel process. */
export {
	Address,
	Deployment,
	ControlError,
	type Policy,
} from "./internal/controlProtocol"
export { serve } from "./internal/controlServer"
export { connect, type Client, type Handle } from "./internal/controlClient"
