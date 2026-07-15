# ComputeBay Observability

Production-grade distributed tracing, structured logging, and metrics for ComputeBay microservices.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ComputeBay Platform                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ API Gateway  │───▶│  Job Service  │───▶│  Scheduler   │      │
│  │  (Express)   │    │  (Fastify)    │    │  (Express)   │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                    │               │
│         │            ┌──────┴──────┐             │               │
│         │            │  PostgreSQL  │             │               │
│         │            │    Redis     │             │               │
│         │            └─────────────┘             │               │
│         │                                         │               │
│         │                   │ RabbitMQ             │               │
│         │            ┌──────┴──────┐             │               │
│         │            │  Worker     │◀────────────┘               │
│         │            │  Agent      │                              │
│         │            └──────┬──────┘                              │
│         │                   │                                     │
│         │            ┌──────┴──────┐                              │
│         │            │   Docker    │                              │
│         │            │  Containers │                              │
│         │            └─────────────┘                              │
│         │                                                         │
│  ┌──────┴──────────────────────────────────────────────────┐     │
│  │               OpenTelemetry Collector                    │     │
│  │               (localhost:4318 HTTP)                       │     │
│  │               (localhost:4317 gRPC)                       │     │
│  └──────┬──────────────────────────────────────────────────┘     │
│         │                                                         │
│  ┌──────┴──────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │   Grafana   │  │   Loki   │  │  Tempo   │  │ Prometheus │  │
│  └─────────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Traces Flow

A single `POST /jobs` request is traced across every service:

```
POST /api/v1/jobs
  │
  ▼
[Job Service] HTTP Request (Express/Fastify auto-instrumented)
  │  trace_id: abc123
  │  span_id: def456
  │
  ▼
[Job Service] DB: INSERT jobs
  │  trace_id: abc123 (continued)
  │
  ▼
[Job Service] DB: INSERT outbox_events
  │  trace_id: abc123 (continued)
  │
  ▼
[RabbitMQ] publish job.created → compute-bay.jobs exchange
  │  trace context injected into AMQP headers
  │  trace_id: abc123 (propagated)
  │
  ▼
[RabbitMQ] consume job.created ← scheduler.events queue
  │  trace context extracted from AMQP headers
  │  trace_id: abc123 (continued)
  │
  ▼
[Scheduler] scheduleJob()
  │  trace_id: abc123 (continued)
  │
  ▼
[Scheduler] DB: INSERT scheduling_audit
  │  trace_id: abc123 (continued)
  │
  ▼
[RabbitMQ] publish job.scheduled → queue.node.{nodeId}
  │  trace context injected
  │
  ▼
[RabbitMQ] consume job.scheduled ← worker queue
  │  trace context extracted
  │
  ▼
[Worker Agent] job received
  │  trace_id: abc123 (continued)
  │
  ▼
[Docker] createAndStart container
  │  trace_id: abc123 (continued)
  │
  ▼
[Docker] wait container
  │  trace_id: abc123 (continued)
  │
  ▼
[RabbitMQ] publish job.completed → node.events exchange
  │
  ▼
[Job Service] consume job.completed
  │  trace_id: abc123 (continued)
  │
  ▼
[Job Service] DB: UPDATE jobs SET status = 'COMPLETED'
```

All spans appear under **one trace** in Grafana Tempo.

## Log Correlation

Every log line automatically includes:

```json
{
  "level": "info",
  "time": "2025-01-15T10:30:00.000Z",
  "service.name": "job-service",
  "service.version": "1.0.0",
  "environment": "production",
  "trace_id": "abc123def456",
  "span_id": "def456789ghi0",
  "request_id": "req-uuid-123",
  "jobId": "job-uuid-456",
  "msg": "Job created"
}
```

### How Logs Correlate to Traces

- `trace_id` → Links to the distributed trace in Tempo
- `span_id` → Links to the specific span within the trace
- `request_id` → Links all logs for a single HTTP request
- `job_id` → Links all logs for a specific job across services

## How to Debug

### Find all traces for a job

In Grafana Tempo, use TraceQL:
```
{resource.service.name = "job-service"} && {span.job.id = "your-job-id"}
```

### Find all logs for a job

In Grafana Loki, use LogQL:
```
{service_name="job-service"} | json | job_id="your-job-id"
```

### Find all logs for a trace

In Grafana Loki:
```
{service_name=~".*"} | json | trace_id="your-trace-id"
```

### Find all logs for a request

```
{service_name=~".*"} | json | request_id="your-request-id"
```

### Find slow requests

In Grafana Tempo, use TraceQL:
```
{resource.service.name = "job-service"} | duration > 1s
```

