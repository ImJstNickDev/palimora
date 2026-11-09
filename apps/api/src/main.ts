import { recordRequest, startOperations } from "./operations-metrics";
import { startProjections } from "./operations-index";
import { projectionMode } from "./projection-mode";
import { backupDownload } from "./backup-download";
import { startPersonalWorker, stopPersonalWorker } from "./personal-worker";
import { closePdf } from "./reader-pdf";
import { posix } from "node:path";
import { byteRange, streamMedia } from "./reader-media";
import { projectCatalog, projectText } from "./catalog";
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
      res.locals.operation = op;
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
      if (op === "readerMedia") {
        const descriptor = result as any;
        if (descriptor.svg)
          descriptor.size = Buffer.from(descriptor.svg, "base64").length;
        const range = byteRange(req.headers.range, descriptor.size);
        res.setHeader("Accept-Ranges", "bytes");
        if (!range) {
          res
            .status(416)
            .setHeader("Content-Range", `bytes */${descriptor.size}`);
          res.end();
          return;
        }
        res.setHeader("Content-Type", descriptor.mime);
        res.setHeader("Content-Length", range.end - range.start + 1);
        if (
          (parsed.data as any).download === "true" ||
          ["application/octet-stream", "application/pdf"].includes(
            descriptor.mime,
          )
        )
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="asset"; filename*=UTF-8''${encodeURIComponent(posix.basename(descriptor.name)).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
          );
        if (range.partial) {
          res.status(206);
          res.setHeader(
            "Content-Range",
            `bytes ${range.start}-${range.end}/${descriptor.size}`,
          );
        }
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        await pipeline(
          Readable.from(streamMedia(descriptor, range.start, range.end)),
          res,
        );
        return;
      }
      if (op === "readerDownload") {
        const media = result as { mime: string; stream: Readable };
        res.setHeader("Content-Type", media.mime);
        if (op === "readerDownload")
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="palimora.${(parsed.data as any).format}"`,
          );
        await pipeline(media.stream, res);
        return;
      }
      if (op === "backupFile") {
        const input = parsed.data as { id: string; file: string };
        const file = await backupDownload(input.id, input.file);
        try {
          const range = byteRange(req.headers.range, file.size);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Accept-Ranges", "bytes");
          if (!range) {
            res.status(416).setHeader("Content-Range", `bytes */${file.size}`);
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${input.file}"`,
          );
          res.setHeader("Content-Length", range.end - range.start + 1);
          if (range.partial) {
            res
              .status(206)
              .setHeader(
                "Content-Range",
                `bytes ${range.start}-${range.end}/${file.size}`,
              );
          }
          if (req.method === "HEAD") res.end();
          else await pipeline(file.stream(range.start, range.end), res);
        } finally {
          await file.close();
        }
        return;
      }
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
const projectionLifecycle = { beforeApplicationShutdown: async () => {} };
@Module({
  controllers: [ApiController],
  providers: [
    Identity,
    { provide: "PROJECTION_LIFECYCLE", useValue: projectionLifecycle },
    {
      provide: "PERSONAL_LIFECYCLE",
      useValue: { onApplicationShutdown: stopPersonalWorker },
    },
    { provide: "PDF_LIFECYCLE", useValue: { onApplicationShutdown: closePdf } },
  ],
})
class AppModule {}
export async function start() {
  const projections = projectionMode();
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
    res.on("finish", () => {
      if (
        res.locals.operation &&
        !res.locals.operation.startsWith("operations")
      )
        recordRequest(
          performance.now() - started,
          res.statusCode,
          res.locals.operation === "catalogWorks",
        );
    });
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
  app.use("/api/v1/admin/ao3/uploads", express.json({ limit: "1mb" }));
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
  startPersonalWorker();
  const stopOperations = startOperations();
  app.enableShutdownHooks();
  const stopProjections =
    projections === "inline"
      ? startProjections(projectCatalog, projectText)
      : async () => {};
  projectionLifecycle.beforeApplicationShutdown = stopProjections;
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
    await stopProjections();
    await stopOperations();
    await stopPersonalWorker();
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
