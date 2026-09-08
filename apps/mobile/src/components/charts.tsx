import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect, Line, G, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { T } from '../theme';

/**
 * The same charts as the web, drawn for a phone.
 *
 * Not a shrunken copy: a hover readout does not exist on a handset, so every
 * chart here is tappable instead, and the axis labels are thinned until they
 * fit rather than overlapping into a grey smear.
 */

export type Point = { at: string; value: number };
export type Slice = { label: string; value: number };

export function axisMoney(paise: number): string {
  const r = Math.abs(paise) / 100;
  const sign = paise < 0 ? '-' : '';
  if (r >= 1e7) return `${sign}₹${(r / 1e7).toFixed(1)}Cr`;
  if (r >= 1e5) return `${sign}₹${(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `${sign}₹${Math.round(r / 1e3)}k`;
  return `${sign}₹${Math.round(r)}`;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

/** A line with an area under it. Tap anywhere to read that point. */
export function TrendChart({ data, height = 150, colour = T.green, money = axisMoney }: {
  data: Point[]; height?: number; colour?: string; money?: (p: number) => string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const W = 340;
  const PAD = { top: 10, right: 8, bottom: 20, left: 42 };

  if (!data.length) return <NoData height={height} />;

  const max = Math.max(...data.map((d) => d.value), 1);
  const iw = W - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const step = data.length > 1 ? iw / (data.length - 1) : 0;
  const pts = data.map((d, i) => ({
    x: PAD.left + i * step,
    y: PAD.top + ih - (d.value / max) * ih,
    d,
  }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${PAD.top + ih} `
             + `L${pts[0].x.toFixed(1)},${PAD.top + ih} Z`;
  const active = sel != null ? pts[sel] : null;
  const every = Math.ceil(pts.length / 4);

  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`}>
        <Defs>
          <LinearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colour} stopOpacity="0.22" />
            <Stop offset="1" stopColor={colour} stopOpacity="0" />
          </LinearGradient>
        </Defs>

        {[0, 0.5, 1].map((f) => (
          <Line key={f} x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + ih * f} y2={PAD.top + ih * f} stroke={T.line} strokeWidth="1" />
        ))}

        <Path d={area} fill="url(#grad)" />
        <Path d={line} fill="none" stroke={colour} strokeWidth="2.5"
          strokeLinejoin="round" strokeLinecap="round" />

        {active && (
          <G>
            <Line x1={active.x} x2={active.x} y1={PAD.top} y2={PAD.top + ih}
              stroke={colour} strokeWidth="1" strokeDasharray="3 3" />
            <Circle cx={active.x} cy={active.y} r="5" fill={T.card}
              stroke={colour} strokeWidth="2.5" />
          </G>
        )}
      </Svg>

      {/* Tap targets sit outside the SVG: react-native-svg's touch handling is
          inconsistent across versions, and a plain View never is. */}
      <View style={s.tapRow}>
        {pts.map((_, i) => (
          <Pressable key={i} style={{ flex: 1, height: 34, marginTop: -34 }}
            onPress={() => setSel(sel === i ? null : i)} />
        ))}
      </View>

      <View style={s.axisRow}>
        {pts.filter((_, i) => i % every === 0).map((p, i) => (
          <Text key={i} style={s.axisLabel}>{shortDate(p.d.at)}</Text>
        ))}
      </View>

      <Text style={[s.readout, { color: active ? T.ink : T.muted }]}>
        {active
          ? `${money(active.d.value)} on ${shortDate(active.d.at)}`
          : `Peak ${money(max)} · tap the chart to read a point`}
      </Text>
    </View>
  );
}

/** Money in against money out. */
export function CashFlowChart({ data, height = 160, money = axisMoney }: {
  data: { at: string; in: number; out: number; net: number }[];
  height?: number; money?: (p: number) => string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const W = 340;
  const PAD = { top: 10, right: 8, bottom: 20, left: 42 };
  if (!data.length) return <NoData height={height} />;

  const max = Math.max(...data.flatMap((d) => [d.in, d.out]), 1);
  const iw = W - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const slot = iw / data.length;
  const bw = Math.min(12, slot * 0.34);
  const active = sel != null ? data[sel] : null;

  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`}>
        {[0, 0.5, 1].map((f) => (
          <Line key={f} x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + ih * f} y2={PAD.top + ih * f} stroke={T.line} />
        ))}
        {data.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const hIn = (d.in / max) * ih;
          const hOut = (d.out / max) * ih;
          const dim = sel != null && sel !== i ? 0.3 : 1;
          return (
            <G key={i}>
              <Rect x={cx - bw - 1} y={PAD.top + ih - hIn} width={bw} height={hIn}
                rx="2" fill={T.positive} opacity={dim} />
              <Rect x={cx + 1} y={PAD.top + ih - hOut} width={bw} height={hOut}
                rx="2" fill={T.negative} opacity={dim} />
            </G>
          );
        })}
      </Svg>

      <View style={s.tapRow}>
        {data.map((_, i) => (
          <Pressable key={i} style={{ flex: 1, height: 34, marginTop: -34 }}
            onPress={() => setSel(sel === i ? null : i)} />
        ))}
      </View>

      <Text style={[s.readout, { color: active ? T.ink : T.muted }]}>
        {active
          ? `${shortDate(active.at)} · in ${money(active.in)} · out ${money(active.out)} · net ${money(active.net)}`
          : 'Tap a bar pair to read it'}
      </Text>
    </View>
  );
}

