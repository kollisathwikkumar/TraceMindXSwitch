import { createHash } from 'node:crypto';
import { z } from 'zod';

export const RUNTIME_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const RUNTIME_MAX_SIGNALS_PER_BATCH = 1_000;
export const RUNTIME_MAX_STORED_SIGNALS = 1_000;
export const RUNTIME_MAX_SIGNAL_TEXT = 2_048;
export const RUNTIME_MAX_ATTRIBUTES = 64;

export type RuntimeSignalKind = 'span' | 'log' | 'metric';
export type RuntimeSignalSource = 'otlp' | 'jaeger';
export type RuntimeAttribute = string | number | boolean;

const scalarSchema = z.union([z.string().max(512), z.number().finite(), z.boolean()]);
const attributesSchema = z.record(z.string().min(1).max(128), scalarSchema).superRefine((value, ctx) => {
  if (Object.keys(value).length > RUNTIME_MAX_ATTRIBUTES) {
    ctx.addIssue({ code: 'custom', message: 'Too many attributes' });
  }
});

export const runtimeSignalSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['span', 'log', 'metric']),
    source: z.enum(['otlp', 'jaeger']),
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    serviceName: z.string().max(256),
    name: z.string().min(1).max(512),
    traceId: z.string().regex(/^[a-f0-9]{16,32}$/).optional(),
    spanId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
    severity: z.string().max(64).optional(),
    status: z.enum(['unset', 'ok', 'error']).optional(),
    value: z.number().finite().optional(),
    unit: z.string().max(128).optional(),
    message: z.string().max(RUNTIME_MAX_SIGNAL_TEXT).optional(),
    attributes: attributesSchema,
  })
  .strict();

export type RuntimeSignal = z.infer<typeof runtimeSignalSchema>;

export type RuntimeIncident = {
  id: string;
  severity: 'error' | 'warning';
  serviceName: string;
  title: string;
  firstSeenAt: number;
  lastSeenAt: number;
  signalCount: number;
  signalIds: string[];
  correlation: 'trace_id' | 'service_time_window' | 'metric_deviation';
  explanation: string;
};

export type RuntimeSnapshot = {
  locationId: string;
  auditId: string;
  auditRevision: string | null;
  signals: RuntimeSignal[];
  incidents: RuntimeIncident[];
  acceptedCount: number;
  droppedCount: number;
  lastReceivedAt: number | null;
  truncated: boolean;
};

export type ParsedRuntimeBatch = {
  signals: RuntimeSignal[];
  rejectedCount: number;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function redact(value: string): string {
  return value
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, RUNTIME_MAX_SIGNAL_TEXT);
}

function safeKey(key: string): string {
  return /authorization|api[_-]?key|token|password|secret|cookie|credential/i.test(key)
    ? '[redacted-key]'
    : key.slice(0, 128);
}

function attributeValue(value: unknown): RuntimeAttribute | undefined {
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  const item = record(value);
  if (!item) return undefined;
  if (typeof item.stringValue === 'string') return redact(item.stringValue);
  if (typeof item.boolValue === 'boolean') return item.boolValue;
  for (const key of ['intValue', 'doubleValue', 'floatValue']) {
    const numeric = typeof item[key] === 'number' ? item[key] : Number(item[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (item.arrayValue) return '[array]';
  if (item.kvlistValue) return '[object]';
  if (item.bytesValue) return '[bytes]';
  return undefined;
}

function attributes(value: unknown): Record<string, RuntimeAttribute> {
  const result: Record<string, RuntimeAttribute> = {};
  for (const raw of list(value).slice(0, RUNTIME_MAX_ATTRIBUTES)) {
    const item = record(raw);
    if (!item || typeof item.key !== 'string') continue;
    const converted = attributeValue(item.value);
    if (converted === undefined) continue;
    const key = safeKey(item.key);
    result[key] = /\[redacted-key\]/.test(key) ? '[REDACTED]' : converted;
  }
  return result;
}

function timeToMillis(value: unknown, multiplier: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return Date.now();
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed / multiplier));
}

function hashSignal(signal: Omit<RuntimeSignal, 'id'>): string {
  return createHash('sha256').update(JSON.stringify(signal)).digest('hex');
}

function makeSignal(input: Omit<RuntimeSignal, 'id'>): RuntimeSignal {
  return runtimeSignalSchema.parse({ ...input, id: hashSignal(input) });
}

function resourceAttributes(resource: unknown): Record<string, RuntimeAttribute> {
  const resourceRecord = record(resource);
  return attributes(resourceRecord?.attributes);
}

function serviceName(resource: unknown): string {
  const attrs = resourceAttributes(resource);
  const value = attrs['service.name'];
  return typeof value === 'string' ? value.slice(0, 256) : 'unknown-service';
}

function combineAttributes(...sources: Record<string, RuntimeAttribute>[]): Record<string, RuntimeAttribute> {
  const result: Record<string, RuntimeAttribute> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (Object.keys(result).length >= RUNTIME_MAX_ATTRIBUTES) return result;
      result[key] = value;
    }
  }
  return result;
}

