import { useEffect, useMemo, useRef, useState } from 'react';
import { curveLinearClosed, lineRadial, pointRadial } from 'd3-shape';

export interface WaveformThumbnailDatum {
  id: string;
  fileName: string;
  segmentLabel: string;
  clusterKm: number | null;
  waveform: number[];
  features: Record<string, number>;
}

interface WaveformThumbnailProps {
  datum?: WaveformThumbnailDatum;
  selectedFeatures: string[];
  featureGroups: Record<string, string>;
  groupColors: Record<string, string>;
  size?: number;
  clusterColor?: string;
  showLegend?: boolean;
  legendSide?: 'right' | 'top' | 'top-right';
  activeFeature?: string;
  onFeatureSelect?: (feature: string) => void;
}

const fallbackColor = '#8A8A8A';

// One-line descriptions for each feature
const FEATURE_DESC: Record<string, string> = {
  upward_ratio:          'Fraction of melodic steps moving upward',
  leap_ratio:            'Fraction of intervals larger than a step',
  pitch_range:           'Semitone span from lowest to highest note',
  mfcc_mean_8:           'MFCC 8 mean — harmonic texture',
  mfcc_mean_10:          'MFCC 10 mean — timbral fine detail',
  mfcc_var_8:            'MFCC 8 variance — harmonic variation',
  mfcc_var_11:           'MFCC 11 variance — high-order spectral change',
  mfcc_var_12:           'MFCC 12 variance — timbral change intensity',
  rms_mean:              'Average loudness / energy',
  rms_variance:          'Loudness variation within segment',
  spectral_centroid_mean:'Average brightness (frequency centre of mass)',
  spectral_brightness:   'Energy above 1.5 kHz — sharpness',
};

const GROUP_DESC: Record<string, string> = {
  pitch:       'Pitch',
  rhythm:      'Rhythm',
  dynamics:    'Dynamics',
  harmony:     'Harmony',
  timbre:      'Timbre',
  timbre_mfcc: 'Timbre (MFCC)',
  other:       'Other',
};

const normalizeArrayLength = (values: number[], length: number) => (
  Array.from({ length }, (_value, index) => values[index] ?? 0)
);

