import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import os from "node:os";
import type { ObservabilityConfig } from "./config.js";

let sdk: NodeSDK | null = null;

export function initTelemetry(config: ObservabilityConfig): void {
  if (sdk) return;

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
      "host.name": os.hostname(),
      "os.type": os.type(),
      "os.arch": os.arch(),
      "service.namespace": "computebay",
    }),
  );

  const endpoint = config.otlpEndpoint ?? "http://localhost:4318";

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers: config.otlpHeaders,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
    headers: config.otlpHeaders,
  });

  const logExporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
    headers: config.otlpHeaders,
  });

  // Get auto-instrumentations - these automatically instrument:
  // HTTP, Express, Fastify, Amqplib, PostgreSQL, Redis, Net, Fetch, etc.
  const instrumentations = getNodeAutoInstrumentations();

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15000,
    }),
    logRecordProcessor: new BatchLogRecordProcessor({ exporter: logExporter }),
    instrumentations,
  });

  sdk.start();

  process.on("SIGTERM", () => {
    sdk
      ?.shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
