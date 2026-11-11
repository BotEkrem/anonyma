import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Public monitoring numbers for the site's own /monitoring pages.
 *
 * Prometheus stays inside the cluster: the gateway asks it a FIXED set of
 * questions per section (no query text ever comes from a visitor) and hands
 * back aggregates only. Breakdowns are by fixed, low-cardinality labels —
 * service, container, deployment, route template, RPC pattern, mode, status
 * class — and every label value is checked before it leaves: no pod name,
 * instance, address or per-room label is ever returned.
 *
 * Each section's answer is shared by every visitor for CACHE_MS, and
 * concurrent misses wait on the same build.
 */

const APP_JOBS = 'job=~"gateway|core|match|realtime"';
/** Health probes, scrapes and these pages' own polling are not traffic. */
const QUIET = 'route!~"/healthz|/readyz|/metrics|/api/monitoring.*"';
const NS = 'namespace="anonyma"';
const CONT = 'namespace="anonyma",container!="",container!="POD"';
const RANGE_SECONDS = 6 * 3600;
const STEP_SECONDS = 120;
const CACHE_MS = 20_000;
const QUERY_TIMEOUT_MS = 5_000;
const MAX_SERIES = 12;
/** Route templates, RPC patterns, container and mode names; nothing else. */
const SAFE_LABEL = /^[A-Za-z0-9_.:/-]{1,80}$/;

export const MONITORING_SECTIONS = ['overview', 'cluster', 'gateway', 'core', 'realtime'] as const;
export type MonitoringSection = (typeof MONITORING_SECTIONS)[number];

export type Point = [number, number | null];

export interface SectionSnapshot {
  section: MonitoringSection;
  available: boolean;
  generatedAt: number;
  range: { start: number; end: number; step: number };
  /** Single numbers right now. */
  stats: Record<string, number | null>;
  /** One time series each. */
  lines: Record<string, Point[]>;
  /** Time series per label value (service, route, mode, …). */
  breakdowns: Record<string, Record<string, Point[]>>;
  /** Numbers right now per label value. */
  values: Record<string, Record<string, number>>;
}

interface Breakdown {
  expr: string;
  label: string;
  /** A zero series of this name while the breakdown has no series at all. */
  quiet?: string;
}

interface SectionSpec {
  stats?: Record<string, string>;
  lines?: Record<string, string>;
  breakdowns?: Record<string, Breakdown>;
  values?: Record<string, { expr: string; label: string }>;
}

const or0 = (expr: string) => `(${expr}) or vector(0)`;
const perMin = (metric: string, filter = '') => `sum(rate(${metric}${filter}[5m])) * 60`;
const h24 = (metric: string, filter = '') => or0(`sum(increase(${metric}${filter}[24h]))`);
const httpQuantile = (q: number, by = '') =>
  `histogram_quantile(${q}, sum by (le${by}) (rate(http_request_duration_seconds_bucket{${QUIET}}[5m]))) * 1000`;
const httpErrors =
  `(sum(rate(http_requests_total{status=~"5..",${QUIET}}[5m])) or vector(0))` +
  ` / clamp_min(sum(rate(http_requests_total{${QUIET}}[5m])), 1e-9)`;
const statusClass = `label_replace(rate(http_requests_total{${QUIET}}[5m]), "class", "\${1}xx", "status", "(.).*")`;

function runtime(svc: 'gateway' | 'core'): Record<string, string> {
  const p = `anonyma_${svc}_`;
  return {
    eventLoopP50Ms: `max(${p}nodejs_eventloop_lag_p50_seconds) * 1000`,
    eventLoopP99Ms: `max(${p}nodejs_eventloop_lag_p99_seconds) * 1000`,
    heapUsedBytes: `sum(${p}nodejs_heap_size_used_bytes)`,
    heapTotalBytes: `sum(${p}nodejs_heap_size_total_bytes)`,
    cpuCores: `sum(rate(${p}process_cpu_seconds_total[5m]))`,
  };
}

