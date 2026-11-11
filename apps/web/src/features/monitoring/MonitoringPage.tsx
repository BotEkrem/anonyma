import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { getMonitoring, type MonitoringSection, type MonitoringSectionId } from '../../api/client';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import {
  BarList,
  C,
  Card,
  TimeChart,
  Tile,
  clock,
  fmtBytes,
  fmtBytesRate,
  fmtCores,
  fmtCount,
  fmtCountTick,
  fmtMs,
  fmtPct,
  fmtRate,
  linesOf,
  preloadCountUp,
  show,
} from './charts';

const REFRESH_MS = 30_000;

const SECTIONS: { id: MonitoringSectionId; label: string; lede: string }[] = [
  {
    id: 'overview',
    label: 'Overview',
    lede: 'Who is online, how matching runs and how the services are doing.',
  },
  {
    id: 'cluster',
    label: 'Cluster · Pods',
    lede: 'The pods behind Anonyma: readiness, CPU, memory, network and restarts.',
  },
  {
    id: 'gateway',
    label: 'Gateway · HTTP',
    lede: 'The public API: traffic, response times, sessions and what it turns away.',
  },
  { id: 'core', label: 'Core · Chat', lede: 'Rooms and messages, and the calls behind them.' },
  { id: 'realtime', label: 'Match · Realtime', lede: 'The match queue and the live connections.' },
];

const pathOf = (id: MonitoringSectionId) =>
  id === 'overview' ? '/monitoring' : `/monitoring/${id}`;

