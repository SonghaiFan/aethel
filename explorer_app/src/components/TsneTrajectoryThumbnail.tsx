import { useMemo } from 'react';
import { curveCatmullRom, line } from 'd3-shape';
import { SpatialPiece, ThumbnailProjectionConfig } from '../types';
import { ClusterMethod, getClusterValue, getClusterValueColor } from '../utils/clusterMethods';

interface TsneTrajectoryThumbnailProps {
  recordPieces: SpatialPiece[];
  domainPieces?: SpatialPiece[];
  projectionModel?: ThumbnailProjectionModel;
  activePieceId?: string;
  clusterMethod?: ClusterMethod;
  projection?: ThumbnailProjectionConfig;
  width?: number;
  height?: number;
  className?: string;
  showLabels?: boolean;
  onSelect?: (piece: SpatialPiece) => void;
}

interface PlotPoint {
  piece: SpatialPiece;
  x: number;
  y: number;
}

type Vec3 = [number, number, number];
type AxisRange = { min: number; max: number; range: [number, number] };

export interface ThumbnailProjectionModel {
  xDomain: { min: number; max: number };
  yDomain: { min: number; max: number };
  project: (piece: SpatialPiece) => [number, number];
}

const PLANE_RANGE: [number, number] = [-11.5, 11.5];
const HEIGHT_RANGE: [number, number] = [-10.5, 10.5];
const DOMAIN_LOW_QUANTILE = 0.01;
const DOMAIN_HIGH_QUANTILE = 0.99;

const segmentSortKey = (piece: SpatialPiece) => {
  if (piece.segmentLabel === 'T') return 0;
  const match = piece.segmentLabel.match(/^V(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : piece.segmentStartSec + 10000;
};

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
};

const normalizeDomain = (values: number[]) => {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return { min: -1, max: 1 };
  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);
  if (Math.abs(max - min) < 0.0001) {
    min -= 1;
    max += 1;
  }
  return { min, max };
};

const scaleValue = (value: number, min: number, max: number, start: number, end: number) => (
  start + ((value - min) / (max - min)) * (end - start)
);

const scaleToRange = (value: number, domain: { min: number; max: number }, range: [number, number]) => {
  if (!Number.isFinite(value) || domain.max <= domain.min) return (range[0] + range[1]) / 2;
  const t = Math.max(0, Math.min(1, (value - domain.min) / (domain.max - domain.min)));
  return range[0] + t * (range[1] - range[0]);
};

const axisValue = (piece: SpatialPiece, axis: string) => {
  if (axis === 'tsneX') return piece.tsneX;
  if (axis === 'tsneY') return piece.tsneY;
  if (axis === 'selectedFeatureNorm') return piece.selectedFeatureNorm;
  if (axis.startsWith('feature:')) {
    return piece.selectedFeatureValues[axis.replace(/^feature:/, '')] ?? 0;
  }
  const value = piece[axis as keyof SpatialPiece];
  return typeof value === 'number' ? value : 0;
};

const projectionAxes = (projection?: ThumbnailProjectionConfig): [string, string] => {
  const zAxis = projection?.zAxis || 'selectedFeatureNorm';
  if (projection?.plane === 'xz') return ['tsneX', zAxis];
  if (projection?.plane === 'yz') return ['tsneY', zAxis];
  return ['tsneX', 'tsneY'];
};

const projectionLabel = (projection?: ThumbnailProjectionConfig) => (
  projection?.camera ? `${projection.capturedView.toUpperCase()} SNAP` : (projection?.plane ?? 'xy').toUpperCase()
);

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => (a[0] * b[0]) + (a[1] * b[1]) + (a[2] * b[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  (a[1] * b[2]) - (a[2] * b[1]),
  (a[2] * b[0]) - (a[0] * b[2]),
  (a[0] * b[1]) - (a[1] * b[0]),
];
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < 0.00001) return [0, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
};

const toScenePosition = ([x, y, z]: Vec3): Vec3 => [x, z, y];

const cameraProjectedPoint = (
  piece: SpatialPiece,
  projection: ThumbnailProjectionConfig,
  ranges: AxisRange[],
): [number, number] => {
  const axes = ['tsneX', 'tsneY', projection.zAxis || 'selectedFeatureNorm'];
  const semanticPosition: Vec3 = [
    scaleToRange(axisValue(piece, axes[0]), ranges[0], ranges[0].range),
    scaleToRange(axisValue(piece, axes[1]), ranges[1], ranges[1].range),
    scaleToRange(axisValue(piece, axes[2]), ranges[2], ranges[2].range),
  ];
  const scenePosition = toScenePosition(semanticPosition);
  const camera = projection.camera;
  if (!camera) return [semanticPosition[0], semanticPosition[1]];

  const forward = normalize(subtract(camera.target, camera.position));
  const right = normalize(cross(forward, camera.up));
  const vertical = normalize(cross(right, forward));
  const relative = subtract(scenePosition, camera.target);
  return [dot(relative, right), dot(relative, vertical)];
};