const SPECS: Record<MonitoringSection, SectionSpec> = {
  overview: {
    stats: {
      online: or0('sum(ws_connections)'),
      inQueue: or0('sum(match_queue_depth)'),
      sessions24h: h24('sessions_created_total'),
      voiceJoins24h: h24('voice_tokens_issued_total'),
      messages24h: h24('messages_written_total', '{op="send"}'),
      rooms24h: h24('rooms_created_total'),
      pairs24h: h24('match_paired_total'),
      availability24h: `avg(avg_over_time(up{${APP_JOBS}}[24h]))`,
      apiRequestsPerSecond: or0(`sum(rate(http_requests_total{${QUIET}}[5m]))`),
      apiLatencyP95Ms: `${httpQuantile(0.95)} > 0`,
      apiErrorRate: httpErrors,
    },
    lines: {
      online: or0('sum(ws_connections)'),
      inQueue: or0('sum(match_queue_depth)'),
      sessionsPerMinute: or0(perMin('sessions_created_total')),
      voiceJoinsPerMinute: or0(perMin('voice_tokens_issued_total')),
      messagesPerMinute: or0(perMin('messages_written_total', '{op="send"}')),
      pairsPerMinute: or0(perMin('match_paired_total')),
      latencyP50Ms: httpQuantile(0.5),
      latencyP95Ms: httpQuantile(0.95),
    },
    breakdowns: {
      requestsByClass: { expr: `sum by (class) (${statusClass})`, label: 'class' },
    },
    values: {
      queueByMode: { expr: 'sum by (mode) (match_queue_depth)', label: 'mode' },
      services: { expr: `max by (job) (up{${APP_JOBS}})`, label: 'job' },
    },
  },

  cluster: {
    stats: {
      podsRunning: or0(`sum(kube_pod_status_phase{${NS},phase="Running"})`),
      deploymentsReady: `sum(kube_deployment_status_replicas_available{${NS}}) / clamp_min(sum(kube_deployment_spec_replicas{${NS}}), 1)`,
      podsNotRunning: or0(`sum(kube_pod_status_phase{${NS},phase=~"Pending|Failed|Unknown"})`),
      cpuCores: or0(`sum(rate(container_cpu_usage_seconds_total{${CONT}}[5m]))`),
      memoryBytes: or0(`sum(container_memory_working_set_bytes{${CONT}})`),
      restarts24h: or0(`sum(increase(kube_pod_container_status_restarts_total{${NS}}[24h]))`),
    },
    lines: {
      networkReceived: or0(`sum(rate(container_network_receive_bytes_total{${NS}}[5m]))`),
      networkSent: or0(`sum(rate(container_network_transmit_bytes_total{${NS}}[5m]))`),
    },
    breakdowns: {
      cpuByContainer: {
        expr: `sum by (container) (rate(container_cpu_usage_seconds_total{${CONT}}[5m]))`,
        label: 'container',
      },
      memoryByContainer: {
        expr: `sum by (container) (container_memory_working_set_bytes{${CONT}})`,
        label: 'container',
      },
      restartsByContainer: {
        expr: `sum by (container) (increase(kube_pod_container_status_restarts_total{${NS}}[1h])) > 0`,
        label: 'container',
        quiet: 'all',
      },
    },
    values: {
      deploymentsReady: {
        expr: `kube_deployment_status_replicas_available{${NS}} / clamp_min(kube_deployment_spec_replicas{${NS}}, 1)`,
        label: 'deployment',
      },
    },
  },

  gateway: {
    stats: {
      requestsPerSecond: or0(`sum(rate(http_requests_total{${QUIET}}[5m]))`),
      latencyP95Ms: `${httpQuantile(0.95)} > 0`,
      errorRate: httpErrors,
      sessions24h: h24('sessions_created_total'),
      rateLimited24h: h24('rate_limit_rejections_total'),
      turnstileRejects24h: h24('turnstile_rejects_total'),
    },
    lines: {
      latencyP50Ms: httpQuantile(0.5),
      latencyP95Ms: httpQuantile(0.95),
      latencyP99Ms: httpQuantile(0.99),
      sessionsPerMinute: or0(perMin('sessions_created_total')),
      voiceJoinsPerMinute: or0(perMin('voice_tokens_issued_total')),
      ...runtime('gateway'),
    },
    breakdowns: {
      requestsByRoute: {
        expr: `sum by (route) (rate(http_requests_total{${QUIET}}[5m]))`,
        label: 'route',
      },
      requestsByClass: { expr: `sum by (class) (${statusClass})`, label: 'class' },
      p95ByRoute: { expr: httpQuantile(0.95, ', route'), label: 'route' },
      rateLimitedByBucket: {
        expr: 'sum by (bucket) (rate(rate_limit_rejections_total[5m])) * 60',
        label: 'bucket',
        quiet: 'all',
      },
      turnstileByReason: {
        expr: 'sum by (reason) (rate(turnstile_rejects_total[5m])) * 60',
        label: 'reason',
        quiet: 'all',
      },
    },
  },

  core: {
    stats: {
      messages24h: h24('messages_written_total', '{op="send"}'),
      rooms24h: h24('rooms_created_total'),
      rpcPerSecond: or0('sum(rate(rpc_handled_total[5m]))'),
      rpcErrorRate:
        '(sum(rate(rpc_handled_total{result="error"}[5m])) or vector(0)) / clamp_min(sum(rate(rpc_handled_total[5m])), 1e-9)',
      rpcP95Ms:
        'histogram_quantile(0.95, sum by (le) (rate(rpc_duration_seconds_bucket[5m]))) * 1000 > 0',
      eventLoopP99Ms: 'max(anonyma_core_nodejs_eventloop_lag_p99_seconds) * 1000',
    },
    lines: runtime('core'),
    breakdowns: {
      messagesByOp: {
        expr: 'sum by (op) (rate(messages_written_total[5m])) * 60',
        label: 'op',
        quiet: 'all',
      },
      roomsByType: {
        expr: 'sum by (type) (rate(rooms_created_total[5m])) * 60',
        label: 'type',
        quiet: 'all',
      },
      rpcByPattern: {
        expr: 'sum by (pattern) (rate(rpc_handled_total[5m]))',
        label: 'pattern',
        quiet: 'all',
      },
      rpcP95ByPattern: {
        expr: 'histogram_quantile(0.95, sum by (le, pattern) (rate(rpc_duration_seconds_bucket[5m]))) * 1000',
        label: 'pattern',
      },
    },
  },

  realtime: {
    stats: {
      inQueue: or0('sum(match_queue_depth)'),
      pairs24h: h24('match_paired_total'),
      cancelled24h: h24('match_cancel_total'),
      online: or0('sum(ws_connections)'),
      wsMessagesPerSecond: or0('sum(rate(ws_messages_total[5m]))'),
      authFailures24h: h24('ws_auth_failures_total'),
    },
    lines: {
      online: or0('sum(ws_connections)'),
      cancelsPerMinute: or0(perMin('match_cancel_total')),
      ticketsPerMinute: or0(perMin('ws_tickets_consumed_total')),
      authFailuresPerMinute: or0(perMin('ws_auth_failures_total')),
    },
    breakdowns: {
      queueByMode: { expr: 'sum by (mode) (match_queue_depth)', label: 'mode', quiet: 'all' },
      pairsByMode: {
        expr: 'sum by (mode) (rate(match_paired_total[5m])) * 60',
        label: 'mode',
        quiet: 'all',
      },
      joinsByMode: {
        expr: 'sum by (mode) (rate(match_enqueue_total[5m])) * 60',
        label: 'mode',
        quiet: 'all',
      },
      wsMessagesByKind: {
        expr: 'sum by (kind) (rate(ws_messages_total[5m]))',
        label: 'kind',
        quiet: 'all',
      },
    },
    values: {
      queueByMode: { expr: 'sum by (mode) (match_queue_depth)', label: 'mode' },
    },
  },
};

