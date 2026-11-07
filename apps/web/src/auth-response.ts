import { api } from "@palimora/contracts";

/** Reject incompatible authentication responses before enabling local session state. */
export function readAuthResponse(value: unknown) {
  const result = api.me.output.safeParse(value);
  if (!result.success) throw new Error("API_VERSION_MISMATCH");
  return result.data;
}
