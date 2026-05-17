import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SpatialPiece } from '../types';
import { ClusterMethod, getClusterValue, getClusterValueColor } from '../utils/clusterMethods';
import waveformThumbnailUrl from '../data/waveform_thumbnails.json?url';

const BAR_WIDTH = 3;
const BAR_GAP = 1;
const BAR_UNIT = BAR_WIDTH + BAR_GAP;

interface WaveformThumbnailExport {
  items?: Array<{
    id: string;
    waveform?: number[];
  }>;
}

let waveformIndexPromise: Promise<Map<string, Float32Array>> | null = null;

const loadWaveformIndex = () => {
  if (!waveformIndexPromise) {
    waveformIndexPromise = fetch(waveformThumbnailUrl)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<WaveformThumbnailExport>;
      })
      .then(payload => new Map(
        (payload.items ?? [])
          .filter(item => item.id && item.waveform?.length)
          .map(item => [item.id, Float32Array.from(item.waveform ?? [])])
      ));
  }

  return waveformIndexPromise;
};

const colorWithAlpha = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map(char => `${char}${char}`).join('')
    : normalized.padEnd(6, '0').slice(0, 6);
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return [r, g, b].some(value => Number.isNaN(value))
    ? `rgba(154,160,166,${alpha})`
    : `rgba(${r},${g},${b},${alpha})`;
};

export const recordTimelineEnd = (recordPieces: SpatialPiece[], fallbackPiece: SpatialPiece, durationHint = 0) => {
  const candidates = [
    durationHint,
    fallbackPiece.segmentEndSec,
    ...fallbackPiece.segments.map(segment => segment.time),
    ...recordPieces.map(piece => piece.segmentEndSec),
  ].filter(value => Number.isFinite(value) && value > 0);
  return Math.max(...candidates, 1);
};

export const recordPieceAtTime = (
  recordPieces: SpatialPiece[],
  time: number,
  fallbackPiece: SpatialPiece,
) => {
  const sorted = [...recordPieces].sort((a, b) => a.segmentStartSec - b.segmentStartSec);
  if (!sorted.length) return fallbackPiece;
  return sorted.find((piece, index) => {
    const nextStart = sorted[index + 1]?.segmentStartSec;
    const end = Number.isFinite(piece.segmentEndSec) && piece.segmentEndSec > piece.segmentStartSec
      ? piece.segmentEndSec
      : nextStart ?? Number.POSITIVE_INFINITY;
    return time >= piece.segmentStartSec && time < end;
  }) ?? sorted[sorted.length - 1] ?? fallbackPiece;
};

const drawBar = (
  ctx: CanvasRenderingContext2D,
  x: number,
  midY: number,
  barW: number,
  barH: number,
  radius: number,
) => {
  const top = midY - barH / 2;
  const r = Math.min(radius, barH / 2, barW / 2);
  if (r <= 0 || barH <= 0) {
    ctx.fillRect(x, top, barW, barH);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, top);
  ctx.lineTo(x + barW - r, top);
  ctx.quadraticCurveTo(x + barW, top, x + barW, top + r);
  ctx.lineTo(x + barW, top + barH - r);
  ctx.quadraticCurveTo(x + barW, top + barH, x + barW - r, top + barH);
  ctx.lineTo(x + r, top + barH);
  ctx.quadraticCurveTo(x, top + barH, x, top + barH - r);
  ctx.lineTo(x, top + r);
  ctx.quadraticCurveTo(x, top, x + r, top);
  ctx.closePath();
  ctx.fill();
};

interface RecordWaveBarProps {
  piece: SpatialPiece;
  recordPieces: SpatialPiece[];
  clusterMethod: ClusterMethod;
  activePieceId?: string | null;
  currentTime?: number;
  duration?: number;
  className?: string;
  showLabels?: boolean;
  showProgress?: boolean;
  onPick?: (piece: SpatialPiece, time: number) => void;
}

