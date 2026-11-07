import { readAuthResponse } from "./auth-response";
import { offlineCall } from "./offline";
import {
  api,
  type Operation,
  type Input,
  type Output,
  type ErrorCode,
} from "@palimora/contracts";
let csrf = "";
let authenticated = false;
export class ApiFailure extends Error {
  constructor(
    public code: ErrorCode,
    public requestId = "",
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
export async function transport<K extends Operation>(
  name: K,
  input: Input<K>,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<Output<K>> {
  const e = api[name];
  let path = e.path;
  const body = { ...input } as Record<string, unknown>;
  for (const match of e.path.matchAll(/:(\w+)/g)) {
    path = path.replace(match[0], encodeURIComponent(String(body[match[1]])));
    delete body[match[1]];
  }
  if (e.method === "get") {
    const query = new URLSearchParams(
      Object.entries(body)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    if (query.size) path += "?" + query;
  }
  const response = await fetch("/api/v1" + path, {
    method: e.method.toUpperCase(),
    credentials: "same-origin",
    keepalive: options.keepalive,
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(e.method !== "get" ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  if (!response.ok) {
    if (
      authenticated &&
      response.status === 401 &&
      json.code === "UNAUTHENTICATED"
    ) {
      authenticated = false;
      csrf = "";
      window.dispatchEvent(new Event("session-expired"));
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiFailure(
      json.code,
      json.requestId,
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter)
        : undefined,
    );
  }
  if ("csrf" in json) {
    csrf = readAuthResponse(json).csrf;
    authenticated = true;
  }
  if (["logout", "password", "deleteAccount"].includes(name)) {
    authenticated = false;
    csrf = "";
  }
  return json;
}

const pendingWrites = new Set<Promise<unknown>>();
export async function settleWrites() {
  await Promise.allSettled([...pendingWrites]);
}
export function call<K extends Operation>(
  name: K,
  input: Input<K>,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<Output<K>> {
  const pending = offlineCall(name, input, transport, options);
  if (name === "readingSave" || name === "annotationSave") {
    pendingWrites.add(pending);
    void pending.finally(() => pendingWrites.delete(pending)).catch(() => {});
  }
  return pending;
}