function statusValue(value: unknown): 'unset' | 'ok' | 'error' {
  const code = record(value)?.code;
  if (code === 2 || code === '2' || code === 'STATUS_CODE_ERROR') return 'error';
  if (code === 1 || code === '1' || code === 'STATUS_CODE_OK') return 'ok';
  return 'unset';
}

function otlpSpans(payload: UnknownRecord): RuntimeSignal[] {
  const result: RuntimeSignal[] = [];
  for (const resourceSpan of list(payload.resourceSpans)) {
    const resource = record(resourceSpan);
    if (!resource) continue;
    const svc = serviceName(resource.resource);
    const resourceAttrs = resourceAttributes(resource.resource);
    for (const scope of list(resource.scopeSpans)) {
      const scopeRecord = record(scope);
      for (const rawSpan of list(scopeRecord?.spans)) {
        const span = record(rawSpan);
        if (!span || typeof span.name !== 'string') continue;
        const traceId = typeof span.traceId === 'string' ? span.traceId.toLowerCase() : undefined;
        const spanId = typeof span.spanId === 'string' ? span.spanId.toLowerCase() : undefined;
        result.push(
          makeSignal({
            kind: 'span',
            source: 'otlp',
            observedAt: timeToMillis(span.startTimeUnixNano ?? span.endTimeUnixNano, 1_000_000),
            serviceName: svc,
            name: redact(span.name).slice(0, 512),
            ...(traceId && /^[a-f0-9]{32}$/.test(traceId) ? { traceId } : {}),
            ...(spanId && /^[a-f0-9]{16}$/.test(spanId) ? { spanId } : {}),
            status: statusValue(span.status),
            attributes: combineAttributes(resourceAttrs, attributes(span.attributes)),
          })
        );
      }
    }
  }
  return result;
}

function otlpLogs(payload: UnknownRecord): RuntimeSignal[] {
  const result: RuntimeSignal[] = [];
  for (const resourceLog of list(payload.resourceLogs)) {
    const resource = record(resourceLog);
    if (!resource) continue;
    const svc = serviceName(resource.resource);
    const resourceAttrs = resourceAttributes(resource.resource);
    for (const scope of list(resource.scopeLogs)) {
      const scopeRecord = record(scope);
      for (const rawLog of list(scopeRecord?.logRecords)) {
        const logRecord = record(rawLog);
        if (!logRecord) continue;
        const traceId = typeof logRecord.traceId === 'string' ? logRecord.traceId.toLowerCase() : undefined;
        const spanId = typeof logRecord.spanId === 'string' ? logRecord.spanId.toLowerCase() : undefined;
        const body = attributeValue(logRecord.body);
        const severity = typeof logRecord.severityText === 'string' ? redact(logRecord.severityText).slice(0, 64) : undefined;
        result.push(
          makeSignal({
            kind: 'log',
            source: 'otlp',
            observedAt: timeToMillis(logRecord.timeUnixNano ?? logRecord.observedTimeUnixNano, 1_000_000),
            serviceName: svc,
            name: severity ? `log:${severity}` : 'log',
            ...(traceId && /^[a-f0-9]{32}$/.test(traceId) ? { traceId } : {}),
            ...(spanId && /^[a-f0-9]{16}$/.test(spanId) ? { spanId } : {}),
            ...(severity ? { severity } : {}),
            ...(typeof body === 'string' ? { message: redact(body) } : {}),
            attributes: combineAttributes(resourceAttrs, attributes(logRecord.attributes)),
          })
        );
      }
    }
  }
  return result;
}

function otlpMetrics(payload: UnknownRecord): RuntimeSignal[] {
  const result: RuntimeSignal[] = [];
  for (const resourceMetrics of list(payload.resourceMetrics)) {
    const resource = record(resourceMetrics);
    if (!resource) continue;
    const svc = serviceName(resource.resource);
    const resourceAttrs = resourceAttributes(resource.resource);
    for (const scope of list(resource.scopeMetrics)) {
      const scopeRecord = record(scope);
      for (const rawMetric of list(scopeRecord?.metrics)) {
        const metric = record(rawMetric);
        if (!metric || typeof metric.name !== 'string') continue;
        const unit = typeof metric.unit === 'string' ? redact(metric.unit).slice(0, 128) : undefined;
        const aggregate = record(metric.gauge) ?? record(metric.sum) ?? record(metric.histogram) ?? record(metric.summary) ?? record(metric.exponentialHistogram);
        const dataPoints = list(aggregate?.dataPoints);
        for (const rawPoint of dataPoints) {
          const point = record(rawPoint);
          if (!point) continue;
          const numeric = Number(point.asDouble ?? point.asInt ?? point.count ?? point.sum);
          result.push(
            makeSignal({
              kind: 'metric',
              source: 'otlp',
              observedAt: timeToMillis(point.timeUnixNano ?? point.startTimeUnixNano, 1_000_000),
              serviceName: svc,
              name: redact(metric.name).slice(0, 512),
              ...(Number.isFinite(numeric) ? { value: numeric } : {}),
              ...(unit ? { unit } : {}),
              attributes: combineAttributes(resourceAttrs, attributes(point.attributes)),
            })
          );
        }
      }
    }
  }
  return result;
}

