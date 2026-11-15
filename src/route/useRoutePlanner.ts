// State and map drawing for the route planner. The pure maths is in planner.ts.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type ImageryTileLayer from '@arcgis/core/layers/ImageryTileLayer';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import { marsSR } from '../map/mars';
import { insideSite, type Site } from '../map/sites';
import { DEFAULT_WEIGHTS, LIMITS, type Weights } from './config';
import { loadGrid } from './loadGrid';
import { planRoute, prepareGrid, type Grid, type LonLat, type Plan } from './planner';

export type Picking = 'start' | 'end' | null;
type Status = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string };

export function useRoutePlanner(routeLayer: GraphicsLayer, layers: Record<string, unknown>, site: Site) {
  const base = site.landing; // hypothetical base antenna
  const [picking, setPicking] = useState<Picking>(null);
  const [start, setStart] = useState<LonLat | null>(null);
  const [end, setEnd] = useState<LonLat | null>(null);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const grid = useRef<{ key: string; g: Grid } | null>(null);
  const pickingRef = useRef<Picking>(null);
  pickingRef.current = picking;

  /** Called by the map click handler. Returns true when the click was used to pick a point. */
  const pick = useCallback((lon: number, lat: number) => {
    const which = pickingRef.current;
    if (!which) return false;
    if (!insideSite(site, { lon, lat })) {
      setNotice(`That point is outside the 20 m terrain model of ${site.short}. Pick a point inside the ${site.short} area.`);
      return true;
    }
    setNotice(null);
    if (which === 'start') setStart({ lon, lat });
    else setEnd({ lon, lat });
    setPicking(null);
    return true;
  }, [site]);

  const clear = useCallback(() => {
    setStart(null); setEnd(null); setPlan(null); setPicking(null); setNotice(null); setStatus({ kind: 'idle' });
  }, []);

  // Plan whenever the points or the weights change. The terrain window is reloaded only when the points change.
  useEffect(() => {
    if (!start || !end) { setPlan(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        setStatus({ kind: 'working' });
        const key = `${start.lon},${start.lat},${end.lon},${end.lat}`;
        if (grid.current?.key !== key) {
          const g = await loadGrid(site, layers['elevation'] as ImageryTileLayer, layers['minerals'] as ImageryTileLayer | undefined, [start, end, base]);
          await new Promise((r) => setTimeout(r, 0)); // let the "working" state paint before the heavy part
          prepareGrid(g, base);
          grid.current = { key, g };
        }
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 0));
        const p = planRoute(grid.current!.g, start, end, weights, LIMITS);
        if (!cancelled) { setPlan(p); setStatus({ kind: 'idle' }); }
      } catch (e) {
        if (!cancelled) { setPlan(null); setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) }); }
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [start, end, weights, layers, site, base]);

  // Draw on the map.
  useEffect(() => {
    const sr = marsSR();
    routeLayer.removeAll();
    const add = (g: Graphic) => routeLayer.add(g);
    if (plan) {
      add(new Graphic({
        geometry: new Polyline({ paths: [plan.direct.path], spatialReference: sr }),
        symbol: { type: 'simple-line', color: [200, 200, 200, 0.9], width: 2, style: 'dash' } as never,
      }));
      if (plan.safest) {
        const line = new Polyline({ paths: [plan.safest.path], spatialReference: sr });
        add(new Graphic({ geometry: line, symbol: { type: 'simple-line', color: [0, 0, 0, 0.8], width: 7 } as never }));
        add(new Graphic({ geometry: line, symbol: { type: 'simple-line', color: [60, 220, 255, 1], width: 4 } as never }));
      }
    }
    const dot = (p: LonLat | null, color: number[]) => {
      if (!p) return;
      add(new Graphic({
        geometry: new Point({ x: p.lon, y: p.lat, spatialReference: sr }),
        symbol: { type: 'simple-marker', style: 'circle', size: 12, color, outline: { color: [255, 255, 255], width: 2 } } as never,
      }));
    };
    dot(start, [60, 200, 90]);
    dot(end, [240, 70, 70]);
  }, [plan, start, end, routeLayer]);

  return { picking, setPicking, start, end, weights, setWeights, plan, status, notice, pick, clear, setStart, setEnd };
}

export type RoutePlanner = ReturnType<typeof useRoutePlanner>;
export type PlannerRef = RefObject<RoutePlanner | null>;
