// A layer's legend, shown under it in the layer list while it is on (only for layers of several colors): its colors as small
// squares with what they mean, or, for colors that run over a range of values, one vertical color bar (as wide as the
// squares) with the values beside it.
import type { LayerDef, LegendRamp } from './layers';

const BAR_PX = 80; // height of a color bar

function Ramp({ ramp }: { ramp: LegendRamp }) {
  const lo = ramp[0].at;
  const hi = ramp[ramp.length - 1].at;
  const pct = (at: number) => (hi === lo ? 0 : ((at - lo) / (hi - lo)) * 100);
  return (
    <div className="legend-ramp" style={{ height: BAR_PX }}>
      {/* high at the top */}
      <span className="legend-bar" style={{ background: `linear-gradient(to top, ${ramp.map((s) => `${s.color} ${pct(s.at)}%`).join(', ')})` }} />
      <span className="legend-ticks">
        {ramp.map((s) => (
          <span key={s.label} style={{ bottom: `${pct(s.at)}%` }}>
            {s.label}
          </span>
        ))}
      </span>
    </div>
  );
}

/** Whether a layer has several colors to explain (a one-color layer needs no legend). */
export const hasLegend = (l: LayerDef) => !!l.ramp || (l.legend?.length ?? 0) > 1;

export function LayerLegend({ layer }: { layer: LayerDef }) {
  return (
    <div className="layer-legend">
      {layer.ramp ? (
        <Ramp ramp={layer.ramp} />
      ) : (
        <ul>
          {layer.legend!.map((it) => (
            <li key={it.label}>
              <span className="legend-swatch" style={{ background: it.color }} />
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