### Find failed jobs

```
{service_name="job-service"} | json | status="FAILED"
```

## How to Add Instrumentation to Future Services

### 1. Add the dependency

```json
{
  "dependencies": {
    "@computebay/observability": "file:../packages/observability"
  }
}
```

### 2. Initialize telemetry (FIRST thing in your entrypoint)

```typescript
import { loadObservabilityConfig, initTelemetry, createLogger, createMetricsServer } from "@computebay/observability";

const config = loadObservabilityConfig({
  serviceName: "my-new-service",
  serviceVersion: "1.0.0",
});

initTelemetry(config);
const logger = createLogger(config);

// Start metrics server
createMetricsServer(config);

// ... rest of your bootstrap
```

### 3. Use structured logger

```typescript
import { getLogger } from "@computebay/observability";

const logger = getLogger();

// All logs automatically include trace_id, span_id, service.name
logger.info({ jobId: "123", userId: "456" }, "Processing job");
logger.error({ err, jobId: "123" }, "Job failed");
```

### 4. Instrument RabbitMQ

**Producer:**
```typescript
import { instrumentedPublish } from "@computebay/observability";

instrumentedPublish(channel, {
  exchange: "compute-bay.jobs",
  routingKey: "job.created",
  service: "my-service",
}, Buffer.from(JSON.stringify(payload)));
```

**Consumer:**
```typescript
import { instrumentedHandler } from "@computebay/observability";

const handler = instrumentedHandler(async (data, msg) => {
  // Your handler logic
}, { queue: "my-queue", service: "my-service" });

channel.consume("my-queue", async (msg) => {
  if (!msg) return;
  try {
    await handler(msg);
    channel.ack(msg);
  } catch (err) {
    channel.nack(msg, false, true);
  }
});
```

### 5. Instrument database queries

```typescript
import { instrumentedQuery } from "@computebay/observability";

const job = await instrumentedQuery("SELECT", "jobs", "my-service", () =>
  prisma.job.findUnique({ where: { id: jobId } })
);
```

### 6. Add HTTP middleware

**Express:**
```typescript
import { observabilityMiddleware } from "@computebay/observability";
app.use(observabilityMiddleware("my-service"));
```

**Fastify:**
```typescript
import { observabilityPlugin } from "@computebay/observability";
await app.register(observabilityPlugin, { serviceName: "my-service" });
```

### 7. Expose metrics endpoint

```typescript
import { getMetrics } from "@computebay/observability";

app.get("/metrics", async (_, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(await getMetrics());
});
```

## Configuration

All configuration comes from environment variables:

| Variable | Default | Description |
|---|---|---|
| `OTEL_SERVICE_NAME` | `unknown` | Service name in traces |
| `SERVICE_VERSION` | `0.0.0` | Service version |
| `NODE_ENV` | `development` | Environment name |
| `LOG_LEVEL` | `info` | Log level (trace, debug, info, warn, error, fatal) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTEL Collector endpoint |
| `METRICS_PORT` | `9090` | Port for metrics endpoint |

## Available Metrics

| Metric | Type | Description |
|---|---|---|
| `computebay_http_request_duration_seconds` | Histogram | HTTP request duration |
| `computebay_http_requests_total` | Counter | Total HTTP requests |
| `computebay_rabbitmq_publish_total` | Counter | Total RabbitMQ messages published |
| `computebay_rabbitmq_consume_total` | Counter | Total RabbitMQ messages consumed |
| `computebay_rabbitmq_consume_duration_seconds` | Histogram | Message processing duration |
| `computebay_scheduling_latency_seconds` | Histogram | Time to schedule a job |
| `computebay_job_queue_depth` | Gauge | Current queue depth |
| `computebay_worker_utilization_ratio` | Gauge | Worker CPU utilization |
| `computebay_container_startup_duration_seconds` | Histogram | Container startup time |
| `computebay_container_execution_duration_seconds` | Histogram | Total container execution time |
| `computebay_docker_pull_duration_seconds` | Histogram | Docker image pull time |
| `computebay_db_query_duration_seconds` | Histogram | Database query duration |
| `computebay_redis_operation_duration_seconds` | Histogram | Redis operation duration |
| `computebay_active_jobs` | Gauge | Currently running jobs |
| `process_*` | Various | Node.js process metrics (auto-collected) |

## Dashboard Access

- **Grafana**: `http://localhost:3000`
- **Prometheus**: `http://localhost:9090`
- **Tempo**: `http://localhost:3200`
- **Loki**: `http://localhost:3100`
- **OTEL Collector**: `http://localhost:4317` (gRPC), `http://localhost:4318` (HTTP)