export const buildThumbnailProjectionModel = (
  domainPieces: SpatialPiece[],
  projection?: ThumbnailProjectionConfig,
): ThumbnailProjectionModel => {
  const sourcePieces = domainPieces.length ? domainPieces : [];
  const [horizontalAxis, verticalAxis] = projectionAxes(projection);
  const cameraRanges = projection?.camera
    ? ['tsneX', 'tsneY', projection.zAxis || 'selectedFeatureNorm'].map((axis, index) => {
      const values = sourcePieces.map(sourcePiece => axisValue(sourcePiece, axis)).filter(Number.isFinite);
      return {
        min: quantile(values, DOMAIN_LOW_QUANTILE),
        max: quantile(values, DOMAIN_HIGH_QUANTILE),
        range: index === 2 ? HEIGHT_RANGE : PLANE_RANGE,
      };
    })
    : [];

  const project = (piece: SpatialPiece): [number, number] => (
    projection?.camera
      ? cameraProjectedPoint(piece, projection, cameraRanges)
      : [axisValue(piece, horizontalAxis), axisValue(piece, verticalAxis)]
  );

  const projectedDomainPoints = sourcePieces.map(project);

  return {
    xDomain: normalizeDomain(projectedDomainPoints.map(point => point[0])),
    yDomain: normalizeDomain(projectedDomainPoints.map(point => point[1])),
    project,
  };
};

const TsneTrajectoryThumbnail = ({
  recordPieces,
  domainPieces,
  projectionModel,
  activePieceId,
  clusterMethod = 'kmedoids',
  projection,
  width = 168,
  height = 96,
  className = '',
  showLabels = false,
  onSelect,
}: TsneTrajectoryThumbnailProps) => {
  const sortedPieces = useMemo(() => (
    [...recordPieces].sort((a, b) => segmentSortKey(a) - segmentSortKey(b))
  ), [recordPieces]);

  const { points, path, activePoint } = useMemo(() => {
    const padding = 14;
    const rangeSource = domainPieces?.length ? domainPieces : sortedPieces;
    const model = projectionModel ?? buildThumbnailProjectionModel(rangeSource, projection);
    const nextPoints: PlotPoint[] = sortedPieces.map(piece => ({
      piece,
      x: 0,
      y: 0,
    })).map((point) => {
      const [xValue, yValue] = model.project(point.piece);
      return {
        ...point,
        x: scaleValue(xValue, model.xDomain.min, model.xDomain.max, padding, width - padding),
        y: scaleValue(yValue, model.yDomain.min, model.yDomain.max, height - padding, padding),
      };
    });
    const pathBuilder = line<PlotPoint>()
      .x(point => point.x)
      .y(point => point.y)
      .curve(curveCatmullRom.alpha(0.5));

    return {
      points: nextPoints,
      path: nextPoints.length > 1 ? pathBuilder(nextPoints) ?? '' : '',
      activePoint: nextPoints.find(point => point.piece.id === activePieceId),
    };
  }, [activePieceId, domainPieces, height, projection, projectionModel, sortedPieces, width]);

  if (!sortedPieces.length) {
    return (
      <div
        className={`flex items-center justify-center rounded border border-white/10 bg-white/[0.03] font-mono text-[8px] uppercase tracking-[0.2em] text-white/25 ${className}`}
        style={{ width, height }}
      >
        No map
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={`block overflow-visible ${className}`}
      role="img"
      aria-label={`Record thumbnail drawn from ${projectionLabel(projection)} projection`}
    >
      <rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        rx={6}
        fill="rgba(255,255,255,0.025)"
        stroke="rgba(255,255,255,0.09)"
      />
      <line x1={10} y1={height / 2} x2={width - 10} y2={height / 2} stroke="rgba(255,255,255,0.06)" />
      <line x1={width / 2} y1={10} x2={width / 2} y2={height - 10} stroke="rgba(255,255,255,0.06)" />
      {path && (
        <>
          <path d={path} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
          <path d={path} fill="none" stroke="rgba(255,255,255,0.72)" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {points.map((point, index) => {
        const active = point.piece.id === activePieceId;
        const clusterValue = getClusterValue(point.piece, clusterMethod);
        const color = getClusterValueColor(clusterMethod, clusterValue, point.piece.isOutlier);
        const radius = active ? 4.9 : index === 0 ? 3.8 : 3.1;
        return (
          <g
            key={point.piece.id}
            className={onSelect ? 'cursor-pointer' : ''}
            onClick={(event) => {
              if (!onSelect) return;
              event.stopPropagation();
              onSelect(point.piece);
            }}
          >
            <circle
              cx={point.x}
              cy={point.y}
              r={radius + 3}
              fill={active ? color : 'transparent'}
              opacity={active ? 0.16 : 0}
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={radius}
              fill={color}
              stroke={active ? '#ffffff' : 'rgba(255,255,255,0.44)'}
              strokeWidth={active ? 1.4 : 0.7}
            />
            {showLabels && (active || index === 0 || index === points.length - 1) && (
              <text
                x={point.x + 6}
                y={point.y - 5}
                fill={active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.44)'}
                fontSize={8}
                fontFamily="monospace"
              >
                {point.piece.segmentLabel}
              </text>
            )}
            <title>{`${point.piece.segmentLabel} · ${projectionLabel(projection)} projection`}</title>
          </g>
        );
      })}
      {activePoint && (
        <circle
          cx={activePoint.x}
          cy={activePoint.y}
          r={8.5}
          fill="none"
          stroke="rgba(255,255,255,0.38)"
          strokeWidth={1}
        />
      )}
    </svg>
  );
};

export default TsneTrajectoryThumbnail;
