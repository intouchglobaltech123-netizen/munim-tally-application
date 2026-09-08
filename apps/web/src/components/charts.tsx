'use client';

import { useId, useMemo, useState } from 'react';

/**
 * Charts, drawn by hand in SVG.
 *
 * No charting library: the whole set below is a few hundred lines, renders on
 * the server, and adds nothing to the bundle. Every library considered would
 * have cost more kilobytes than this file has characters, and none of them
 * draw Indian money correctly without configuration anyway.
 *
 * Everything here is flat on purpose. A shop owner reads these to decide who
 * to chase and what to reorder, and perspective makes a bar's height a matter
 * of opinion - the one thing a figure must never be.
 */

export type Point = { at: string; value: number };
export type Slice = { label: string; value: number; n?: number };

const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

/** Money on an axis: short enough to fit, precise enough to trust. */
export function axisMoney(paise: number): string {
  const r = Math.abs(paise) / 100;
  const sign = paise < 0 ? '-' : '';
  if (r >= 1e7) return `${sign}₹${(r / 1e7).toFixed(1)}Cr`;
  if (r >= 1e5) return `${sign}₹${(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `${sign}₹${Math.round(r / 1e3)}k`;
  return `${sign}₹${Math.round(r)}`;
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

/**
 * A line with an area beneath it, and a readout that follows the pointer.
 *
 * The readout matters more than the curve: a trend tells you the direction,
 * but the question that follows is always "how much, on which day".
 */
export function TrendChart({ data, height = 180, colour = '#0E7A47', money = axisMoney }: {
  data: Point[]; height?: number; colour?: string; money?: (p: number) => string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;

  const { path, area, pts, max } = useMemo(() => {
    if (!data.length) return { path: '', area: '', pts: [], max: 0 };
    const maxV = Math.max(...data.map((d) => d.value), 1);
    const iw = W - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const step = data.length > 1 ? iw / (data.length - 1) : 0;
    const p = data.map((d, i) => ({
      x: PAD.left + i * step,
      y: PAD.top + ih - (d.value / maxV) * ih,
      d,
    }));
    return {
      pts: p,
      max: maxV,
      path: p.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' '),
      area: `${p.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')} `
          + `L${p[p.length - 1].x.toFixed(1)},${PAD.top + ih} L${p[0].x.toFixed(1)},${PAD.top + ih} Z`,
    };
  }, [data, height]);

  if (!data.length) return <NoData height={height} />;
  const ih = height - PAD.top - PAD.bottom;
  const active = hover != null ? pts[hover] : null;

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height }}
      onMouseLeave={() => setHover(null)}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.22" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>

      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + ih * f} y2={PAD.top + ih * f}
            stroke="#E2E8F0" strokeWidth="1" />
          <text x={PAD.left - 6} y={PAD.top + ih * f + 4} textAnchor="end"
            fontSize="10" fill="#94A3B8">{axisMoney(max * (1 - f))}</text>
        </g>
      ))}

      <path d={area} fill={`url(#g${id})`} />
      <path d={path} fill="none" stroke={colour} strokeWidth="2.5"
        strokeLinejoin="round" strokeLinecap="round" />

      {/* One wide invisible band per point, so the readout appears anywhere
          near it rather than only on a 3px dot. */}
      {pts.map((p, i) => (
        <rect key={i} x={p.x - (W / pts.length) / 2} y={0}
          width={W / pts.length} height={height} fill="transparent"
          onMouseEnter={() => setHover(i)} />
      ))}

      {active && (
        <g>
          <line x1={active.x} x2={active.x} y1={PAD.top} y2={PAD.top + ih}
            stroke={colour} strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={active.x} cy={active.y} r="4.5" fill="#fff"
            stroke={colour} strokeWidth="2.5" />
          <text x={Math.min(Math.max(active.x, 60), W - 60)} y={PAD.top - 1}
            textAnchor="middle" fontSize="11" fontWeight="700" fill="#0F172A">
            {money(active.d.value)} · {shortDate(active.d.at)}
          </text>
        </g>
      )}

      {pts.filter((_, i) => i % Math.ceil(pts.length / 7) === 0).map((p, i) => (
        <text key={i} x={p.x} y={height - 6} textAnchor="middle"
          fontSize="10" fill="#94A3B8">{shortDate(p.d.at)}</text>
      ))}
    </svg>
  );
}