const useAnimatedArray = (target: number[], durationMs = 420) => {
  const [current, setCurrent] = useState(() => target);
  const currentRef = useRef(target);

  useEffect(() => {
    if (!target.length) {
      currentRef.current = target;
      setCurrent(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const from = normalizeArrayLength(currentRef.current, target.length);
    const to = normalizeArrayLength(target, target.length);

    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = to.map((value, index) => from[index] + ((value - from[index]) * eased));
      currentRef.current = next;
      setCurrent(next);
      if (t < 1) frame = window.requestAnimationFrame(animate);
    };

    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return current;
};

const WaveformThumbnail = ({
  datum,
  selectedFeatures,
  featureGroups,
  groupColors,
  size = 118,
  clusterColor = '#ffffff',
  showLegend = true,
  legendSide = 'right',
  activeFeature,
  onFeatureSelect,
}: WaveformThumbnailProps) => {
  const [hovered, setHovered] = useState(false);
  const center = size / 2;
  const waveformBaseRadius = size * 0.39;
  const waveformAmplitude = size * 0.07;
  const radarMinRadius = size * 0.07;
  const radarMaxRadius = size * 0.28;
  const featureCount = Math.max(1, selectedFeatures.length);
  const selectedIndex = Math.max(0, selectedFeatures.indexOf(activeFeature ?? selectedFeatures[0] ?? ''));
  const rotationDeg = selectedFeatures.length > 0 ? -(selectedIndex * (360 / featureCount)) : 0;
  const orderedFeatures = selectedFeatures.map((_, index) => (
    selectedFeatures[(index + selectedIndex) % featureCount]
  )).filter(Boolean);
  const prevFeature = selectedFeatures[(selectedIndex - 1 + featureCount) % featureCount] ?? '';
  const currentFeature = selectedFeatures[selectedIndex] ?? '';
  const nextFeature = selectedFeatures[(selectedIndex + 1) % featureCount] ?? '';
  const canSelectFeature = Boolean(onFeatureSelect && selectedFeatures.length > 1);
  const targetWaveform = useMemo(() => datum?.waveform ?? [], [datum?.waveform]);
  const targetRadarValues = useMemo(() => (
    selectedFeatures.map(feature => Math.max(0, Math.min(1, datum?.features[feature] ?? 0)))
  ), [datum?.features, selectedFeatures]);
  const animatedWaveform = useAnimatedArray(targetWaveform, 520);
  const animatedRadarValues = useAnimatedArray(targetRadarValues, 460);

  const selectOffset = (offset: number) => {
    if (!onFeatureSelect || !selectedFeatures.length) return;
    const nextIndex = (selectedIndex + offset + featureCount) % featureCount;
    const next = selectedFeatures[nextIndex];
    if (next) onFeatureSelect(next);
  };

  if (!datum) {
    return (
      <div
        className="flex items-center justify-center rounded border border-white/10 bg-white/[0.03] text-[8px] uppercase tracking-[0.2em] text-white/25"
        style={{ width: size, height: size }}
      >
        No thumbnail
      </div>
    );
  }

  const waveformPath = lineRadial<number>()
    .angle((_d, index) => (index / Math.max(1, animatedWaveform.length)) * Math.PI * 2)
    .radius((value) => waveformBaseRadius + (Math.max(-1, Math.min(1, value)) * waveformAmplitude))
    .curve(curveLinearClosed)(animatedWaveform) ?? '';

  const radarPath = lineRadial<number>()
    .angle((_d, index) => (index / Math.max(1, selectedFeatures.length)) * Math.PI * 2)
    .radius(value => radarMinRadius + (value * (radarMaxRadius - radarMinRadius)))
    .curve(curveLinearClosed)(animatedRadarValues) ?? '';

  const featurePoints = selectedFeatures.map((feature, index) => {
    const angle = (index / Math.max(1, selectedFeatures.length)) * Math.PI * 2;
    const value = Math.max(0, Math.min(1, animatedRadarValues[index] ?? 0));
    const radius = radarMinRadius + (value * (radarMaxRadius - radarMinRadius));
    const [x, y] = pointRadial(angle, radius);
    const group = featureGroups[feature] ?? 'other';
    return {
      feature,
      x,
      y,
      // Always neutral — cluster color owns the color channel
      color: 'rgba(255,255,255,0.72)',
      groupColor: groupColors[group] ?? fallbackColor,
      group,
      value,
      isActive: feature === currentFeature,
    };
  });

  return (
    <div
      className={`relative inline-block ${canSelectFeature ? 'cursor-ew-resize' : ''}`}
      style={{ width: size, height: size }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => selectOffset(1)}
      onWheel={(event) => {
        if (!canSelectFeature) return;
        event.preventDefault();
        selectOffset(event.deltaY > 0 ? 1 : -1);
      }}
    >
      {canSelectFeature && (
        <div className="absolute inset-x-[-14px] top-[-28px] z-10 grid grid-cols-[1fr_1.65fr_1fr] items-end gap-1.5 text-center font-mono uppercase tracking-[0.08em]">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              selectOffset(-1);
            }}
            className="truncate text-[8px] text-white/30 transition-colors hover:text-white/55"
            title={prevFeature}
          >
            {prevFeature.replaceAll('_', ' ')}
          </button>
          <div className="min-w-0">
            <p className="truncate text-[11px] text-white" title={currentFeature}>
              {currentFeature.replaceAll('_', ' ')}
            </p>
            <div className="mx-auto mt-1 flex w-16 justify-between">
              {orderedFeatures.map((feature, index) => (
                <span
                  key={feature}
                  className={`h-1 w-px rounded-full ${index === 0 ? 'bg-white/76' : 'bg-white/24'}`}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              selectOffset(1);
            }}
            className="truncate text-[8px] text-white/30 transition-colors hover:text-white/55"
            title={nextFeature}
          >
            {nextFeature.replaceAll('_', ' ')}
          </button>
        </div>
      )}

      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Waveform thumbnail for ${datum.fileName} ${datum.segmentLabel}`}
        className="block overflow-visible"
      >
        <g transform={`translate(${center}, ${center})`}>
          {[0.25, 0.5, 0.75].map(radius => (
            <circle
              key={radius}
              r={radius * waveformBaseRadius}
              fill="none"
              stroke="rgba(255,255,255,0.10)"
              strokeWidth="0.7"
            />
          ))}

          <circle
            r={waveformBaseRadius}
            fill="none"
            stroke="rgba(255,255,255,0.24)"
            strokeWidth="0.8"
          />

          <path
            d={waveformPath}
            fill="none"
            stroke={clusterColor}
            strokeOpacity="0.84"
            strokeWidth="1.1"
            vectorEffect="non-scaling-stroke"
          />

          <g
            style={{
              transform: `rotate(${rotationDeg}deg)`,
              transformOrigin: '0px 0px',
              transition: 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <path
              d={radarPath}
              fill="rgba(255,255,255,0.06)"
              stroke="rgba(255,255,255,0.48)"
              strokeWidth="0.9"
              vectorEffect="non-scaling-stroke"
              style={{ transition: 'opacity 240ms ease, fill 240ms ease, stroke 240ms ease' }}
            />

            {featurePoints.map(point => (
              <g key={point.feature}>
                <line
                  x1="0"
                  y1="0"
                  x2={point.x}
                  y2={point.y}
                  stroke={point.color}
                  strokeOpacity={point.isActive ? 1 : 0.62}
                  strokeWidth={point.isActive ? 1.45 : 1}
                  vectorEffect="non-scaling-stroke"
                  style={{ transition: 'stroke-opacity 240ms ease, stroke-width 240ms ease' }}
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={point.isActive ? 2.9 : 2.2}
                  fill={point.color}
                  style={{ transition: 'r 240ms ease, opacity 240ms ease' }}
                />
              </g>
            ))}
          </g>

          <circle r="2" fill="rgba(255,255,255,0.68)" />
        </g>
      </svg>

      {/* Hover legend */}
      {showLegend && hovered && (
        <div
          className={`absolute z-50 w-80 max-w-[min(20rem,calc(100vw-2rem))] bg-black/96 backdrop-blur-xl border border-white/14 rounded-lg shadow-2xl p-4 space-y-3.5 pointer-events-none ${
            legendSide === 'top'
              ? 'bottom-[calc(100%+3rem)] left-0'
              : legendSide === 'top-right'
                ? 'bottom-[calc(100%+3rem)] left-0'
                : 'left-full top-0 ml-3'
          }`}
          style={{ minWidth: '18rem' }}
        >
          {/* Outer ring */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-px w-5 border-t border-dashed" style={{ borderColor: clusterColor, opacity: 0.85 }} />
              <span className="text-xs uppercase tracking-[0.1em] text-white/70">Outer ring</span>
            </div>
            <p className="text-xs leading-snug text-white/56">Waveform energy contour across the segment.</p>
          </div>

          {/* Inner spokes */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-white/60" />
              <span className="text-xs uppercase tracking-[0.1em] text-white/70">Inner spokes</span>
            </div>
            <p className="mb-2 text-xs leading-snug text-white/56">Longer spoke = higher feature value.</p>
            <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
              {featurePoints.map(point => (
                <div key={point.feature} className="flex items-start gap-2">
                  <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-white/42" />
                  <div className="min-w-0">
                    <span className="font-mono text-[11px] uppercase tracking-normal text-white/76">
                      {point.feature}
                    </span>
                    <span className="ml-1 text-[11px] text-white/48">
                      {(point.value * 100).toFixed(0)}%
                    </span>
                    <p className="font-sans text-[11px] normal-case leading-snug tracking-normal text-white/50">
                      {FEATURE_DESC[point.feature] ?? ''}
                      {' '}
                      <span
                        className="rounded px-0.5 text-[9px] uppercase tracking-wide"
                        style={{ color: point.groupColor, opacity: 0.85 }}
                      >
                        {GROUP_DESC[point.group] ?? point.group}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WaveformThumbnail;