function jaegerTraces(payload: UnknownRecord): RuntimeSignal[] {
  const result: RuntimeSignal[] = [];
  const traces = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.traces) ? payload.traces : [];
  for (const rawTrace of traces) {
    const trace = record(rawTrace);
    if (!trace) continue;
    const processes = record(trace.processes) ?? {};
    for (const rawSpan of list(trace.spans)) {
      const span = record(rawSpan);
      if (!span || typeof span.operationName !== 'string') continue;
      const process = record(processes[String(span.processID)]) ?? {};
      const processTags = attributes(
        list(process.tags).map((tag) => {
          const item = record(tag);
          return item ? { key: item.key, value: item.value } : null;
        })
      );
      const tags = attributes(
        list(span.tags).map((tag) => {
          const item = record(tag);
          if (!item) return null;
          const value = item.type === 'bool' ? { boolValue: item.value } : item.type === 'int64' || item.type === 'float64' ? { doubleValue: item.value } : { stringValue: item.value };
          return { key: item.key, value };
        })
      );
      const traceId = typeof span.traceID === 'string' ? span.traceID.toLowerCase() : undefined;
      const spanId = typeof span.spanID === 'string' ? span.spanID.toLowerCase() : undefined;
      const error = tags.error === true || tags['otel.status_code'] === 'ERROR';
      result.push(
        makeSignal({
          kind: 'span',
          source: 'jaeger',
          // Jaeger stores startTime and duration as microseconds.
          observedAt: timeToMillis(span.startTime, 1_000),
          serviceName: typeof process.serviceName === 'string' ? redact(process.serviceName).slice(0, 256) : 'unknown-service',
          name: redact(span.operationName).slice(0, 512),
          ...(traceId && /^[a-f0-9]{16,32}$/.test(traceId) ? { traceId } : {}),
          ...(spanId && /^[a-f0-9]{16}$/.test(spanId) ? { spanId } : {}),
          status: error ? 'error' : 'unset',
          attributes: combineAttributes(processTags, tags),
        })
      );
    }
  }
  return result;
}

function rawSignalCount(kind: 'traces' | 'logs' | 'metrics' | 'jaeger', payload: UnknownRecord): number {
  if (kind === 'jaeger') {
    const traces = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.traces) ? payload.traces : [];
    return traces.reduce((sum, trace) => sum + list(record(trace)?.spans).length, 0);
  }
  const resources = list(payload[kind === 'traces' ? 'resourceSpans' : kind === 'logs' ? 'resourceLogs' : 'resourceMetrics']);
  return resources.reduce<number>((sum, rawResource) => {
    const resource = record(rawResource);
    const scopes = list(resource?.[kind === 'traces' ? 'scopeSpans' : kind === 'logs' ? 'scopeLogs' : 'scopeMetrics']);
    return sum + scopes.reduce<number>((scopeSum, rawScope) => {
      const scope = record(rawScope);
      if (kind === 'traces') return scopeSum + list(scope?.spans).length;
      if (kind === 'logs') return scopeSum + list(scope?.logRecords).length;
      return scopeSum + list(scope?.metrics).reduce<number>((metricSum, rawMetric) => {
        const metric = record(rawMetric);
        const aggregate = record(metric?.gauge) ?? record(metric?.sum) ?? record(metric?.histogram) ?? record(metric?.summary) ?? record(metric?.exponentialHistogram);
        return metricSum + list(aggregate?.dataPoints).length;
      }, 0);
    }, 0);
  }, 0);
}