/** Money in against money out, per period. The chart owners read first. */
export function CashFlowChart({ data, height = 200, money = axisMoney }: {
  data: { at: string; in: number; out: number; net: number }[];
  height?: number; money?: (p: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  if (!data.length) return <NoData height={height} />;

  const max = Math.max(...data.flatMap((d) => [d.in, d.out]), 1);
  const iw = W - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const slot = iw / data.length;
  const bw = Math.min(18, slot * 0.34);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height }}
      onMouseLeave={() => setHover(null)}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih * f} y2={PAD.top + ih * f}
            stroke="#E2E8F0" />
          <text x={PAD.left - 6} y={PAD.top + ih * f + 4} textAnchor="end"
            fontSize="10" fill="#94A3B8">{axisMoney(max * (1 - f))}</text>
        </g>
      ))}

      {data.map((d, i) => {
        const cx = PAD.left + slot * i + slot / 2;
        const hIn = (d.in / max) * ih;
        const hOut = (d.out / max) * ih;
        return (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={PAD.left + slot * i} y={0} width={slot} height={height} fill="transparent" />
            <rect x={cx - bw - 1.5} y={PAD.top + ih - hIn} width={bw} height={hIn}
              rx="2" fill="#0E7A47" opacity={hover == null || hover === i ? 1 : 0.35} />
            <rect x={cx + 1.5} y={PAD.top + ih - hOut} width={bw} height={hOut}
              rx="2" fill="#B3261E" opacity={hover == null || hover === i ? 1 : 0.35} />
          </g>
        );
      })}

      {hover != null && (
        <text x={W / 2} y={PAD.top - 1} textAnchor="middle" fontSize="11" fill="#0F172A">
          <tspan fontWeight="700">{shortDate(data[hover].at)}</tspan>
          <tspan fill="#0E7A47">{'  in '}{money(data[hover].in)}</tspan>
          <tspan fill="#B3261E">{'  out '}{money(data[hover].out)}</tspan>
          <tspan fontWeight="700">{'  net '}{money(data[hover].net)}</tspan>
        </text>
      )}

      {data.filter((_, i) => i % Math.ceil(data.length / 7) === 0).map((d, i, arr) => (
        <text key={i} x={PAD.left + slot * (i * Math.ceil(data.length / 7)) + slot / 2}
          y={height - 6} textAnchor="middle" fontSize="10" fill="#94A3B8">
          {shortDate(d.at)}
        </text>
      ))}
    </svg>
  );
}

/**
 * A ranked bar list.
 *
 * Horizontal, because the labels are party and item names - which are long,
 * and which no owner should have to read sideways.
 */
