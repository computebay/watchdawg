import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import { httpRequestsDuration, httpRequestsTotal } from "./metrics.js";
import { childLogger } from "./logger.js";
import { randomUUID } from "node:crypto";

/**
 * Express middleware that:
 * 1. Injects/extracts request_id
 * 2. Propagates trace context via headers
 * 3. Records HTTP metrics
 * 4. Creates a child logger with trace context
 */
export function observabilityMiddleware(serviceName: string) {
  return (req: any, res: any, next: any) => {
    const startTime = Date.now();

    // Extract or create request_id
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);

    // Extract trace context from incoming headers
    const extractedContext = propagation.extract(context.active(), req.headers);

    // Run within extracted context
    context.with(extractedContext, () => {
      const span = trace.getSpan(context.active());
      const spanContext = span?.spanContext();

      // Attach trace IDs to response for debugging
      if (spanContext) {
        res.setHeader("x-trace-id", spanContext.traceId);
        res.setHeader("x-span-id", spanContext.spanId);
      }

      // Create child logger with request context
      const logger = childLogger({
        requestId,
        trace_id: spanContext?.traceId,
        span_id: spanContext?.spanId,
      });

      // Attach logger to request for downstream use
      req.log = logger;
      req.requestId = requestId;

      // Track response completion
      res.on("finish", () => {
        const duration = (Date.now() - startTime) / 1000;
        const route = req.route?.path ?? req.path ?? "unknown";

        httpRequestsDuration.observe(
          { method: req.method, route, status_code: String(res.statusCode), service: serviceName },
          duration,
        );

        httpRequestsTotal.inc({
          method: req.method,
          route,
          status_code: String(res.statusCode),
          service: serviceName,
        });

        logger.info(
          {
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration_ms: Date.now() - startTime,
          },
          "HTTP request completed",
        );
      });

      next();
    });
  };
}

/**
 * Express error handler that records exceptions with trace context.
 */
export function observabilityErrorHandler(_serviceName: string) {
  return (err: Error, req: any, res: any, _next: any) => {
    const logger = req.log ?? childLogger({});

    logger.error(
      {
        err,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
      },
      "Unhandled error",
    );

    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Internal server error",
      trace_id: trace.getSpan(context.active())?.spanContext()?.traceId,
    });
  };
}