/** A ranked list. Horizontal bars, because party names are long. */
export function RankBars({ data, colour = T.green, money = axisMoney, max = 6 }: {
  data: Slice[]; colour?: string; money?: (p: number) => string; max?: number;
}) {
  if (!data.length) return <NoData height={90} />;
  const top = data.slice(0, max);
  const peak = Math.max(...top.map((d) => d.value), 1);
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <View style={{ gap: 10 }}>
      {top.map((d) => (
        <View key={d.label}>
          <View style={s.rankTop}>
            <Text style={s.rankLabel} numberOfLines={1}>{d.label}</Text>
            <Text style={s.rankValue}>
              {money(d.value)}
              <Text style={s.rankPct}>
                {total > 0 ? `  ${Math.round((d.value / total) * 100)}%` : ''}
              </Text>
            </Text>
          </View>
          <View style={s.track}>
            <View style={{
              height: '100%', borderRadius: 999, backgroundColor: colour,
              width: `${(d.value / peak) * 100}%`,
            }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Shares of one whole. */
export function Donut({ data, size = 150, money = axisMoney }: {
  data: Slice[]; size?: number; money?: (p: number) => string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!total) return <NoData height={size} />;

  const COLOURS = [T.green, T.greenMid, '#6FA82B', T.gold, '#C4610A', T.negative];
  const R = size / 2 - 4;
  const r = R * 0.6;
  let angle = -Math.PI / 2;
  const c = size / 2;

  const arcs = data.slice(0, 6).map((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const a0 = angle; const a1 = angle + sweep;
    angle = a1;
    const big = sweep > Math.PI ? 1 : 0;
    return {
      path: [
        `M${c + R * Math.cos(a0)},${c + R * Math.sin(a0)}`,
        `A${R},${R} 0 ${big} 1 ${c + R * Math.cos(a1)},${c + R * Math.sin(a1)}`,
        `L${c + r * Math.cos(a1)},${c + r * Math.sin(a1)}`,
        `A${r},${r} 0 ${big} 0 ${c + r * Math.cos(a0)},${c + r * Math.sin(a0)}`,
        'Z',
      ].join(' '),
      colour: COLOURS[i % COLOURS.length],
      d,
    };
  });

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Svg width={size} height={size}>
        {arcs.map((a, i) => (
          <Path key={i} d={a.path} fill={a.colour} opacity={sel == null || sel === i ? 1 : 0.3} />
        ))}
      </Svg>
      <View style={{ flex: 1, gap: 5 }}>
        {arcs.map((a, i) => (
          <Pressable key={a.d.label} onPress={() => setSel(sel === i ? null : i)}
            style={s.legendRow}>
            <View style={[s.dot, { backgroundColor: a.colour }]} />
            <Text style={s.legendLabel} numberOfLines={1}>{a.d.label}</Text>
            <Text style={s.legendValue}>{money(a.d.value)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A tiny line inside a tile. Direction only. */
export function Spark({ data, colour = T.green, width = 70, height = 22 }: {
  data: Point[]; colour?: string; width?: number; height?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data.map((d) => d.value), 1);
  const step = width / (data.length - 1);
  const path = data
    .map((d, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - (d.value / max) * height).toFixed(1)}`)
    .join(' ');
  return (
    <Svg width={width} height={height}>
      <Path d={path} fill="none" stroke={colour} strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
    </Svg>
  );
}

function NoData({ height }: { height: number }) {
  return (
    <View style={[s.noData, { height }]}>
      <Text style={s.noDataText}>Nothing in this period yet.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  tapRow: { flexDirection: 'row' },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 },
  axisLabel: { fontFamily: T.font.regular, fontSize: 10, color: T.muted },
  readout: { fontFamily: T.font.medium, fontSize: 11, marginTop: 8, textAlign: 'center' },
  rankTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginBottom: 5 },
  rankLabel: { flex: 1, fontFamily: T.font.medium, fontSize: 12, color: T.inkSoft },
  rankValue: { fontFamily: T.font.semibold, fontSize: 12, color: T.ink },
  rankPct: { fontFamily: T.font.regular, color: T.muted },
  track: { height: 7, borderRadius: 999, backgroundColor: T.lineSoft, overflow: 'hidden' },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 9, height: 9, borderRadius: 2 },
  legendLabel: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.inkSoft },
  legendValue: { fontFamily: T.font.semibold, fontSize: 11, color: T.ink },
  noData: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
  },
  noDataText: { fontFamily: T.font.regular, fontSize: 12, color: T.muted },
});
