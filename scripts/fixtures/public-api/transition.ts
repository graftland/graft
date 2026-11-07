import { Change, Kernel } from "@graftland/graft"

export const transition = (request: Change.Request) => Change.run(request)
export const observe = (id: string) => Change.get(id)
export const submit = (request: Change.Request) => Change.submit(request)
export const kernel = Kernel.Kernel
