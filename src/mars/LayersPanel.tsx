// Layers icon button and its list. Layers are plain data, so more can be added to INITIAL_LAYERS.
import { useState } from 'react';

export type Layer = { id: string; label: string; visible: boolean };

// Order = stacking order in the Front view, top to bottom. Each id needs a slab builder in layerBlock.ts.
export const INITIAL_LAYERS: Layer[] = [
  { id: 'height', label: 'Surface height', visible: true },
  { id: 'temperature', label: 'Temperature (simulated)', visible: true },
  { id: 'slope', label: 'Slope', visible: true },
];

type Props = {
  layers: Layer[];
  onToggle(id: string): void;
  disabled?: string[]; // ids of layers whose data isn't available
};

export function LayersPanel({ layers, onToggle, disabled = [] }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="layers">
      <button className="btn icon-btn" aria-label="Layers" title="Layers" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 2 8.5 12 14l10-5.5L12 3Z" />
          <path d="m2 12.5 10 5.5 10-5.5" />
          <path d="m2 16.5 10 5.5 10-5.5" />
        </svg>
      </button>
      {open && (
        <div className="panel layers-panel">
          {layers.map((l) => (
            <label key={l.id} className="row">
              <input
                type="checkbox"
                checked={l.visible}
                disabled={disabled.includes(l.id)}
                onChange={() => onToggle(l.id)}
              />
              {l.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