function Overview({ d }: { d: MonitoringSection }) {
  const s = d.stats;
  const l = d.lines;
  const services = Object.entries(d.values.services ?? {});
  const queue = d.values.queueByMode ?? {};
  return (
    <>
      <div className="mon-tiles">
        <Tile
          label="Online now"
          value={show(s.online, fmtCount)}
          color={C.crimson}
          spark={l.online}
        />
        <Tile
          label="In the match queue"
          value={show(s.inQueue, fmtCount)}
          color={C.amber}
          spark={l.inQueue}
        />
        <Tile
          label="Sessions · 24h"
          value={show(s.sessions24h, fmtCount)}
          color={C.sand}
          spark={l.sessionsPerMinute}
        />
        <Tile
          label="Voice & video · 24h"
          value={show(s.voiceJoins24h, fmtCount)}
          color={C.green}
          spark={l.voiceJoinsPerMinute}
        />
      </div>
      <div className="mon-tiles mon-tiles-small">
        <Tile small label="Messages · 24h" value={show(s.messages24h, fmtCount)} color={C.ink} />
        <Tile small label="Rooms opened · 24h" value={show(s.rooms24h, fmtCount)} color={C.ink} />
        <Tile small label="Matches · 24h" value={show(s.pairs24h, fmtCount)} color={C.ink} />
        <Tile
          small
          label="Availability · 24h"
          value={show(s.availability24h, fmtPct)}
          color={
            s.availability24h !== null &&
            s.availability24h !== undefined &&
            s.availability24h < 0.99
              ? C.amber
              : C.green
          }
        />
      </div>
      <div className="mon-grid2">
        <Card title="People online" note="realtime connections and the match queue">
          <TimeChart
            label="People online over the last six hours"
            format={fmtCount}
            axisFormat={fmtCountTick}
            softMax={5}
            lines={[
              { name: 'Online', color: C.crimson, points: l.online ?? [] },
              { name: 'In queue', color: C.amber, points: l.inQueue ?? [] },
            ]}
          />
        </Card>
        <Card title="Activity per minute" note="sessions, messages, matches, voice & video">
          <TimeChart
            label="Sessions, messages, matches and voice joins per minute"
            format={fmtRate}
            softMax={1}
            lines={[
              { name: 'Sessions', color: C.sand, points: l.sessionsPerMinute ?? [] },
              { name: 'Messages', color: C.crimson, points: l.messagesPerMinute ?? [] },
              { name: 'Matches', color: C.amber, points: l.pairsPerMinute ?? [] },
              { name: 'Voice & video', color: C.green, points: l.voiceJoinsPerMinute ?? [] },
            ]}
          />
        </Card>
        <Card
          title="API requests"
          note={`${show(s.apiRequestsPerSecond, fmtRate)} / s now · ${show(s.apiErrorRate, fmtPct)} errors`}
        >
          <TimeChart
            label="API requests per second by status"
            format={fmtRate}
            softMax={1}
            stacked
            lines={linesOf(d.breakdowns.requestsByClass)}
          />
        </Card>
        <Card title="Response time" note={`p95 now ${show(s.apiLatencyP95Ms, fmtMs)}`}>
          <TimeChart
            label="API response time, median and 95th percentile"
            format={fmtMs}
            softMax={100}
            lines={[
              { name: 'Median (p50)', color: C.ink, points: l.latencyP50Ms ?? [] },
              { name: '95th percentile', color: C.crimson, points: l.latencyP95Ms ?? [] },
            ]}
          />
        </Card>
      </div>
      <div className="mon-grid2">
        <Card title="Match queue by mode" note="waiting right now">
          <ul className="mon-modes">
            {(['text', 'voice', 'video'] as const).map((m) => (
              <li key={m}>
                <span className="mon-mode-name">{m}</span>
                <strong>{fmtCount(queue[m] ?? 0)}</strong>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Services" note="answering their health checks">
          <ul className="status-list mon-services">
            {services.map(([name, up]) => (
              <li key={name} className={`status-item status-${up === 1 ? 'up' : 'down'}`}>
                <span className="status-dot" aria-hidden="true" />
                <div>
                  <strong>{name}</strong>
                  <div className="muted">{up === 1 ? 'up' : 'down'}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function Cluster({ d }: { d: MonitoringSection }) {
  const s = d.stats;
  return (
    <>
      <div className="mon-tiles mon-tiles-six">
        <Tile small label="Pods running" value={show(s.podsRunning, fmtCount)} color={C.green} />
        <Tile
          small
          label="Deployments ready"
          value={show(s.deploymentsReady, fmtPct)}
          color={
            s.deploymentsReady !== null &&
            s.deploymentsReady !== undefined &&
            s.deploymentsReady < 1
              ? C.amber
              : C.green
          }
        />
        <Tile
          small
          label="Not running"
          value={show(s.podsNotRunning, fmtCount)}
          color={s.podsNotRunning ? C.amber : C.green}
        />
        <Tile small label="CPU in use (cores)" value={show(s.cpuCores, fmtCores)} color={C.ink} />
        <Tile small label="Memory in use" value={show(s.memoryBytes, fmtBytes)} color={C.sand} />
        <Tile
          small
          label="Restarts · 24h"
          value={show(s.restarts24h, fmtCount)}
          color={s.restarts24h ? C.amber : C.green}
        />
      </div>
      <div className="mon-grid2">
        <Card title="CPU by container" note="cores">
          <TimeChart
            label="CPU cores per container"
            format={fmtCores}
            softMax={0.01}
            lines={linesOf(d.breakdowns.cpuByContainer)}
          />
        </Card>
        <Card title="Memory by container" note="working set">
          <TimeChart
            label="Memory per container"
            format={fmtBytes}
            softMax={1024 * 1024}
            lines={linesOf(d.breakdowns.memoryByContainer)}
          />
        </Card>
        <Card title="Network traffic" note="in and out of the pods">
          <TimeChart
            label="Network bytes per second, received and sent"
            format={fmtBytesRate}
            softMax={1024}
            lines={[
              { name: 'Received', color: C.crimson, points: d.lines.networkReceived ?? [] },
              { name: 'Sent', color: C.amber, points: d.lines.networkSent ?? [] },
            ]}
          />
        </Card>
        <Card title="Restarts per hour" note="by container">
          <TimeChart
            label="Container restarts per hour"
            format={fmtCount}
            axisFormat={fmtCountTick}
            softMax={3}
            lines={linesOf(d.breakdowns.restartsByContainer)}
          />
        </Card>
      </div>
      <div className="mon-grid1">
        <Card title="Ready replicas by deployment" note="available over desired">
          <BarList values={d.values.deploymentsReady ?? {}} />
        </Card>
      </div>
    </>
  );
}

function Runtime({ d, name }: { d: MonitoringSection; name: string }) {
  const l = d.lines;
  return (
    <div className="mon-grid3">
      <Card title="Event loop lag" note={name}>
        <TimeChart
          label={`${name} event loop delay`}
          format={fmtMs}
          softMax={20}
          lines={[
            { name: 'p50', color: C.ink, points: l.eventLoopP50Ms ?? [] },
            { name: 'p99', color: C.crimson, points: l.eventLoopP99Ms ?? [] },
          ]}
        />
      </Card>
      <Card title="Heap" note={name}>
        <TimeChart
          label={`${name} memory heap`}
          format={fmtBytes}
          softMax={1024 * 1024}
          lines={[
            { name: 'Used', color: C.crimson, points: l.heapUsedBytes ?? [] },
            { name: 'Allocated', color: C.ink, points: l.heapTotalBytes ?? [] },
          ]}
        />
      </Card>
      <Card title="CPU" note={`${name}, cores`}>
        <TimeChart
          label={`${name} CPU cores`}
          format={fmtCores}
          softMax={0.01}
          lines={[{ name: 'Cores', color: C.amber, points: l.cpuCores ?? [] }]}
        />
      </Card>
    </div>
  );
}

function Gateway({ d }: { d: MonitoringSection }) {
  const s = d.stats;
  const l = d.lines;
  return (
    <>
      <div className="mon-tiles mon-tiles-six">
        <Tile small label="Requests / s" value={show(s.requestsPerSecond, fmtRate)} color={C.ink} />
        <Tile small label="Latency p95" value={show(s.latencyP95Ms, fmtMs)} color={C.green} />
        <Tile
          small
          label="Errors"
          value={show(s.errorRate ?? 0, fmtPct)}
          color={s.errorRate && s.errorRate >= 0.01 ? C.danger : C.green}
        />
        <Tile small label="Sessions · 24h" value={show(s.sessions24h, fmtCount)} color={C.sand} />
        <Tile
          small
          label="Rate limited · 24h"
          value={show(s.rateLimited24h, fmtCount)}
          color={C.amber}
        />
        <Tile
          small
          label="Bot checks failed · 24h"
          value={show(s.turnstileRejects24h, fmtCount)}
          color={C.crimson}
        />
      </div>
      <div className="mon-grid2">
        <Card title="Requests by route" note="per second">
          <TimeChart
            label="Requests per second by route"
            format={fmtRate}
            softMax={1}
            lines={linesOf(d.breakdowns.requestsByRoute)}
          />
        </Card>
        <Card title="Requests by status" note="per second">
          <TimeChart
            label="Requests per second by status class"
            format={fmtRate}
            softMax={1}
            stacked
            lines={linesOf(d.breakdowns.requestsByClass)}
          />
        </Card>
        <Card title="p95 by route" note="95th percentile response time">
          <TimeChart
            label="95th percentile response time by route"
            format={fmtMs}
            softMax={100}
            lines={linesOf(d.breakdowns.p95ByRoute)}
          />
        </Card>
        <Card title="Response time" note="all routes">
          <TimeChart
            label="Response time percentiles"
            format={fmtMs}
            softMax={100}
            lines={[
              { name: 'p50', color: C.ink, points: l.latencyP50Ms ?? [] },
              { name: 'p95', color: C.amber, points: l.latencyP95Ms ?? [] },
              { name: 'p99', color: C.crimson, points: l.latencyP99Ms ?? [] },
            ]}
          />
        </Card>
        <Card title="Sessions and voice & video" note="per minute">
          <TimeChart
            label="Sessions and voice joins per minute"
            format={fmtRate}
            softMax={1}
            lines={[
              { name: 'Sessions', color: C.sand, points: l.sessionsPerMinute ?? [] },
              { name: 'Voice & video', color: C.green, points: l.voiceJoinsPerMinute ?? [] },
            ]}
          />
        </Card>
        <Card title="Turned away" note="per minute: rate limit, bot check">
          <TimeChart
            label="Rate-limit refusals and failed bot checks per minute"
            format={fmtRate}
            softMax={1}
            lines={[
              ...linesOf(d.breakdowns.rateLimitedByBucket, 'rate limit: '),
              ...linesOf(d.breakdowns.turnstileByReason, 'bot check: '),
            ]}
          />
        </Card>
      </div>
      <Runtime d={d} name="gateway" />
    </>
  );
}

function Core({ d }: { d: MonitoringSection }) {
  const s = d.stats;
  return (
    <>
      <div className="mon-tiles mon-tiles-six">
        <Tile
          small
          label="Messages · 24h"
          value={show(s.messages24h, fmtCount)}
          color={C.crimson}
        />
        <Tile small label="Rooms · 24h" value={show(s.rooms24h, fmtCount)} color={C.amber} />
        <Tile small label="Calls / s" value={show(s.rpcPerSecond, fmtRate)} color={C.ink} />
        <Tile
          small
          label="Call errors"
          value={show(s.rpcErrorRate ?? 0, fmtPct)}
          color={s.rpcErrorRate && s.rpcErrorRate >= 0.01 ? C.danger : C.green}
        />
        <Tile small label="Call p95" value={show(s.rpcP95Ms, fmtMs)} color={C.green} />
        <Tile small label="Event loop p99" value={show(s.eventLoopP99Ms, fmtMs)} color={C.green} />
      </div>
      <div className="mon-grid2">
        <Card title="Message activity" note="per minute, by kind">
          <TimeChart
            label="Message writes per minute by kind"
            format={fmtRate}
            softMax={1}
            lines={linesOf(d.breakdowns.messagesByOp)}
          />
        </Card>
        <Card title="Rooms opened" note="per minute, by type">
          <TimeChart
            label="Rooms opened per minute by type"
            format={fmtRate}
            softMax={1}
            lines={linesOf(d.breakdowns.roomsByType)}
          />
        </Card>
        <Card title="Calls by pattern" note="per second">
          <TimeChart
            label="Internal calls per second by pattern"
            format={fmtRate}
            softMax={1}
            lines={linesOf(d.breakdowns.rpcByPattern)}
          />
        </Card>
        <Card title="Call p95 by pattern" note="95th percentile">
          <TimeChart
            label="95th percentile call time by pattern"
            format={fmtMs}
            softMax={50}
            lines={linesOf(d.breakdowns.rpcP95ByPattern)}
          />
        </Card>
      </div>
      <Runtime d={d} name="core" />
    </>
  );
}

function Realtime({ d }: { d: MonitoringSection }) {
  const s = d.stats;
  const l = d.lines;
  return (
    <>
      <div className="mon-tiles mon-tiles-six">
        <Tile small label="In the queue" value={show(s.inQueue, fmtCount)} color={C.amber} />
        <Tile small label="Matches · 24h" value={show(s.pairs24h, fmtCount)} color={C.crimson} />
        <Tile small label="Cancelled · 24h" value={show(s.cancelled24h, fmtCount)} color={C.ink} />
        <Tile small label="Online now" value={show(s.online, fmtCount)} color={C.crimson} />
        <Tile
          small
          label="Live messages / s"
          value={show(s.wsMessagesPerSecond, fmtRate)}
          color={C.sand}
        />
        <Tile
          small
          label="Refused tickets · 24h"
          value={show(s.authFailures24h, fmtCount)}
          color={s.authFailures24h ? C.amber : C.green}
        />
      </div>
      <div className="mon-grid2">
        <Card title="Queue by mode" note="waiting people">
          <TimeChart
            label="Match queue by mode"
            format={fmtCount}
            axisFormat={fmtCountTick}
            softMax={5}
            stacked
            lines={linesOf(d.breakdowns.queueByMode)}
          />
        </Card>
        <Card title="Matches per minute" note="by mode">
          <TimeChart
            label="Matches made per minute by mode"
            format={fmtRate}
            softMax={1}
            lines={linesOf(d.breakdowns.pairsByMode)}
          />
        </Card>
        <Card title="Joins and cancels" note="per minute">
          <TimeChart
            label="Queue joins by mode and cancellations per minute"
            format={fmtRate}
            softMax={1}
            lines={[
              ...linesOf(d.breakdowns.joinsByMode, 'joined '),
              { name: 'cancelled', color: C.ink, points: l.cancelsPerMinute ?? [] },
            ]}
          />
        </Card>
        <Card title="Online" note="open realtime connections">
          <TimeChart
            label="Open realtime connections"
            format={fmtCount}
            axisFormat={fmtCountTick}
            softMax={5}
            lines={[{ name: 'Connections', color: C.crimson, points: l.online ?? [] }]}
          />
        </Card>
        <Card title="Live messages by kind" note="per second">
          <TimeChart
            label="Realtime messages per second by kind"
            format={fmtRate}
            softMax={1}
            lines={linesOf(d.breakdowns.wsMessagesByKind)}
          />
        </Card>
        <Card title="Tickets" note="per minute: used, refused">
          <TimeChart
            label="Realtime tickets used and refused per minute"
            format={fmtRate}
            softMax={1}
            lines={[
              { name: 'Used', color: C.green, points: l.ticketsPerMinute ?? [] },
              { name: 'Refused', color: C.danger, points: l.authFailuresPerMinute ?? [] },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

const VIEWS: Record<MonitoringSectionId, ComponentType<{ d: MonitoringSection }>> = {
  overview: Overview,
  cluster: Cluster,
  gateway: Gateway,
  core: Core,
  realtime: Realtime,
};

export function MonitoringPage() {
  // Start loading the counting effect with the page, ahead of the data.
  useEffect(() => preloadCountUp(), []);
  const params = useParams<{ section?: string }>();
  const current = SECTIONS.find((x) => x.id === (params.section ?? 'overview'));
  const id = current?.id ?? 'overview';
  useDocumentTitle(
    current && id !== 'overview'
      ? `${current.label} · Monitoring · Anonyma`
      : 'Monitoring · Anonyma',
  );
  const [data, setData] = useState<MonitoringSection | null>(null);
  const [failed, setFailed] = useState(false);
  const tabsRef = useRef<HTMLElement>(null);
  /** Which edges of the sideways-scrolling tab row hide more tabs (phone). */
  const [tabEdges, setTabEdges] = useState({ left: false, right: false });

  function measureTabs() {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setTabEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }

  useEffect(() => {
    measureTabs();
    window.addEventListener('resize', measureTabs);
    return () => window.removeEventListener('resize', measureTabs);
  }, []);

  // On a phone the tab row scrolls sideways: keep the open section in view.
  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>('a.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measureTabs();
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const load = () =>
      getMonitoring(id)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setFailed(!d.available);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id]);

  if (!current) return <Navigate to="/monitoring" replace />;

  const shown = data && data.section === id ? data : null;
  const View = VIEWS[id];

  return (
    <main className="panel mon">
      <div className="mon-head">
        <div>
          <h1>Monitoring</h1>
          <p className="muted">
            {current.lede} Last six hours, counts only — no names, rooms or messages. Refreshes
            every 30 seconds.
          </p>
        </div>
        <div
          className={`mon-pill ${!shown ? '' : !shown.available ? 'bad' : failed ? 'warn' : 'ok'}`.trim()}
          role="status"
        >
          <span className="status-dot" aria-hidden="true" />
          {/* A failed refresh keeps the last numbers on screen: say they are not live. */}
          {!shown
            ? failed
              ? 'Numbers unavailable'
              : 'Loading…'
            : !shown.available
              ? 'Numbers unavailable'
              : failed
                ? 'Not refreshing'
                : 'Live'}
          {shown ? <span className="muted"> · {clock(shown.generatedAt)}</span> : null}
        </div>
      </div>

      <nav
        className={`mon-tabs${tabEdges.left ? ' more-left' : ''}${tabEdges.right ? ' more-right' : ''}`}
        aria-label="Monitoring sections"
        ref={tabsRef}
        onScroll={measureTabs}
      >
        {SECTIONS.map((x) => (
          <NavLink
            key={x.id}
            to={pathOf(x.id)}
            end
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            {x.label}
          </NavLink>
        ))}
      </nav>

      {failed && !shown ? (
        <p className="mon-empty muted">
          The monitoring numbers could not be loaded. Trying again shortly.
        </p>
      ) : null}
      {shown ? <View d={shown} /> : null}
    </main>
  );
}
