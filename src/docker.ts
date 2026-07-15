import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import {
  containerStartupDuration,
  containerExecutionDuration,
  dockerPullDuration,
} from "./metrics.js";

export interface DockerSpanAttributes {
  jobId?: string;
  workerId?: string;
  nodeId?: string;
  image?: string;
  containerId?: string;
  exitCode?: number;
}

export async function withDockerSpan<T>(
  spanName: string,
  attributes: DockerSpanAttributes,
  fn: (span: any) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("computebay-docker");
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.INTERNAL,
    attributes: {
      "container.image": attributes.image ?? "unknown",
      "container.id": attributes.containerId ?? "unknown",
      "job.id": attributes.jobId ?? "unknown",
      "worker.id": attributes.workerId ?? "unknown",
      "node.id": attributes.nodeId ?? "unknown",
    },
  });

  try {
    const result = await fn(span);
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
    span.end();
  }
}

export async function instrumentedDockerPull(
  image: string,
  jobId: string,
  pullFn: () => Promise<void>,
): Promise<void> {
  return withDockerSpan("docker.pull", { image, jobId }, async (span) => {
    const startTime = Date.now();
    try {
      await pullFn();
      span.setStatus({ code: SpanStatusCode.OK });
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      dockerPullDuration.observe({ image, service: "worker-agent" }, duration);
      span.setAttribute("docker.pull.duration_ms", Date.now() - startTime);
      span.end();
    }
  });
}

export async function instrumentedContainerCreate(
  createFn: () => Promise<void>,
  attrs: DockerSpanAttributes & { cpu?: number; memoryMb?: number },
): Promise<void> {
  return withDockerSpan("docker.createAndStart", attrs, async (span) => {
    const startTime = Date.now();
    try {
      await createFn();
      span.setAttribute("container.cpu", attrs.cpu ?? 0);
      span.setAttribute("container.memory_mb", attrs.memoryMb ?? 0);
      span.setStatus({ code: SpanStatusCode.OK });
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      containerStartupDuration.observe(
        { image: attrs.image ?? "unknown", service: "worker-agent" },
        duration,
      );
      span.setAttribute("docker.create.duration_ms", Date.now() - startTime);
      span.end();
    }
  });
}

export async function instrumentedContainerWait(
  waitFn: () => Promise<{ exitCode: number; killed: boolean }>,
  attrs: DockerSpanAttributes,
): Promise<{ exitCode: number; killed: boolean }> {
  return withDockerSpan("docker.wait", attrs, async (span) => {
    const startTime = Date.now();
    try {
      const result = await waitFn();
      span.setAttribute("container.exit_code", result.exitCode);
      span.setAttribute("container.killed", result.killed);
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
      containerExecutionDuration.observe(
        {
          image: attrs.image ?? "unknown",
          job_type: attrs.jobId ? "batch" : "unknown",
          service: "worker-agent",
        },
        duration,
      );
      span.setAttribute("docker.wait.duration_ms", Date.now() - startTime);
      span.end();
    }
  });
}

export async function instrumentedContainerStop(
  stopFn: () => Promise<void>,
  attrs: DockerSpanAttributes,
): Promise<void> {
  return withDockerSpan("docker.stop", attrs, async (span) => {
    await stopFn();
    span.setStatus({ code: SpanStatusCode.OK });
  });
}

export async function instrumentedContainerRemove(
  removeFn: () => Promise<void>,
  attrs: DockerSpanAttributes,
): Promise<void> {
  return withDockerSpan("docker.remove", attrs, async (span) => {
    await removeFn();
    span.setStatus({ code: SpanStatusCode.OK });
  });
}

export async function instrumentedContainerLogs(
  logsFn: () => Promise<string>,
  attrs: DockerSpanAttributes,
): Promise<string> {
  return withDockerSpan("docker.logs", attrs, async (span) => {
    const logs = await logsFn();
    span.setAttribute("docker.logs.length", logs.length);
    span.setStatus({ code: SpanStatusCode.OK });
    return logs;
  });
}
