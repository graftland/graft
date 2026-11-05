import { Config, plugin } from "../../internal/auth/tokenCredentials"

export { Config }

const capability = plugin("remote-jwt-credentials")
export default capability
