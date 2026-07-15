import { trace, context, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { redisOperationDuration } from "./metrics.js";

const TRACER_NAME = "computebay-redis";

/**
 * Wrap a Redis operation in a span with metrics.
 */
export async function instrumentedRedisOp<T>(
  operation: string,
  service: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(`redis.${operation}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "redis",
      "db.operation": operation,
      "service.name": service,
    },
  });

  const startTime = Date.now();

  try {
    const result = await fn();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : "Unknown error",
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    const duration = (Date.now() - startTime) / 1000;
    redisOperationDuration.observe({ operation, service }, duration);
    span.setAttribute("db.duration_ms", Date.now() - startTime);
    span.end();
  }
}
