'use client';

import { useMemo, useRef, useState } from 'react';
import { axisMoney } from './charts';

/**
 * Sales as a landscape: months across, customers back, money up.
 *
 * The one place in Munim where three dimensions are honest. Everywhere else a
 * chart has one key and one value, and adding depth to that would make a bar's
 * height a matter of perspective - the last thing a money figure should be.
 * Here there genuinely are two keys (when, and who) against one value, and the
 * shape that makes is worth seeing: a ridge running back is a customer who
 * buys every month, a spike is a one-off, a valley across the front is a bad
 * month for everyone.
 *
 * Built with CSS 3D transforms rather than three.js on purpose. This renders
 * as a few hundred hardware-accelerated divs, adds nothing to the bundle, and
 * works on the cheap Android handsets and modest shop PCs this product is
 * actually used on - where a 600 KB WebGL library is a real cost and a
 * fallback path nobody would ever test.
 */

export type LandscapeCell = { month: string; party: string; value: number };

const COLOURS = [
  '#0E7A47', '#2E9E63', '#6FA82B', '#C9A227', '#C4610A', '#B3261E',
];

export default function SalesLandscape({ cells, months, parties, money = axisMoney }: {
  cells: LandscapeCell[];
  months: string[];
  parties: string[];
  money?: (p: number) => string;
}) {
  const [rotX, setRotX] = useState(58);
  const [rotZ, setRotZ] = useState(-38);
  const [hover, setHover] = useState<LandscapeCell | null>(null);
  const drag = useRef<{ x: number; y: number; rx: number; rz: number } | null>(null);

  const { grid, max } = useMemo(() => {
    const m = new Map<string, number>();
    let peak = 1;
    for (const c of cells) {
      m.set(`${c.month}|${c.party}`, c.value);
      if (c.value > peak) peak = c.value;
    }
    return { grid: m, max: peak };
  }, [cells]);

  if (!months.length || !parties.length) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
        Not enough history yet to draw a landscape.
      </div>
    );
  }

  // Sized so the whole field fits whatever the data volume, rather than
  // running off the plate when a shop has twelve months and ten customers.
  const cell = Math.max(26, Math.min(52, 420 / Math.max(months.length, parties.length)));
  const gap = 4;
  const W = months.length * (cell + gap);
  const D = parties.length * (cell + gap);
  const MAX_H = 170;

  function onDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, rx: rotX, rz: rotZ };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    // Clamped so it can never be dragged past flat-on or upside down, which
    // is where a 3D control usually gets lost.
    setRotX(Math.max(20, Math.min(85, drag.current.rx + dy * 0.4)));
    setRotZ(drag.current.rz - dx * 0.4);
  }
  const onUp = () => { drag.current = null; };

  return (
    <div>
      <div
        className="relative h-[380px] cursor-grab select-none overflow-hidden rounded-lg
                   bg-gradient-to-b from-slate-50 to-slate-100 active:cursor-grabbing"
        style={{ perspective: 1100 }}
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerLeave={onUp}
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            transformStyle: 'preserve-3d',
            transform: `translate(-50%,-50%) rotateX(${rotX}deg) rotateZ(${rotZ}deg)`,
            width: W, height: D,
            transition: drag.current ? 'none' : 'transform .35s ease-out',
          }}
        >
          {/* The floor, so the bars have something to stand on and the eye has
              a plane to read heights against. */}
          <div className="absolute inset-0 rounded"
            style={{
              background:
                `repeating-linear-gradient(90deg,#CBD5E1 0 1px,transparent 1px ${cell + gap}px),`
                + `repeating-linear-gradient(0deg,#CBD5E1 0 1px,transparent 1px ${cell + gap}px)`,
              opacity: 0.6,
            }} />

          {months.map((mo, mi) => parties.map((pa, pi) => {
            const v = grid.get(`${mo}|${pa}`) ?? 0;
            if (v <= 0) return null;
            const h = Math.max(2, (v / max) * MAX_H);
            const colour = COLOURS[Math.min(COLOURS.length - 1,
              Math.floor((v / max) * COLOURS.length))];
            const lit = !hover || (hover.month === mo && hover.party === pa);

            return (
              <div key={`${mi}-${pi}`}
                className="absolute"
                style={{
                  left: mi * (cell + gap), top: pi * (cell + gap),
                  width: cell, height: cell,
                  transformStyle: 'preserve-3d',
                }}
                onPointerEnter={() => setHover({ month: mo, party: pa, value: v })}
                onPointerLeave={() => setHover(null)}
              >
                {/* Three faces is enough for a solid read at these angles;
                    six would double the node count for nothing visible. */}
                <div className="absolute inset-0 rounded-sm"
                  style={{
                    background: colour, opacity: lit ? 1 : 0.25,
                    transform: `translateZ(${h}px)`,
                    boxShadow: lit ? '0 0 0 1px rgba(255,255,255,.35) inset' : 'none',
                    transition: 'opacity .15s',
                  }} />
                <div className="absolute left-0 top-0 origin-top"
                  style={{
                    width: cell, height: h, background: colour,
                    filter: 'brightness(0.78)', opacity: lit ? 1 : 0.25,
                    transform: `rotateX(-90deg) translateY(${-h}px)`,
                    transformOrigin: 'top', transition: 'opacity .15s',
                  }} />
                <div className="absolute left-0 top-0 origin-left"
                  style={{
                    width: h, height: cell, background: colour,
                    filter: 'brightness(0.6)', opacity: lit ? 1 : 0.25,
                    transform: `rotateY(90deg) translateX(${-h}px) translateZ(0)`,
                    transformOrigin: 'left', transition: 'opacity .15s',
                  }} />
              </div>
            );
          }))}
        </div>

        {hover && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-slate-900/90
                          px-3 py-2 text-xs text-white shadow-lg">
            <div className="font-semibold">{hover.party}</div>
            <div className="opacity-80">
              {new Date(hover.month).toLocaleDateString('en-IN',
                { month: 'long', year: 'numeric' })}
            </div>
            <div className="mt-0.5 font-bold">{money(hover.value)}</div>
          </div>
        )}

        <div className="pointer-events-none absolute bottom-3 right-3 text-[11px] text-slate-400">
          Drag to turn · across: months · back: customers · up: sales
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => { setRotX(58); setRotZ(-38); }}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold
                     text-slate-600 transition hover:bg-slate-200">
          Reset view
        </button>
        <button onClick={() => { setRotX(90); setRotZ(0); }}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold
                     text-slate-600 transition hover:bg-slate-200">
          Look straight down
        </button>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span>low</span>
          {COLOURS.map((c) => (
            <span key={c} className="h-2.5 w-5 rounded-sm" style={{ background: c }} />
          ))}
          <span>high</span>
        </div>
      </div>
    </div>
  );
}
