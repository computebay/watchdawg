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
  if (_baseLogger) {
    const currentName = _baseLogger.bindings()?.["service.name"];
    if (currentName !== "unknown") return _baseLogger;
  }

  const isDev = config.environment !== "production";
  const lokiUrl = config.lokiUrl;

  const pinoConfig: pino.LoggerOptions = {
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
  };

  if (lokiUrl) {
    const targets: pino.TransportTargetOptions[] = [
      {
        target: "pino-loki",
        options: {
          batchingInterval: 2,
          replaceTimestamp: true,
          lokiUrl,
          labels: {
            service_name: config.serviceName,
            environment: config.environment,
          },
        },
        level: config.logLevel ?? "info",
      },
    ];

    if (isDev) {
      targets.push({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
        level: config.logLevel ?? "info",
      });
    }

    pinoConfig.transport = { targets };
  } else if (isDev) {
    pinoConfig.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  }

  _baseLogger = pino(pinoConfig);

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
