import { context, propagation, trace } from "@opentelemetry/api";
import { httpRequestsDuration, httpRequestsTotal } from "./metrics.js";
import { childLogger } from "./logger.js";
import { randomUUID } from "node:crypto";

/**
 * Fastify plugin that:
 * 1. Injects/extracts request_id
 * 2. Propagates trace context via headers
 * 3. Records HTTP metrics
 * 4. Creates a child logger with trace context
 */
export async function observabilityPlugin(
  app: any,
  opts: { serviceName: string },
): Promise<void> {
  const { serviceName } = opts;

  app.addHook("onRequest", async (request: any, reply: any) => {
    const startTime = Date.now();
    request._startTime = startTime;

    // Extract or create request_id
    const requestId = (request.headers["x-request-id"] as string) || randomUUID();
    request.headers["x-request-id"] = requestId;
    reply.header("x-request-id", requestId);

    // Extract trace context from incoming headers
    const extractedContext = propagation.extract(context.active(), request.headers);

    // Run within extracted context
    context.with(extractedContext, () => {
      const span = trace.getSpan(context.active());
      const spanContext = span?.spanContext();

      if (spanContext) {
        reply.header("x-trace-id", spanContext.traceId);
        reply.header("x-span-id", spanContext.spanId);
      }

      const logger = childLogger({
        requestId,
        trace_id: spanContext?.traceId,
        span_id: spanContext?.spanId,
      });

      request.log = logger;
      request.requestId = requestId;
    });
  });

  app.addHook("onResponse", async (request: any, reply: any) => {
    const startTime = request._startTime ?? Date.now();
    const duration = (Date.now() - startTime) / 1000;
    const route = request.routeOptions?.routePath ?? request.url ?? "unknown";

    httpRequestsDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode), service: serviceName },
      duration,
    );

    httpRequestsTotal.inc({
      method: request.method,
      route,
      status_code: String(reply.statusCode),
      service: serviceName,
    });

    const logger = request.log;
    if (logger) {
      logger.info(
        {
          method: request.method,
          url: request.url,
          status: reply.statusCode,
          duration_ms: Date.now() - startTime,
        },
        "HTTP request completed",
      );
    }
  });

  app.setErrorHandler((error: any, request: any, reply: any) => {
    const logger = request.log;
    if (logger) {
      logger.error({ err: error, method: request.method, url: request.url }, "Unhandled error");
    }

    reply.status(500).send({
      error: "INTERNAL_ERROR",
      message: "Internal server error",
      trace_id: trace.getSpan(context.active())?.spanContext()?.traceId,
    });
  });
}