interface VectorSample {
  metric: Record<string, string>;
  value: [number, string];
}

interface MatrixSample {
  metric: Record<string, string>;
  values: [number, string][];
}

/** Four significant digits: the page needs no more, and the answer stays small. */
function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Number(n.toPrecision(4)) : null;
}

export function isMonitoringSection(value: unknown): value is MonitoringSection {
  return typeof value === 'string' && (MONITORING_SECTIONS as readonly string[]).includes(value);
}

@Injectable()
export class MonitoringService {
  private readonly log = new Logger(MonitoringService.name);
  private readonly base: string;
  private readonly cached = new Map<MonitoringSection, { at: number; data: SectionSnapshot }>();
  private readonly inflight = new Map<MonitoringSection, Promise<SectionSnapshot>>();

  constructor(config: ConfigService) {
    this.base = (config.get<string>('PROMETHEUS_URL') ?? 'http://prometheus:9090').replace(
      /\/+$/,
      '',
    );
  }

  snapshot(section: MonitoringSection): Promise<SectionSnapshot> {
    const hit = this.cached.get(section);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
    let job = this.inflight.get(section);
    if (!job) {
      job = this.build(section)
        .then((data) => {
          this.cached.set(section, { at: Date.now(), data });
          return data;
        })
        .finally(() => this.inflight.delete(section));
      this.inflight.set(section, job);
    }
    return job;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const url = `${this.base}${path}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`prometheus ${res.status}`);
    const body = (await res.json()) as { status: string; data?: { result?: T[] } };
    if (body.status !== 'success') throw new Error('prometheus query failed');
    return body.data?.result ?? [];
  }

  private async build(section: MonitoringSection): Promise<SectionSnapshot> {
    const spec = SPECS[section];
    const end = Math.floor(Date.now() / 1000 / STEP_SECONDS) * STEP_SECONDS;
    const start = end - RANGE_SECONDS;
    const stamps: number[] = [];
    for (let t = start; t <= end; t += STEP_SECONDS) stamps.push(t);

    const instant = (expr: string) => this.get<VectorSample>('/api/v1/query', { query: expr });
    const range = (expr: string) =>
      this.get<MatrixSample>('/api/v1/query_range', {
        query: expr,
        start: String(start),
        end: String(end),
        step: String(STEP_SECONDS),
      });
    const align = (values: [number, string][]): Point[] => {
      const seen = new Map<number, number | null>();
      for (const [t, v] of values) seen.set(Math.round(t), num(v));
      return stamps.map((t) => [t, seen.get(t) ?? null]);
    };

    let ok = 0;
    let failed = 0;
    const settle = async <T>(job: Promise<T>, fallback: T): Promise<T> => {
      try {
        const out = await job;
        ok++;
        return out;
      } catch {
        failed++;
        return fallback;
      }
    };

    const statsJob = Promise.all(
      Object.entries(spec.stats ?? {}).map(async ([key, expr]) => {
        const rows = await settle(instant(expr), []);
        return [key, num(rows[0]?.value[1])] as const;
      }),
    );
    const linesJob = Promise.all(
      Object.entries(spec.lines ?? {}).map(async ([key, expr]) => {
        const rows = await settle(range(expr), []);
        return [
          key,
          rows[0] ? align(rows[0].values) : stamps.map((t) => [t, null] as Point),
        ] as const;
      }),
    );
    const breakdownsJob = Promise.all(
      Object.entries(spec.breakdowns ?? {}).map(async ([key, b]) => {
        const rows = await settle(range(b.expr), []);
        const byName = new Map<string, { points: Point[]; total: number }>();
        for (const row of rows) {
          const name = row.metric[b.label];
          if (!name || !SAFE_LABEL.test(name)) continue;
          const points = align(row.values);
          const total = points.reduce((sum, [, v]) => sum + (v ?? 0), 0);
          byName.set(name, { points, total });
        }
        const top = [...byName.entries()]
          .sort((a, c) => c[1].total - a[1].total)
          .slice(0, MAX_SERIES);
        const out: Record<string, Point[]> = Object.fromEntries(
          top.map(([name, s]) => [name, s.points]),
        );
        if (!top.length && b.quiet) out[b.quiet] = stamps.map((t) => [t, 0]);
        return [key, out] as const;
      }),
    );
    const valuesJob = Promise.all(
      Object.entries(spec.values ?? {}).map(async ([key, v]) => {
        const rows = await settle(instant(v.expr), []);
        const out: Record<string, number> = {};
        for (const row of rows) {
          const name = row.metric[v.label];
          const value = num(row.value[1]);
          if (name && SAFE_LABEL.test(name) && value !== null) out[name] = value;
        }
        return [key, out] as const;
      }),
    );

    const [stats, lines, breakdowns, values] = await Promise.all([
      statsJob,
      linesJob,
      breakdownsJob,
      valuesJob,
    ]);
    if (failed) this.log.warn(`monitoring ${section}: ${failed}/${ok + failed} queries failed`);

    return {
      section,
      available: ok > 0,
      generatedAt: Math.floor(Date.now() / 1000),
      range: { start, end, step: STEP_SECONDS },
      stats: Object.fromEntries(stats),
      lines: Object.fromEntries(lines),
      breakdowns: Object.fromEntries(breakdowns),
      values: Object.fromEntries(values),
    };
  }
}
