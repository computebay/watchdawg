import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Channel } from "amqplib";
import { rabbitmqPublishTotal, rabbitmqConsumeTotal, rabbitmqConsumeDuration } from "./metrics.js";
import { getLogger } from "./logger.js";

const TRACER_NAME = "computebay-rabbitmq";

interface PublishOptions {
  exchange: string;
  routingKey: string;
  service: string;
  contentType?: string;
  persistent?: boolean;
}

interface ConsumeContext {
  queue: string;
  service: string;
}

/**
 * Inject trace context into AMQP message properties and publish.
 * This is the instrumented publish wrapper.
 */
export function instrumentedPublish(
  channel: Channel,
  options: PublishOptions,
  payload: Buffer | object,
): boolean {
  const tracer = trace.getTracer(TRACER_NAME);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), "utf-8");

  const span = tracer.startSpan(
    `rabbitmq.publish ${options.exchange}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "rabbitmq",
        "messaging.destination.name": options.exchange,
        "messaging.rabbitmq.routing_key": options.routingKey,
        "messaging.operation": "publish",
        "messaging.destination.kind": "exchange",
        "service.name": options.service,
      },
    },
  );

  const messageProperties: Record<string, unknown> = {
    contentType: options.contentType ?? "application/json",
    persistent: options.persistent ?? true,
  };

  // Inject W3C Trace Context into message headers
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  if (Object.keys(headers).length > 0) {
    messageProperties.headers = Buffer.from(
      JSON.stringify(headers),
      "utf-8",
    );
  }

  const startTime = Date.now();

  try {
    const ok = channel.publish(
      options.exchange,
      options.routingKey,
      body,
      messageProperties as any,
    );

    rabbitmqPublishTotal.inc({
      exchange: options.exchange,
      routing_key: options.routingKey,
      service: options.service,
    });

    if (!ok) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Channel buffer full" });
      getLogger().warn({ exchange: options.exchange, routingKey: options.routingKey }, "Channel buffer full, message not published");
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
    return ok;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : "Unknown error",
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.end();
    throw err;
  }
}

/**
 * Instrumented sendToQueue wrapper with trace context propagation.
 */
export function instrumentedSendToQueue(
  channel: Channel,
  queue: string,
  payload: Buffer | object,
  service: string,
  options?: { persistent?: boolean; contentType?: string },
): boolean {
  const tracer = trace.getTracer(TRACER_NAME);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), "utf-8");

  const span = tracer.startSpan(
    `rabbitmq.sendToQueue ${queue}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "rabbitmq",
        "messaging.destination.name": queue,
        "messaging.operation": "publish",
        "messaging.destination.kind": "queue",
        "service.name": service,
      },
    },
  );

  const messageProperties: Record<string, unknown> = {
    contentType: options?.contentType ?? "application/json",
    persistent: options?.persistent ?? true,
  };

  // Inject W3C Trace Context
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  if (Object.keys(headers).length > 0) {
    messageProperties.headers = Buffer.from(JSON.stringify(headers), "utf-8");
  }

  try {
    const ok = channel.sendToQueue(queue, body, messageProperties as any);

    rabbitmqPublishTotal.inc({
      exchange: "(direct)",
      routing_key: queue,
      service,
    });

    span.setStatus({ code: ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
    return ok;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : "Unknown" });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.end();
    throw err;
  }
}

/**
 * Wrap a message handler to extract trace context and continue the distributed trace.
 * Returns a new handler function that extracts context from message properties
 * and runs the original handler within that context.
 */
export function instrumentedHandler(
  originalHandler: (payload: Record<string, unknown>, msg: any) => Promise<void>,
  ctx: ConsumeContext,
): (msg: any) => Promise<void> {
  return async (msg: any) => {
    if (!msg) return;

    const startTime = Date.now();
    const tracer = trace.getTracer(TRACER_NAME);

    // Extract trace context from message properties
    let extractedContext = context.active();
    try {
      const props = msg.properties;
      if (props?.headers) {
        let headerObj: Record<string, string> = {};

        // amqplib may give us Buffer or already-parsed object
        if (Buffer.isBuffer(props.headers)) {
          headerObj = JSON.parse(props.headers.toString("utf-8"));
        } else if (typeof props.headers === "object") {
          // OpenTelemetry propagation expects string values
          for (const [key, value] of Object.entries(props.headers)) {
            headerObj[key] = Buffer.isBuffer(value)
              ? value.toString("utf-8")
              : String(value);
          }
        }

        if (Object.keys(headerObj).length > 0) {
          extractedContext = propagation.extract(context.active(), headerObj);
        }
      }
    } catch {
      // If extraction fails, continue without parent context
    }

    const routingKey = msg.fields?.routingKey ?? "(unknown)";

    const span = tracer.startSpan(
      `rabbitmq.consume ${ctx.queue}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "rabbitmq",
          "messaging.destination.name": ctx.queue,
          "messaging.rabbitmq.routing_key": routingKey,
          "messaging.operation": "receive",
          "service.name": ctx.service,
        },
      },
      extractedContext,
    );

    rabbitmqConsumeTotal.inc({
      queue: ctx.queue,
      routing_key: routingKey,
      service: ctx.service,
    });

    try {
      // Parse payload
      const payload = JSON.parse(msg.content.toString("utf-8")) as Record<string, unknown>;

      // Run handler within the extracted context
      await context.with(extractedContext, async () => {
        await originalHandler(payload, msg);
      });

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : "Unknown error",
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      rabbitmqConsumeDuration.observe({ queue: ctx.queue, service: ctx.service }, duration);
      span.end();
    }
  };
}