export function RankBars({ data, colour = '#0E7A47', money = axisMoney, max = 8 }: {
  data: Slice[]; colour?: string; money?: (p: number) => string; max?: number;
}) {
  if (!data.length) return <NoData height={120} />;
  const top = data.slice(0, max);
  const peak = Math.max(...top.map((d) => d.value), 1);
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <div className="space-y-2">
      {top.map((d) => (
        <div key={d.label} className="group">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-medium text-slate-700">{d.label}</span>
            <span className="shrink-0 tabular-nums font-semibold text-slate-900">
              {money(d.value)}
              <span className="ml-1.5 font-normal text-slate-400">
                {total > 0 ? `${Math.round((d.value / total) * 100)}%` : ''}
              </span>
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${(d.value / peak) * 100}%`, background: colour }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A donut, for shares of one whole.
 *
 * Only ever used where the parts genuinely sum to something meaningful. A
 * donut of unrelated figures is decoration, and decoration on a screen people
 * make money decisions from is worse than an empty space.
 */
export function Donut({ data, size = 190, money = axisMoney }: {
  data: Slice[]; size?: number; money?: (p: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!total) return <NoData height={size} />;

  const COLOURS = ['#0E7A47', '#2E9E63', '#6FA82B', '#C9A227', '#C4610A',
                   '#B3261E', '#7A1A15', '#0B5A8A'];
  const R = size / 2 - 6;
  const r = R * 0.62;
  let angle = -Math.PI / 2;

  const arcs = data.map((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const a0 = angle; const a1 = angle + sweep;
    angle = a1;
    const big = sweep > Math.PI ? 1 : 0;
    const c = size / 2;
    const path = [
      `M${c + R * Math.cos(a0)},${c + R * Math.sin(a0)}`,
      `A${R},${R} 0 ${big} 1 ${c + R * Math.cos(a1)},${c + R * Math.sin(a1)}`,
      `L${c + r * Math.cos(a1)},${c + r * Math.sin(a1)}`,
      `A${r},${r} 0 ${big} 0 ${c + r * Math.cos(a0)},${c + r * Math.sin(a0)}`,
      'Z',
    ].join(' ');
    return { path, colour: COLOURS[i % COLOURS.length], d };
  });

  const shown = hover != null ? data[hover] : null;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} onMouseLeave={() => setHover(null)}>
        {arcs.map((a, i) => (
          <path key={i} d={a.path} fill={a.colour}
            opacity={hover == null || hover === i ? 1 : 0.35}
            onMouseEnter={() => setHover(i)}
            style={{ transition: 'opacity .15s' }} />
        ))}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle"
          fontSize="15" fontWeight="700" fill="#0F172A">
          {money(shown ? shown.value : total)}
        </text>
        <text x={size / 2} y={size / 2 + 13} textAnchor="middle" fontSize="10" fill="#94A3B8">
          {shown ? `${Math.round((shown.value / total) * 100)}%` : 'total'}
        </text>
      </svg>

      <div className="min-w-0 flex-1 space-y-1">
        {data.slice(0, 8).map((d, i) => (
          <div key={d.label}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            className={`flex items-center gap-2 rounded px-1.5 py-0.5 text-xs transition ${
              hover === i ? 'bg-slate-100' : ''}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: COLOURS[i % COLOURS.length] }} />
            <span className="min-w-0 flex-1 truncate text-slate-600">{d.label}</span>
            <span className="shrink-0 tabular-nums font-semibold text-slate-800">
              {money(d.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A tiny inline line, for a metric tile. No axes, no labels - just direction. */
/**
 * A sparkline that fills its tile.
 *
 * It used to render at a fixed 84px, which left an 84px stub floating in the
 * left of a tile three times that wide - the single most "assembled" looking
 * thing on the dashboard. A viewBox plus non-scaling-stroke lets it stretch to
 * whatever width it is given while the line stays 1.8px, rather than being
 * stretched into a wedge.
 *
 * The last point is marked. A sparkline answers "where has this been going",
 * and without a dot the eye has to work out which end is now.
 */
export function Spark({ data, colour = 'var(--color-brand-600)', height = 28 }: {
  data: Point[]; colour?: string; height?: number;
}) {
  if (data.length < 2) return null;

  // A fixed coordinate space; CSS does the stretching.
  const W = 100;
  const H = 28;
  const PAD = 2;                       // room for the end marker's radius

  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1);
  /*
   * Scaled from zero, not from the minimum.
   *
   * Starting the band at the smallest value turns a flat month into a dramatic
   * mountain, which is the most common way a sparkline lies.
   */
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  const x = (i: number) => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);

  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(d.value).toFixed(2)}`)
    .join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(2)},${H - PAD} L${PAD},${H - PAD} Z`;

  const lastX = x(data.length - 1);
  const lastY = y(values[values.length - 1]);
  const id = `sp${Math.abs(Math.round(values.reduce((a, b) => a + b, 0)))}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.16" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={area} fill={`url(#${id})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={colour}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        /*
         * Without this, preserveAspectRatio="none" stretches the stroke itself
         * and a wide tile gets a fat horizontal line and hairline verticals.
         */
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={lastX} cy={lastY} r="2"
        fill={colour}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function NoData({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center rounded-lg bg-slate-50 text-xs text-slate-400"
      style={{ height }}>
      Nothing in this period yet.
    </div>
  );
}
