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
  ) {
    super(code);
  }
}
export async function call<K extends Operation>(
  name: K,
  input: Input<K>,
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
    throw new ApiFailure(json.code, json.requestId);
  }
  if ("csrf" in json) {
    csrf = json.csrf;
    authenticated = true;
  }
  if (["logout", "password", "deleteAccount"].includes(name)) {
    authenticated = false;
    csrf = "";
  }
  return json;
}
