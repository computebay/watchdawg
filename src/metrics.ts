import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from "prom-client";
import type { ObservabilityConfig } from "./config.js";

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "computebay_" });

export const httpRequestsDuration = new Histogram({
  name: "computebay_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code", "service"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "computebay_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code", "service"],
  registers: [registry],
});

export const rabbitmqPublishTotal = new Counter({
  name: "computebay_rabbitmq_publish_total",
  help: "Total number of RabbitMQ messages published",
  labelNames: ["exchange", "routing_key", "service"],
  registers: [registry],
});

export const rabbitmqConsumeTotal = new Counter({
  name: "computebay_rabbitmq_consume_total",
  help: "Total number of RabbitMQ messages consumed",
  labelNames: ["queue", "routing_key", "service"],
  registers: [registry],
});

export const rabbitmqConsumeDuration = new Histogram({
  name: "computebay_rabbitmq_consume_duration_seconds",
  help: "Duration of RabbitMQ message processing in seconds",
  labelNames: ["queue", "service"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120],
  registers: [registry],
});

export const schedulingLatency = new Histogram({
  name: "computebay_scheduling_latency_seconds",
  help: "Time from job.created to job scheduled on a node",
  labelNames: ["service"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

export const jobQueueDepth = new Gauge({
  name: "computebay_job_queue_depth",
  help: "Current depth of job queues",
  labelNames: ["queue", "service"],
  registers: [registry],
});

export const workerUtilization = new Gauge({
  name: "computebay_worker_utilization_ratio",
  help: "Worker CPU utilization ratio (0-1)",
  labelNames: ["node_id", "service"],
  registers: [registry],
});

export const containerStartupDuration = new Histogram({
  name: "computebay_container_startup_duration_seconds",
  help: "Time to create and start a Docker container",
  labelNames: ["image", "service"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const containerExecutionDuration = new Histogram({
  name: "computebay_container_execution_duration_seconds",
  help: "Total container execution time from start to exit",
  labelNames: ["image", "job_type", "service"],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

export const dockerPullDuration = new Histogram({
  name: "computebay_docker_pull_duration_seconds",
  help: "Duration of Docker image pull operations",
  labelNames: ["image", "service"],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const dbQueryDuration = new Histogram({
  name: "computebay_db_query_duration_seconds",
  help: "Duration of database queries",
  labelNames: ["operation", "table", "service"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const redisOperationDuration = new Histogram({
  name: "computebay_redis_operation_duration_seconds",
  help: "Duration of Redis operations",
  labelNames: ["operation", "service"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

export const activeJobs = new Gauge({
  name: "computebay_active_jobs",
  help: "Number of currently active (running) jobs",
  labelNames: ["service"],
  registers: [registry],
});

export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

export function createMetricsServer(config: ObservabilityConfig) {
  const http = require("node:http");
  const metricsPort = parseInt(process.env.METRICS_PORT ?? "9090", 10);

  const server = http.createServer(async (req: any, res: any) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await getMetrics());
    } else if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: config.serviceName }));
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  server.listen(metricsPort, () => {
    console.log(`[${config.serviceName}] Metrics server on :${metricsPort}`);
  });

  return server;
}
