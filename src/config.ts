export interface ObservabilityConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  logLevel?: string;
}

export function loadObservabilityConfig(
  overrides?: Partial<ObservabilityConfig>,
): ObservabilityConfig {
  return {
    serviceName: overrides?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "unknown",
    serviceVersion: overrides?.serviceVersion ?? process.env.SERVICE_VERSION ?? process.env.npm_package_version ?? "0.0.0",
    environment: overrides?.environment ?? process.env.NODE_ENV ?? process.env.DEPLOYMENT_ENVIRONMENT ?? "development",
    otlpEndpoint: overrides?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
    otlpHeaders: overrides?.otlpHeaders ?? undefined,
    logLevel: overrides?.logLevel ?? process.env.LOG_LEVEL ?? "info",
  };
}