const RecordWaveBar = ({
  piece,
  recordPieces,
  clusterMethod,
  activePieceId,
  currentTime = 0,
  duration = 0,
  className = 'h-11',
  showLabels = false,
  showProgress = false,
  onPick,
}: RecordWaveBarProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [waveforms, setWaveforms] = useState<Map<string, Float32Array> | null>(null);
  const [status, setStatus] = useState('loading waveform');
  const [resizeTick, setResizeTick] = useState(0);

  const sortedRecordPieces = useMemo(
    () => [...recordPieces].sort((a, b) => a.segmentStartSec - b.segmentStartSec),
    [recordPieces]
  );

  const timelineEnd = useMemo(
    () => recordTimelineEnd(sortedRecordPieces, piece, duration),
    [duration, piece, sortedRecordPieces]
  );

  const segmentColors = useMemo(() => {
    const colors = new Map<string, string>();
    sortedRecordPieces.forEach(recordPiece => {
      colors.set(
        recordPiece.segmentLabel,
        getClusterValueColor(clusterMethod, getClusterValue(recordPiece, clusterMethod), recordPiece.isOutlier)
      );
    });
    return colors;
  }, [clusterMethod, sortedRecordPieces]);

  const waveformIdsKey = [piece, ...sortedRecordPieces].map(recordPiece => recordPiece.id).sort().join('|');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading waveform');

    loadWaveformIndex()
      .then(index => {
        if (cancelled) return;
        const nextWaveforms = new Map<string, Float32Array>();
        [piece, ...sortedRecordPieces].forEach(recordPiece => {
          const waveform = index.get(recordPiece.id);
          if (waveform) nextWaveforms.set(recordPiece.id, waveform);
        });
        setWaveforms(nextWaveforms.size ? nextWaveforms : null);
        setStatus(nextWaveforms.size ? '' : 'waveform unavailable');
      })
      .catch(err => {
        console.warn('Waveform thumbnails unavailable:', err);
        if (!cancelled) {
          setWaveforms(null);
          setStatus('waveform unavailable');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [waveformIdsKey]);

  useEffect(() => {
    if (!waveforms || !hostRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const nBars = Math.max(1, Math.floor(width / BAR_UNIT));
    const totalBarsWidth = nBars * BAR_UNIT - BAR_GAP;
    const offsetX = Math.max(0, (width - totalBarsWidth) / 2);
    const activePiece = activePieceId
      ? sortedRecordPieces.find(recordPiece => recordPiece.id === activePieceId)
      : null;
    const progress = showProgress && timelineEnd > 0
      ? Math.max(0, Math.min(1, currentTime / timelineEnd))
      : 0;

    if (activePiece) {
      const startX = (activePiece.segmentStartSec / timelineEnd) * width;
      const endX = (activePiece.segmentEndSec / timelineEnd) * width;
      ctx.fillStyle = colorWithAlpha(segmentColors.get(activePiece.segmentLabel) ?? '#9aa0a6', 0.12);
      ctx.fillRect(startX, 0, Math.max(1, endX - startX), height);
    }

    for (let i = 0; i < nBars; i += 1) {
      const barCenterX = offsetX + (i * BAR_UNIT) + (BAR_WIDTH / 2);
      const barTime = timelineEnd > 0 ? (barCenterX / width) * timelineEnd : 0;
      const barPiece = recordPieceAtTime(sortedRecordPieces, barTime, piece);
      const waveform = waveforms.get(barPiece.id) ?? waveforms.get(piece.id);
      const localStart = barPiece.segmentStartSec;
      const localEnd = Number.isFinite(barPiece.segmentEndSec) && barPiece.segmentEndSec > localStart
        ? barPiece.segmentEndSec
        : timelineEnd;
      const localProgress = Math.max(0, Math.min(1, (barTime - localStart) / Math.max(1, localEnd - localStart)));
      const sampleIdx = Math.floor(localProgress * Math.max(0, (waveform?.length ?? 1) - 1));
      const v = Math.abs(waveform?.[sampleIdx] ?? 0.18);
      const barH = Math.max(2, v * height * 0.78);
      const isPlayed = showProgress && barTime <= currentTime;
      const isActiveSegment = activePiece?.id === barPiece.id;
      const alpha = isPlayed ? 1 : isActiveSegment ? 0.46 : 0.24;
      ctx.fillStyle = colorWithAlpha(segmentColors.get(barPiece.segmentLabel) ?? '#9aa0a6', alpha);
      drawBar(ctx, offsetX + i * BAR_UNIT, mid, BAR_WIDTH, barH, 1.5);
    }

    if (showLabels) {
      ctx.font = '600 9px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      sortedRecordPieces.forEach((recordPiece, index) => {
        const x = (recordPiece.segmentStartSec / timelineEnd) * width;
        const isActiveSegment = activePiece?.id === recordPiece.id;
        if (index > 0) {
          ctx.strokeStyle = colorWithAlpha(segmentColors.get(recordPiece.segmentLabel) ?? '#9aa0a6', isActiveSegment ? 0.72 : 0.30);
          ctx.lineWidth = isActiveSegment ? 1.4 : 0.8;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }

        const labelWidth = ctx.measureText(recordPiece.segmentLabel).width + 8;
        const labelX = Math.min(x + 3, width - labelWidth - 2);
        ctx.fillStyle = colorWithAlpha(segmentColors.get(recordPiece.segmentLabel) ?? '#9aa0a6', isActiveSegment ? 0.34 : 0.16);
        if (ctx.roundRect) ctx.roundRect(labelX, 4, labelWidth, 14, 2);
        else ctx.rect(labelX, 4, labelWidth, 14);
        ctx.fill();
        ctx.fillStyle = isActiveSegment ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.42)';
        ctx.fillText(recordPiece.segmentLabel, labelX + 4, 7);
      });
    }

    if (showProgress) {
      const playheadX = progress * width;
      const playheadPiece = recordPieceAtTime(sortedRecordPieces, currentTime, piece);
      ctx.strokeStyle = segmentColors.get(playheadPiece.segmentLabel) ?? 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }, [activePieceId, clusterMethod, currentTime, piece, resizeTick, segmentColors, showLabels, showProgress, sortedRecordPieces, timelineEnd, waveforms]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      const handleResize = () => setResizeTick(value => value + 1);
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
    const observer = new ResizeObserver(() => setResizeTick(value => value + 1));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const pickAtClientX = (clientX: number) => {
    if (!onPick || !hostRef.current) return;
    const rect = hostRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const time = pct * timelineEnd;
    onPick(recordPieceAtTime(sortedRecordPieces, time, piece), time);
  };

  return (
    <div
      ref={hostRef}
      className={`relative overflow-hidden rounded border border-white/10 bg-white/[0.055] select-none ${onPick ? 'cursor-pointer' : ''} ${className}`}
      onMouseDown={(event) => pickAtClientX(event.clientX)}
      onTouchStart={(event) => pickAtClientX(event.touches[0].clientX)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {status && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-[0.24em] text-white/28 pointer-events-none">
          {status}
        </div>
      )}
    </div>
  );
};

export default RecordWaveBar;
