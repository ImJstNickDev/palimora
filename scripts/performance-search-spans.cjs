// Opt-in diagnostic preload. Does not change queries, responses or production defaults.
if (
  process.env.P2E_SEARCH_SPANS ||
  process.env.NODE_OPTIONS?.includes("performance-search-spans.cjs")
) {
  const fs = require("node:fs");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const { randomUUID } = require("node:crypto");
  const { performance } = require("node:perf_hooks");
  if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
    throw Error("Search diagnostics require an isolated test database");
  const context = new AsyncLocalStorage();
  const clock = () => performance.now();
  function span(kind, started, extra = {}) {
    const request = context.getStore();
    if (request && !request.finished)
      request.spans.push({
        kind,
        start_ms: started - request.start,
        end_ms: clock() - request.start,
        ...extra,
      });
  }
  const http = require("node:http");
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (
      event !== "request" ||
      args[0].method !== "GET" ||
      args[0].url.split("?")[0] !== "/api/v1/works"
    )
      return emit.call(this, event, ...args);
    const request = { id: randomUUID(), start: clock(), spans: [] };
    const response = args[1];
    let ended = false;
    const finish = (aborted) => {
      if (ended) return;
      ended = true;
      request.finished = true;
      fs.appendFileSync(
        process.env.P2E_SEARCH_SPANS || "/results/search-spans.jsonl",
        JSON.stringify({
          id: request.id,
          status: response.statusCode,
          aborted,
          wall_ms: clock() - request.start,
          spans: request.spans,
        }) + "\n",
      );
    };
    response.once("finish", () => finish(false));
    response.once("close", () => finish(!response.writableFinished));
    return context.run(request, () => emit.call(this, event, ...args));
  };
  const pg = require("pg");
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    if (!context.getStore()) return query.apply(this, args);
    const start = clock();
    let recorded = false;
    const finish = () => {
      if (!recorded) {
        recorded = true;
        span("postgres.client", start);
      }
    };
    if (typeof args.at(-1) === "function") {
      const callback = args.at(-1);
      args[args.length - 1] = function (...values) {
        finish();
        return callback.apply(this, values);
      };
    }
    try {
      const result = query.apply(this, args);
      return result?.then ? result.finally(finish) : result;
    } catch (error) {
      finish();
      throw error;
    }
  };
  const fetch = global.fetch;
  global.fetch = async function (...args) {
    if (!context.getStore()) return fetch(...args);
    const url = new URL(String(args[0]));
    if (
      url.origin !==
      new URL(process.env.OPENSEARCH_URL ?? "http://opensearch:9200").origin
    )
      return fetch(...args);
    const start = clock(),
      method = args[1]?.method ?? "GET";
    const kind = url.pathname.endsWith("/_search")
      ? "search"
      : url.pathname.includes("/point_in_time")
        ? method === "DELETE"
          ? "pit.close"
          : "pit.open"
        : "index.state";
    try {
      const response = await fetch(...args);
      span("opensearch.headers", start, {
        operation: kind,
        status: response.status,
      });
      // Observe the body the application actually consumes, without cloning it.
      const json = response.json.bind(response);
      response.json = async () => {
        const bodyStart = clock();
        try {
          const body = await json();
          span("opensearch.body", bodyStart, {
            operation: kind,
            took_ms: Number.isFinite(body.took) ? body.took : null,
            hits: Array.isArray(body.hits?.hits) ? body.hits.hits.length : null,
          });
          return body;
        } catch (error) {
          span("opensearch.body.error", bodyStart, { operation: kind });
          throw error;
        }
      };
      return response;
    } catch (error) {
      span("opensearch.error", start, { operation: kind });
      throw error;
    }
  };
}
