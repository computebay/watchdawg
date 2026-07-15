// @computebay/observability
// Centralized observability for ComputeBay microservices

export { loadObservabilityConfig, type ObservabilityConfig } from "./config.js";
export { initTelemetry } from "./telemetry.js";
export { createLogger, getLogger, childLogger, logError, createSpanLogger, type LoggerContext } from "./logger.js";
export {
  registry,
  httpRequestsDuration,
  httpRequestsTotal,
  rabbitmqPublishTotal,
  rabbitmqConsumeTotal,
  rabbitmqConsumeDuration,
  schedulingLatency,
  jobQueueDepth,
  workerUtilization,
  containerStartupDuration,
  containerExecutionDuration,
  dockerPullDuration,
  dbQueryDuration,
  redisOperationDuration,
  activeJobs,
  getMetrics,
  createMetricsServer,
} from "./metrics.js";
export {
  instrumentedPublish,
  instrumentedSendToQueue,
  instrumentedHandler,
} from "./rabbitmq.js";
export {
  withDockerSpan,
  instrumentedDockerPull,
  instrumentedContainerCreate,
  instrumentedContainerWait,
  instrumentedContainerStop,
  instrumentedContainerRemove,
  instrumentedContainerLogs,
} from "./docker.js";
export { observabilityMiddleware, observabilityErrorHandler } from "./express-middleware.js";
export { observabilityPlugin } from "./fastify-plugin.js";
export { instrumentedQuery } from "./db.js";
export { instrumentedRedisOp } from "./redis.js";