export function parseRuntimeJson(
  kind: 'traces' | 'logs' | 'metrics' | 'jaeger',
  input: string
): ParsedRuntimeBatch {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > RUNTIME_MAX_BODY_BYTES) {
    throw new Error('Telemetry JSON exceeds the 2 MiB request limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error('Telemetry payload must be valid JSON');
  }
  const payload = record(parsed);
  if (!payload) throw new Error('Telemetry payload must be a JSON object');
  const hasExpectedShape = kind === 'jaeger'
    ? Array.isArray(payload.data) || Array.isArray(payload.traces)
    : Array.isArray(payload[kind === 'traces' ? 'resourceSpans' : kind === 'logs' ? 'resourceLogs' : 'resourceMetrics']);
  if (!hasExpectedShape) throw new Error(`Telemetry payload is missing its ${kind} export array`);
  const all = kind === 'jaeger' ? jaegerTraces(payload) : kind === 'traces' ? otlpSpans(payload) : kind === 'logs' ? otlpLogs(payload) : otlpMetrics(payload);
  const deduplicated = new Map<string, RuntimeSignal>();
  for (const signal of all) deduplicated.set(signal.id, signal);
  const signals = [...deduplicated.values()].slice(0, RUNTIME_MAX_SIGNALS_PER_BATCH);
  return { signals, rejectedCount: Math.max(0, rawSignalCount(kind, payload) - signals.length) };
}

function isErrorSignal(signal: RuntimeSignal): boolean {
  return signal.status === 'error' || /^(fatal|error|critical|alert|emergency)$/i.test(signal.severity ?? '');
}

function incidentId(signals: RuntimeSignal[], rule: string): string {
  return createHash('sha256')
    .update(`${rule}\0${signals.map((signal) => signal.id).sort().join('\0')}`)
    .digest('hex');
}

/** Deterministic signal correlation; it creates triage groups, not causal/root-cause claims. */
export function correlateRuntimeIncidents(signals: RuntimeSignal[]): RuntimeIncident[] {
  const errors = signals.filter(isErrorSignal).sort((a, b) => a.observedAt - b.observedAt);
  const groups = new Map<string, { rule: RuntimeIncident['correlation']; items: RuntimeSignal[] }>();
  for (const signal of errors) {
    const rule: RuntimeIncident['correlation'] = signal.traceId ? 'trace_id' : 'service_time_window';
    const bucket = rule === 'trace_id' ? signal.traceId! : `${Math.floor(signal.observedAt / 300_000)}`;
    const key = rule === 'trace_id' ? `${signal.serviceName}:trace:${bucket}` : `${signal.serviceName}:window:${bucket}`;
    const group = groups.get(key) ?? { rule, items: [] };
    group.items.push(signal);
    groups.set(key, group);
  }

  const incidents: RuntimeIncident[] = [];
  for (const group of groups.values()) {
    const items = group.items;
    incidents.push({
      id: incidentId(items, group.rule),
      severity: 'error',
      serviceName: items[0]?.serviceName ?? 'unknown-service',
      title: group.rule === 'trace_id' ? 'Errors sharing a trace' : 'Errors in one service time window',
      firstSeenAt: items[0]?.observedAt ?? 0,
      lastSeenAt: items.at(-1)?.observedAt ?? 0,
      signalCount: items.length,
      signalIds: items.slice(0, 20).map((signal) => signal.id),
      correlation: group.rule,
      explanation:
        group.rule === 'trace_id'
          ? 'Signals share a trace ID; this is a correlation key, not proof of which component caused the error.'
          : 'Signals share a service and five-minute bucket; temporal proximity does not establish causality.',
    });
  }

  const metrics = signals.filter((signal) => signal.kind === 'metric' && signal.value !== undefined);
  const metricGroups = new Map<string, RuntimeSignal[]>();
  for (const signal of metrics) {
    const key = `${signal.serviceName}\0${signal.name}`;
    const bucket = metricGroups.get(key) ?? [];
    bucket.push(signal);
    metricGroups.set(key, bucket);
  }
  for (const [key, items] of metricGroups) {
    if (items.length < 6) continue;
    const ordered = [...items].sort((a, b) => a.observedAt - b.observedAt);
    const current = ordered.at(-1)!;
    const prior = ordered.slice(0, -1).map((item) => item.value!).sort((a, b) => a - b);
    const median = prior[Math.floor(prior.length / 2)] ?? 0;
    if (!(current.value! > 0 && median > 0 && current.value! >= median * 5)) continue;
    const metricItems = [current, ...ordered.slice(-6, -1)];
    incidents.push({
      id: incidentId(metricItems, 'metric_deviation'),
      severity: 'warning',
      serviceName: current.serviceName,
      title: `Metric deviation: ${current.name}`,
      firstSeenAt: ordered.at(-6)?.observedAt ?? current.observedAt,
      lastSeenAt: current.observedAt,
      signalCount: metricItems.length,
      signalIds: metricItems.map((signal) => signal.id),
      correlation: 'metric_deviation',
      explanation: `Latest point is at least 5× the median of ${prior.length} earlier points for ${key.split('\0')[1]}; this screening heuristic is not an alert threshold or root-cause finding.`,
    });
  }
  return incidents.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 100);
}
