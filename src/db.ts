import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { dbQueryDuration } from "./metrics.js";

/**
 * Wrap a database query in a span with metrics.
 */
export async function instrumentedQuery<T>(
  operation: string,
  table: string,
  service: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("computebay-db");
  const span = tracer.startSpan(`db.${operation} ${table}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "postgresql",
      "db.operation": operation,
      "db.sql.table": table,
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
    dbQueryDuration.observe({ operation, table, service }, duration);
    span.setAttribute("db.duration_ms", Date.now() - startTime);
    span.end();
  }
}
