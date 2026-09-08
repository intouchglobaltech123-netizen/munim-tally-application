import { inr } from '../lib/api';

/** Inline SVG bar chart. No charting library: this is 30 bars, and any
 *  dependency would weigh more than the thing it draws. */
export default function SalesTrend({ data }: { data: { day: string; amountPaise: number }[] }) {
  if (!data.length) return <p className="text-sm text-muted">No sales in this period.</p>;

  const max = Math.max(...data.map((d) => d.amountPaise), 1);
  const W = 640, H = 150, gap = 3;
  const bw = (W - gap * (data.length - 1)) / data.length;

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`Daily sales for the last ${data.length} days with sales`}>
        {data.map((d, i) => {
          const h = Math.max((d.amountPaise / max) * (H - 22), 2);
          return (
            <rect key={d.day} x={i * (bw + gap)} y={H - 18 - h} width={bw} height={h} rx={2}
              className="fill-brand-500">
              <title>{`${d.day}: ${inr(d.amountPaise)}`}</title>
            </rect>
          );
        })}
        <line x1="0" y1={H - 18} x2={W} y2={H - 18} className="stroke-line" strokeWidth="1" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-faint">
        <span>{data[0].day}</span>
        <span>peak {inr(max, { compact: true })}</span>
        <span>{data[data.length - 1].day}</span>
      </figcaption>
    </figure>
  );
}
