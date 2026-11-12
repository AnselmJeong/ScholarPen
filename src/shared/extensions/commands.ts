import type { ScholarRPC } from "../scholar-rpc";
import type { PluginContext } from "./contracts";
type Requests = ScholarRPC["bun"]["requests"];
/** Compatibility types only. Historical RPC routing stays in the generated host adapter. */
export type CommandHandlers = { [K in keyof Requests]: (params: Requests[K]["params"]) => Requests[K]["response"] | Promise<Requests[K]["response"]> };
export function registerCommands<T extends object>(context: PluginContext, namespace: string, handlers: T) {
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== "function") throw new Error("Invalid command handler.");
    context.register(`${namespace}.${name}`, (args, signal) => handler(args, signal));
  }
}
