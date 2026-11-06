import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { downloadObject } from "./archive-download";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Req,
  Res,
  HttpCode,
  Inject,
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { api, openapi, type Operation } from "@palimora/contracts";
import { Identity } from "./identity";
import { pool, migrate } from "./db";
import { config, validateConfig, fail } from "./security";
@Controller("/api/v1")
class ApiController {
  constructor(@Inject(Identity) readonly identity: Identity) {}
}
for (const op of Object.keys(api) as Operation[]) {
  const e = api[op];
  Object.defineProperty(ApiController.prototype, op, {
    value: async function (this: ApiController, req: Request, res: Response) {
      const parsed = e.input.safeParse({
        ...req.query,
        ...req.body,
        ...req.params,
      });
      if (!parsed.success) fail("INVALID_INPUT", 400);
      const result = await this.identity.execute(op, parsed.data, {
        request: req,
        response: res,
        requestId: res.locals.requestId,
      });
      if (op === "archiveDownload") {
        const { hash } = result as { hash: string };
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="' + hash + '"',
        );
        await pipeline(Readable.from(downloadObject(hash)), res);
        return;
      }
      return e.output.parse(result);
    },
    configurable: true,
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    ApiController.prototype,
    op,
  )!;
  ({ get: Get, post: Post, patch: Patch, delete: Delete })[e.method](e.path)(
    ApiController.prototype,
    op,
    descriptor,
  );
  Req()(ApiController.prototype, op, 0);
  Res({ passthrough: true })(ApiController.prototype, op, 1);
  HttpCode(200)(ApiController.prototype, op, descriptor);
}
@Catch()
class Errors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    let status = 500,
      code = "INTERNAL";
    if (error instanceof HttpException) {
      status = error.getStatus();
      const payload = error.getResponse() as any;
      code = payload.code ?? (status === 404 ? "NOT_FOUND" : "INVALID_INPUT");
    } else if (
      error?.type === "entity.parse.failed" ||
      error?.type === "entity.too.large"
    ) {
      status = error.type === "entity.too.large" ? 413 : 400;
      code = "INVALID_INPUT";
    } else if (error?.code === "23505") {
      status = 409;
      code = "CONFLICT";
    }
    if (status === 500)
      console.error(
        JSON.stringify({
          event: "request_error",
          requestId: res.locals.requestId,
          type: error?.constructor?.name,
        }),
      );
    res.status(status).json({ code, requestId: res.locals.requestId });
  }
}
@Module({ controllers: [ApiController], providers: [Identity] })
class AppModule {}
export async function start() {
  validateConfig();
  await migrate();
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  const express = require("express");
  const server = app.getHttpAdapter().getInstance();
  server.disable("x-powered-by");
  server.set("trust proxy", 1);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-ID", res.locals.requestId);
    res.setHeader("Cache-Control", "no-store");
    const started = performance.now();
    res.on("finish", () =>
      console.log(
        JSON.stringify({
          event: "http",
          requestId: res.locals.requestId,
          method: req.method,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        }),
      ),
    );
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "32kb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config().origin
    )
      return next(new HttpException({ code: "CSRF" }, 403));
    next();
  });
  app.useGlobalFilters(new Errors());
  server.get("/api/v1/health", async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  server.get("/api/v1/openapi.json", (_req: Request, res: Response) =>
    res.json(openapi()),
  );
  await app.get(Identity).initialize();
  app.enableShutdownHooks();
  const cleanup = setInterval(() => {
    void pool
      .query(
        "DELETE FROM challenges WHERE expires_at<now(); DELETE FROM rate_limits WHERE until_at<now()-interval '1 day'",
      )
      .catch(() => {});
  }, 60000);
  cleanup.unref();
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
  const close = async () => {
    clearInterval(cleanup);
    await app.close();
    await pool.end();
  };
  return { app, close };
}
if (require.main === module)
  start().catch(() => {
    console.error(
      "API startup failed: verify database, migrations and configuration",
    );
    process.exit(1);
  });
