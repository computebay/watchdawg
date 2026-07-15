import pino from "pino";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import type { ObservabilityConfig } from "./config.js";

export interface LoggerContext {
  requestId?: string;
  trace_id?: string;
  span_id?: string;
  jobId?: string;
  workerId?: string;
  nodeId?: string;
  queueName?: string;
  [key: string]: unknown;
}

let _baseLogger: pino.Logger;

export function createLogger(
  config: ObservabilityConfig,
  extraBaseFields?: Record<string, unknown>,
): pino.Logger {
  if (_baseLogger) return _baseLogger;

  const isDev = config.environment !== "production";

  _baseLogger = pino({
    level: config.logLevel ?? "info",
    base: {
      "service.name": config.serviceName,
      "service.version": config.serviceVersion,
      environment: config.environment,
      ...extraBaseFields,
    },
    mixin() {
      const span = trace.getSpan(context.active());
      if (span) {
        const spanContext = span.spanContext();
        return {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
          trace_flags: spanContext.traceFlags,
        };
      }
      return {};
    },
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    ...(isDev && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    }),
  });

  return _baseLogger;
}

export function getLogger(): pino.Logger {
  if (!_baseLogger) {
    // Auto-initialize with defaults if not yet initialized
    _baseLogger = createLogger({
      serviceName: process.env.OTEL_SERVICE_NAME ?? "unknown",
      serviceVersion: process.env.SERVICE_VERSION ?? "0.0.0",
      environment: process.env.NODE_ENV ?? "development",
      logLevel: process.env.LOG_LEVEL ?? "info",
    });
  }
  return _baseLogger;
}

export function childLogger(context: LoggerContext): pino.Logger {
  return getLogger().child(context);
}

export function logError(
  logger: pino.Logger,
  error: Error | unknown,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error({ err, ...extra }, message);
}

export function createSpanLogger(
  spanName: string,
  attributes?: Record<string, string | number | boolean>,
): { logger: pino.Logger; end: (error?: Error) => void } {
  const tracer = trace.getTracer("computebay");
  const span = tracer.startSpan(spanName, { attributes });

  const spanLogger = getLogger().child({
    span_id: span.spanContext().spanId,
    trace_id: span.spanContext().traceId,
  });

  return {
    logger: spanLogger,
    end: (error?: Error) => {
      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    },
  };
}
