import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, Text, Line } from '@react-three/drei';
import * as THREE from 'three';
import { CameraSyncCommand, CameraSyncState, CameraView, CameraViewCommand, MusicPiece, PlaybackState, SpatialPiece, SpaceConfig } from '../types';
import { ClusterMethod, getClusterMethodColor, getClusterRepresentativeId, getClusterValue } from '../utils/clusterMethods';

const HOVER_THRESHOLD_PX = 40;
const CLICK_MAX_MOVEMENT_PX = 6;
const CLICK_MAX_DURATION_MS = 320;

const CAMERA_POSITION: [number, number, number] = [0, 16, 28];
const CAMERA_TARGET: [number, number, number] = [0, 0, 0];
const PERSPECTIVE_FOV = 64;
const MIN_VIEW_ANGLE = 0.08;
const MAX_VIEW_ANGLE = Math.PI - 0.08;
const SIDE_VIEW_POLAR_ANGLE = Math.PI / 2;
const ISO_VIEW_OFFSET = new THREE.Vector3(0.58, 0.52, 0.76);
const ISO_VIEW_POLAR_ANGLE = Math.acos(ISO_VIEW_OFFSET.y / ISO_VIEW_OFFSET.length());
const AXIS_MIN = -12;
const AXIS_MAX = 12;
const AXIS_COLOR = '#4a4a4a';
const AXIS_LABEL_COLOR = '#7a7a7a';
const AXIS_Z_COLOR = '#666666';
const GRID_COLOR = '#1c1c1c';
const TUBE_RADIAL_SEGMENTS = 5;
const SELECTED_TUBE_RADIAL_SEGMENTS = 8;
const TUBE_SEGMENTS_PER_POINT = 10;
const SELECTED_TUBE_SEGMENTS_PER_POINT = 18;
const TRAJECTORY_RADIUS = 0.018;
const ACTIVE_TRAJECTORY_RADIUS = 0.056;
const FOLLOW_CLOSE_DISTANCE = 2.6;
const FOLLOW_FAR_DISTANCE = 18;
const FOLLOW_SPEED_FOR_FAR_DISTANCE = 8;
const FOLLOW_TARGET_SMOOTHING = 3.2;
const FOLLOW_DISTANCE_SMOOTHING = 2.4;
const FOLLOW_MANUAL_DISTANCE_THRESHOLD = 0.22;
const ACTIVE_ENDPOINT_RADIUS = ACTIVE_TRAJECTORY_RADIUS * 0.62;
const ACTIVE_ENDPOINT_HALO_RADIUS = ACTIVE_TRAJECTORY_RADIUS * 2.4;
const REPRESENTATIVE_MARKER_RADIUS = 0.22;
const PLANE_RANGE: [number, number] = [-11.5, 11.5];
const HEIGHT_RANGE: [number, number] = [-10.5, 10.5];
const DOMAIN_LOW_QUANTILE = 0.01;
const DOMAIN_HIGH_QUANTILE = 0.99;
const FIT_PADDING = 1.28;
const PERSPECTIVE_FIT_PADDING = 0.9;
const FOCUSED_NODE_OPACITY = 1;
const SAME_CLUSTER_NODE_OPACITY = 0.6;
const DIMMED_NODE_OPACITY = 0.1;
const DEFAULT_TRAJECTORY_OPACITY = 0.012;
const SELECTED_TRAJECTORY_OPACITY = 0.98;
const SELECTED_TRAJECTORY_PIPE_OPACITY = 0.24;
const SELECTED_TRAJECTORY_HALO_OPACITY = 0.22;
const SELECTED_TRAJECTORY_PIPE_HALO_OPACITY = 0.13;
const RELATED_TRAJECTORY_OPACITY = 0.3;
const RELATED_TRAJECTORY_HALO_OPACITY = 0.08;
const DIMMED_TRAJECTORY_OPACITY = 0.0009;

const labelSortKey = (label: string) => {
  if (label === 'T') return 0;
  const match = label.match(/^V(\d+)$/);
  if (match) return Number.parseInt(match[1], 10);
  return Number.MAX_SAFE_INTEGER;
};

const axisLabel = (axis: string) => axis.startsWith('feature:')
  ? axis.replace(/^feature:/, '')
  : axis;

const planeAxisLabel = (axis: string) => (
  axis === 'tsneX' ? 't-SNE X' : axis === 'tsneY' ? 't-SNE Y' : axisLabel(axis)
);

const toScenePosition = ([x, y, z]: [number, number, number]): [number, number, number] => [x, z, y];

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
};

const scaleToRange = (value: number, domain: { min: number; max: number }, range: [number, number]) => {
  if (!Number.isFinite(value) || domain.max <= domain.min) return (range[0] + range[1]) / 2;
  const t = Math.max(0, Math.min(1, (value - domain.min) / (domain.max - domain.min)));
  return range[0] + t * (range[1] - range[0]);
};

const easeInOutCubic = (t: number) => (
  t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2
);

const viewOffset = (view: CameraView, distance: number) => {
  // Scene axes are [semantic X, semantic Z, semantic Y].
  // Front collapses semantic X; side collapses semantic Y.
  if (view === 'front') return new THREE.Vector3(-distance, 0, 0);
  if (view === 'side') return new THREE.Vector3(0, 0, distance);
  if (view === 'top') return new THREE.Vector3(0, distance, 0);
  return ISO_VIEW_OFFSET.clone().multiplyScalar(distance);
};

const cameraUp = (view: CameraView) => (
  view === 'top'
    ? new THREE.Vector3(0, 0, -1)
    : new THREE.Vector3(0, 1, 0)
);

const orbitControlConstraints = (orthographicMode: boolean, view: CameraView) => {
  if (!orthographicMode) {
    return {
      enableRotate: true,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
    };
  }

  if (view === 'top') {
    return {
      enableRotate: false,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
    };
  }

  if (view === 'side' || view === 'front') {
    return {
      enableRotate: true,
      minPolarAngle: SIDE_VIEW_POLAR_ANGLE,
      maxPolarAngle: SIDE_VIEW_POLAR_ANGLE,
    };
  }

  if (view === 'iso') {
    return {
      enableRotate: true,
      minPolarAngle: ISO_VIEW_POLAR_ANGLE,
      maxPolarAngle: ISO_VIEW_POLAR_ANGLE,
    };
  }

  return {
    enableRotate: true,
    minPolarAngle: MIN_VIEW_ANGLE,
    maxPolarAngle: MAX_VIEW_ANGLE,
  };
};

const applyOrbitControlConstraints = (
  controls: any,
  constraints: { enableRotate: boolean; minPolarAngle: number; maxPolarAngle: number }
) => {
  if (!controls) return;
  controls.enableRotate = constraints.enableRotate;
  controls.minPolarAngle = constraints.minPolarAngle;
  controls.maxPolarAngle = constraints.maxPolarAngle;
};

const boundsForPoints = (points: [number, number, number][]) => {
  const box = new THREE.Box3();
  points.forEach(point => box.expandByPoint(new THREE.Vector3(...point)));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { box, center, size };
};

const projectedSpans = (
  points: [number, number, number][],
  center: THREE.Vector3,
  view: CameraView
) => {
  const offset = viewOffset(view, 1).normalize();
  const viewDirection = offset.clone().multiplyScalar(-1);
  const up = cameraUp(view).normalize();
  const right = viewDirection.clone().cross(up).normalize();
  let spanX = 1;
  let spanY = 1;

  points.forEach((point) => {
    const local = new THREE.Vector3(...point).sub(center);
    spanX = Math.max(spanX, Math.abs(local.dot(right)) * 2);
    spanY = Math.max(spanY, Math.abs(local.dot(up)) * 2);
  });

  return { spanX, spanY };
};

const perspectiveFitDistance = (
  points: [number, number, number][],
  center: THREE.Vector3,
  view: CameraView,
  fovDeg: number,
  viewportWidth: number,
  viewportHeight: number
) => {
  const { spanX, spanY } = projectedSpans(points, center, view);
  const aspect = Math.max(0.1, viewportWidth / Math.max(1, viewportHeight));
  const halfFov = THREE.MathUtils.degToRad(fovDeg) / 2;
  const verticalDistance = (spanY * PERSPECTIVE_FIT_PADDING) / (2 * Math.tan(halfFov));
  const horizontalDistance = (spanX * PERSPECTIVE_FIT_PADDING) / (2 * Math.tan(halfFov) * aspect);
  return Math.max(12, verticalDistance, horizontalDistance);
};

const interpolatePathColor = (
  colors: string[],
  pathProgress: number,
  closed: boolean,
  fallback: string
) => {
  if (!colors.length) return new THREE.Color(fallback);
  if (colors.length === 1) return new THREE.Color(colors[0]);

  const edgeCount = closed ? colors.length : colors.length - 1;
  if (edgeCount <= 0) return new THREE.Color(colors[0]);

  const scaled = Math.max(0, Math.min(0.999999, pathProgress)) * edgeCount;
  const edgeIndex = Math.floor(scaled);
  const localProgress = scaled - edgeIndex;
  const start = new THREE.Color(colors[edgeIndex % colors.length]);
  const end = new THREE.Color(colors[(edgeIndex + 1) % colors.length]);
  return start.lerp(end, localProgress);
};

class PartialCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly source: THREE.Curve<THREE.Vector3>,
    private readonly progress: number
  ) {
    super();
  }

  getPoint(t: number, optionalTarget = new THREE.Vector3()) {
    return optionalTarget.copy(this.source.getPoint(t * this.progress));
  }
}

const dedupeTrajectoryPoints = (points: [number, number, number][]) => (
  points
    .map(point => new THREE.Vector3(...point))
    .filter((point, index, allPoints) => index === 0 || point.distanceToSquared(allPoints[index - 1]) > 0.0001)
);

const buildTrajectoryCurve = (
  points: [number, number, number][],
  closed: boolean,
  progress: number
) => {
  const vectors = dedupeTrajectoryPoints(points);
  if (vectors.length < 2) return null;

  const isClosed = closed && vectors.length > 2;
  const segmentCount = isClosed ? vectors.length : vectors.length - 1;
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const baseCurve = new THREE.CatmullRomCurve3(vectors, isClosed, 'centripetal');
  const curve = clampedProgress >= 0.999999 ? baseCurve : new PartialCurve(baseCurve, clampedProgress);

  return { curve, segmentCount };
};

const trajectoryPointAtProgress = (
  points: [number, number, number][],
  closed: boolean,
  progress: number
): [number, number, number] | null => {
  const vectors = dedupeTrajectoryPoints(points);
  if (vectors.length < 2) return null;

  const isClosed = closed && vectors.length > 2;
  if (progress >= 1) {
    const point = isClosed ? vectors[0] : vectors[vectors.length - 1];
    return [point.x, point.y, point.z];
  }

  const clampedProgress = Math.max(0, Math.min(0.999999, progress));
  const curve = new THREE.CatmullRomCurve3(vectors, isClosed, 'centripetal');
  const point = curve.getPoint(clampedProgress);
  return [point.x, point.y, point.z];
};

const TrajectoryTube = React.memo(({
  points,
  pointColors,
  color,
  radius,
  opacity,
  progress = 1,
  closed = false,
  radialSegments = TUBE_RADIAL_SEGMENTS,
  segmentsPerPoint = TUBE_SEGMENTS_PER_POINT,
  depthTest = true,
  renderOrder = 0,
}: {
  points: [number, number, number][];
  pointColors?: string[];
  color: string;
  radius: number;
  opacity: number;
  progress?: number;
  closed?: boolean;
  radialSegments?: number;
  segmentsPerPoint?: number;
  depthTest?: boolean;
  renderOrder?: number;
}) => {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const geometry = useMemo(() => {
    if (points.length < 2 || clampedProgress <= 0.001) return null;
    const result = buildTrajectoryCurve(points, closed, clampedProgress);
    if (!result) return null;

    const { curve, segmentCount } = result;
    const tubularSegments = Math.max(10, Math.ceil(segmentCount * segmentsPerPoint * clampedProgress));
    const geometry = new THREE.TubeGeometry(
      curve,
      tubularSegments,
      radius,
      radialSegments,
      closed && clampedProgress >= 0.999999
    );
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 3);

    for (let ringIndex = 0; ringIndex <= tubularSegments; ringIndex += 1) {
      const localTubeProgress = tubularSegments > 0 ? ringIndex / tubularSegments : 0;
      const pathProgress = localTubeProgress * clampedProgress;
      const vertexColor = interpolatePathColor(pointColors ?? [color], pathProgress, closed, color);

      for (let radialIndex = 0; radialIndex <= radialSegments; radialIndex += 1) {
        const vertexIndex = (ringIndex * (radialSegments + 1)) + radialIndex;
        colors[(vertexIndex * 3)] = vertexColor.r;
        colors[(vertexIndex * 3) + 1] = vertexColor.g;
        colors[(vertexIndex * 3) + 2] = vertexColor.b;
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [points, pointColors, color, radius, clampedProgress, closed, radialSegments, segmentsPerPoint]);

  if (points.length < 2) return null;
  if (!geometry) return null;

  return (
    <mesh renderOrder={renderOrder}>
      <primitive object={geometry} attach="geometry" />
      <meshBasicMaterial
        color="#ffffff"
        vertexColors
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={false}
        depthTest={depthTest}
        fog={false}
        toneMapped={false}
      />
    </mesh>
  );
});

const ActiveEndpointGlow = ({ position }: { position: [number, number, number] | null }) => {
  const coreRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!position) return;
    const pulse = (Math.sin(clock.elapsedTime * 3.2) + 1) * 0.5;
    const haloScale = 0.72 + pulse * 0.68;

    if (coreRef.current) {
      coreRef.current.position.set(...position);
      coreRef.current.scale.setScalar(1);
    }

    if (haloRef.current) {
      haloRef.current.position.set(...position);
      haloRef.current.scale.setScalar(haloScale);
      const material = haloRef.current.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = 0.08 + pulse * 0.16;
      }
    }
  });

  if (!position) return null;

  return (
    <group>
      <mesh ref={haloRef} position={position} renderOrder={12}>
        <sphereGeometry args={[ACTIVE_ENDPOINT_HALO_RADIUS, 16, 16]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.22}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={coreRef} position={position} renderOrder={13}>
        <sphereGeometry args={[ACTIVE_ENDPOINT_RADIUS, 12, 12]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.92}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};

const ClusterRepresentativeMarker = ({ piece }: { piece: SpatialPiece | null }) => {
  if (!piece) return null;

  return (
    <group position={piece.position} renderOrder={14}>
      <mesh>
        <sphereGeometry args={[REPRESENTATIVE_MARKER_RADIUS, 20, 20]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.18}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[REPRESENTATIVE_MARKER_RADIUS * 1.42, 20, 20]} />
        <meshBasicMaterial
          color={piece.color}
          transparent
          opacity={0.08}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[REPRESENTATIVE_MARKER_RADIUS * 0.42, 10, 10]} />
        <meshBasicMaterial
          color={piece.color}
          transparent
          opacity={0.95}
          depthWrite={false}
          fog={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};

const NodeInstances = React.memo(({
  pieces,
  playbackState,
  selectedRecordFileName,
  selectedClusterValue,
  controlsActiveRef,
  onSelect,
  onDeselect,
  onHoverChange,
}: {
  pieces: SpatialPiece[];
  playbackState: PlaybackState | null;
  selectedRecordFileName: string | null;
  selectedClusterValue: number | null;
  controlsActiveRef: React.RefObject<boolean>;
  onSelect: (p: SpatialPiece) => void;
  onDeselect: () => void;
  onHoverChange: (piece: SpatialPiece | null, x: number, y: number) => void;
}) => {
  const { camera, gl, size } = useThree();
  const mouseNDC = useRef(new THREE.Vector2());
  const mousePx = useRef({ x: 0, y: 0 });
  const pointerStart = useRef<{ x: number; y: number; time: number; button: number } | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const hoveredPieceRef = useRef<SpatialPiece | null>(null);
  const [hoveredPiece, setHoveredPiece] = useState<SpatialPiece | null>(null);
  const vec = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const el = gl.domElement;
    const updatePointerPosition = (e: MouseEvent | PointerEvent) => {
      const rect = el.getBoundingClientRect();
      mousePx.current = { x: e.clientX, y: e.clientY };
      mouseNDC.current.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    };
    const onMove = (e: MouseEvent) => updatePointerPosition(e);
    const onPointerDown = (e: PointerEvent) => {
      updatePointerPosition(e);
      pointerStart.current = {
        x: e.clientX,
        y: e.clientY,
        time: performance.now(),
        button: e.button,
      };
    };
    const onPointerUp = (e: PointerEvent) => {
      const start = pointerStart.current;
      pointerStart.current = null;
      if (!start || start.button !== 0 || e.button !== 0) return;

      updatePointerPosition(e);
      const movement = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      const elapsed = performance.now() - start.time;
      if (movement > CLICK_MAX_MOVEMENT_PX || elapsed > CLICK_MAX_DURATION_MS) return;

      let target: SpatialPiece | null = null;
      let bestDist = HOVER_THRESHOLD_PX;
      for (const piece of pieces) {
        vec.set(...piece.position);
        vec.project(camera);
        const px = ((vec.x + 1) / 2) * size.width;
        const py = ((-vec.y + 1) / 2) * size.height;
        const mx = ((mouseNDC.current.x + 1) / 2) * size.width;
        const my = ((-mouseNDC.current.y + 1) / 2) * size.height;
        const dist = Math.hypot(px - mx, py - my);
        if (dist < bestDist) {
          bestDist = dist;
          target = piece;
        }
      }
      target ??= hoveredPieceRef.current;
      if (target) onSelect(target);
      else onDeselect();
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    el.addEventListener('mousemove', onMove);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [camera, gl, onDeselect, onSelect, pieces, size.height, size.width, vec]);

  useFrame(() => {
    if (controlsActiveRef.current) {
      if (hoveredIdRef.current !== null) {
        hoveredIdRef.current = null;
        hoveredPieceRef.current = null;
        setHoveredPiece(null);
        onHoverChange(null, mousePx.current.x, mousePx.current.y);
      }
      return;
    }

    let bestPiece: SpatialPiece | null = null;
    let bestDist = HOVER_THRESHOLD_PX;

    for (const piece of pieces) {
      vec.set(...piece.position);
      vec.project(camera);
      const px = ((vec.x + 1) / 2) * size.width;
      const py = ((-vec.y + 1) / 2) * size.height;
      const mx = ((mouseNDC.current.x + 1) / 2) * size.width;
      const my = ((-mouseNDC.current.y + 1) / 2) * size.height;
      const dist = Math.sqrt((px - mx) ** 2 + (py - my) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestPiece = piece;
      }
    }

    const bestId = bestPiece?.id ?? null;
    if (hoveredIdRef.current !== bestId) {
      hoveredIdRef.current = bestId;
      hoveredPieceRef.current = bestPiece;
      setHoveredPiece(bestPiece);
      onHoverChange(bestPiece, mousePx.current.x, mousePx.current.y);
    }
  });

  const batches = useMemo(() => {
    const groups = new Map<string, { color: string; emphasis: 'focused' | 'same-cluster' | 'dimmed'; pieces: SpatialPiece[] }>();
    pieces.forEach((piece) => {
      const selected = Boolean(selectedRecordFileName);
      const sameRecord = selectedRecordFileName === piece.fileName;
      const sameCluster = selectedClusterValue !== null && piece.activeClusterValue === selectedClusterValue;
      const emphasis = !selected || sameRecord ? 'focused' : sameCluster ? 'same-cluster' : 'dimmed';
      const key = `${piece.color}::${emphasis}`;
      const group = groups.get(key) ?? { color: piece.color, emphasis, pieces: [] };
      group.pieces.push(piece);
      groups.set(key, group);
    });
    return Array.from(groups.values());
  }, [pieces, selectedClusterValue, selectedRecordFileName]);

  return (
    <group>
      {batches.map(batch => (
        <NodeBatch
          key={`${batch.color}-${batch.emphasis}`}
          color={batch.color}
          opacity={
            batch.emphasis === 'focused'
              ? FOCUSED_NODE_OPACITY
              : batch.emphasis === 'same-cluster'
                ? SAME_CLUSTER_NODE_OPACITY
                : DIMMED_NODE_OPACITY
          }
          pieces={batch.pieces}
          playbackState={playbackState}
          selectedRecordFileName={selectedRecordFileName}
          hoveredPiece={hoveredPiece}
        />
      ))}
    </group>
  );
});

const NodeBatch = React.memo(({
  color,
  opacity,
  pieces,
  playbackState,
  selectedRecordFileName,
  hoveredPiece,
}: {
  color: string;
  opacity: number;
  pieces: SpatialPiece[];
  playbackState: PlaybackState | null;
  selectedRecordFileName: string | null;
  hoveredPiece: SpatialPiece | null;
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const baseRadius = 0.045;

  const playbackNodeState = useMemo(() => {
    if (!playbackState) {
      return {
        fileName: null as string | null,
        currentId: null as string | null,
        playedUntil: Number.NEGATIVE_INFINITY,
      };
    }

    let currentPiece: SpatialPiece | undefined;
    for (let i = pieces.length - 1; i >= 0; i -= 1) {
      const piece = pieces[i];
      if (playbackState.fileName === piece.fileName && playbackState.currentTime >= piece.segmentStartSec) {
        currentPiece = piece;
        break;
      }
    }

    return {
      fileName: playbackState.fileName,
      currentId: currentPiece?.id ?? null,
      playedUntil: currentPiece?.segmentStartSec ?? playbackState.currentTime,
    };
  }, [pieces, playbackState?.duration, playbackState?.fileName, playbackState?.currentTime]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    mesh.count = pieces.length;

    pieces.forEach((piece, index) => {
      const isSelectedRecord = selectedRecordFileName === piece.fileName;
      const isPlaybackRecord = playbackNodeState.fileName === piece.fileName;
      const isPlayed = Boolean(isPlaybackRecord && piece.segmentStartSec <= playbackNodeState.playedUntil);
      const isCurrent = Boolean(isPlaybackRecord && piece.id === playbackNodeState.currentId);
      const isHovered = hoveredPiece?.id === piece.id;
      const radius = isCurrent
        ? 0.14
        : isPlayed
          ? 0.105
          : isSelectedRecord
            ? 0.082
            : isHovered
              ? 0.07
              : baseRadius;

      dummy.position.set(...piece.position);
      dummy.scale.setScalar(radius / baseRadius);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
  }, [baseRadius, dummy, hoveredPiece, pieces, playbackNodeState.currentId, playbackNodeState.fileName, playbackNodeState.playedUntil, selectedRecordFileName]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, pieces.length)]}
    >
      <sphereGeometry args={[baseRadius, 8, 8]} />
      <meshBasicMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
        toneMapped={false}
        fog={false}
      />
    </instancedMesh>
  );
});

const CameraCommandHandler = ({
  controlsRef,
  points,
  command,
  orthographicMode,
}: {
  controlsRef: React.RefObject<any>;
  points: [number, number, number][];
  command: CameraViewCommand | null;
  orthographicMode: boolean;
}) => {
  const { camera, size } = useThree();
  const animationFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!command || !points.length) return;
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    const controls = controlsRef.current;
    const targetConstraints = orbitControlConstraints(orthographicMode, command.view);
    applyOrbitControlConstraints(controls, {
      enableRotate: true,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
    });
    const { center, size: boundsSize } = boundsForPoints(points);
    const targetVector = center;
    const radius = Math.max(10, boundsSize.length() * 0.5 * FIT_PADDING);
    const distance = 'fov' in camera && !orthographicMode
      ? perspectiveFitDistance(points, targetVector, command.view, camera.fov, size.width, size.height)
      : Math.max(24, radius * 2.4);
    const startPosition = camera.position.clone();
    const endPosition = targetVector.clone().add(viewOffset(command.view, distance));
    const startTarget = controls?.target?.clone?.() ?? targetVector.clone();
    const startZoom = 'zoom' in camera ? camera.zoom : 1;
    const startUp = camera.up.clone();
    const endUp = cameraUp(command.view);
    const { spanX, spanY } = projectedSpans(points, targetVector, command.view);
    const fitZoom = Math.max(
      8,
      Math.min(120, Math.min(size.width / (spanX * FIT_PADDING), size.height / (spanY * FIT_PADDING)))
    );
    const durationMs = 640;
    const startedAt = performance.now();

    const animate = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = easeInOutCubic(t);
      camera.up.lerpVectors(startUp, endUp, eased).normalize();
      camera.position.lerpVectors(startPosition, endPosition, eased);
      if ('zoom' in camera) {
        camera.zoom = orthographicMode ? THREE.MathUtils.lerp(startZoom, fitZoom, eased) : 1;
      }
      camera.lookAt(targetVector);
      camera.updateProjectionMatrix();

      if (controls?.target) {
        controls.target.lerpVectors(startTarget, targetVector, eased);
        if (t >= 1) applyOrbitControlConstraints(controls, targetConstraints);
        controls.update();
      }

      if (t < 1) {
        animationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        applyOrbitControlConstraints(controls, targetConstraints);
        animationFrameRef.current = null;
      }
    };

    animationFrameRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [camera, command, controlsRef, orthographicMode, points, size.height, size.width]);

  return null;
};

const FollowCamera = ({
  controlsRef,
  enabled,
  fallbackTarget,
  focusPoint,
}: {
  controlsRef: React.RefObject<any>;
  enabled: boolean;
  fallbackTarget: [number, number, number];
  focusPoint: [number, number, number] | null;
}) => {
  const { camera } = useThree();
  const desiredTarget = useMemo(() => new THREE.Vector3(), []);
  const previousTarget = useMemo(() => new THREE.Vector3(), []);
  const movement = useMemo(() => new THREE.Vector3(), []);
  const viewOffsetVector = useMemo(() => new THREE.Vector3(), []);
  const desiredPosition = useMemo(() => new THREE.Vector3(), []);
  const previousFocus = useRef<THREE.Vector3 | null>(null);
  const lastAppliedDistance = useRef<number | null>(null);
  const manualDistance = useRef<number | null>(null);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!enabled || !controls?.target) {
      lastAppliedDistance.current = null;
      manualDistance.current = null;
      return;
    }

    desiredTarget.set(...(focusPoint ?? fallbackTarget));
    const focusSpeed = previousFocus.current && delta > 0
      ? previousFocus.current.distanceTo(desiredTarget) / delta
      : 0;
    previousFocus.current = desiredTarget.clone();
    const speedFactor = THREE.MathUtils.smoothstep(focusSpeed, 0, FOLLOW_SPEED_FOR_FAR_DISTANCE);
    const defaultFollowDistance = THREE.MathUtils.lerp(FOLLOW_CLOSE_DISTANCE, FOLLOW_FAR_DISTANCE, speedFactor);

    const currentDistance = camera.position.distanceTo(controls.target);
    if (
      lastAppliedDistance.current != null
      && Math.abs(currentDistance - lastAppliedDistance.current) > FOLLOW_MANUAL_DISTANCE_THRESHOLD
    ) {
      manualDistance.current = currentDistance;
    }
    const followDistance = manualDistance.current ?? defaultFollowDistance;

    previousTarget.copy(controls.target);
    controls.target.lerp(desiredTarget, 1 - Math.exp(-delta * FOLLOW_TARGET_SMOOTHING));
    movement.subVectors(controls.target, previousTarget);
    camera.position.add(movement);

    viewOffsetVector.subVectors(camera.position, controls.target);
    if (viewOffsetVector.lengthSq() > 0.0001) {
      desiredPosition.copy(controls.target).add(viewOffsetVector.normalize().multiplyScalar(followDistance));
      camera.position.lerp(desiredPosition, 1 - Math.exp(-delta * FOLLOW_DISTANCE_SMOOTHING));
      lastAppliedDistance.current = camera.position.distanceTo(controls.target);
    }

    controls.update();
  });

  return null;
};

const CameraHemisphereGuard = ({ controlsRef }: { controlsRef: React.RefObject<any> }) => {
  const { camera } = useThree();

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls?.target) return;
    const minY = controls.target.y;
    if (camera.position.y >= minY) return;

    camera.position.y = minY;
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    controls.update();
  });

  return null;
};

const CameraFit = ({
  controlsRef,
  points,
  orthographicMode,
}: {
  controlsRef: React.RefObject<any>;
  points: [number, number, number][];
  orthographicMode: boolean;
}) => {
  const { camera, size } = useThree();
  const hasFitInitialView = useRef(false);

  useEffect(() => {
    if (hasFitInitialView.current || !points.length) return;
    hasFitInitialView.current = true;

    const { center, size: boundsSize } = boundsForPoints(points);
    const radius = Math.max(10, boundsSize.length() * 0.5 * FIT_PADDING);
    const direction = new THREE.Vector3(...CAMERA_POSITION).normalize();
    camera.position.copy(center.clone().add(direction.multiplyScalar(radius * 2.2)));
    camera.up.set(0, 1, 0);
    camera.lookAt(center);

    if ('zoom' in camera) {
      const maxSpan = Math.max(boundsSize.x, boundsSize.y, boundsSize.z, 1);
      const nextZoom = Math.max(18, Math.min(72, Math.min(size.width, size.height) / (maxSpan * FIT_PADDING)));
      camera.zoom = orthographicMode ? nextZoom : 1;
    }

    if ('fov' in camera && !orthographicMode) {
      const distance = perspectiveFitDistance(points, center, 'iso', camera.fov, size.width, size.height);
      camera.position.copy(center.clone().add(direction.set(...CAMERA_POSITION).normalize().multiplyScalar(distance)));
    }

    camera.updateProjectionMatrix();

    const controls = controlsRef.current;
    if (controls?.target) {
      controls.target.copy(center);
      controls.update();
      controls.saveState?.();
    }
  }, [camera, controlsRef, orthographicMode, points, size.height, size.width]);

  return null;
};

const CameraProjectionBridge = ({
  controlsRef,
}: {
  controlsRef: React.RefObject<any>;
}) => {
  const { camera } = useThree();
  const previousCameraRef = useRef<THREE.Camera | null>(null);

  useLayoutEffect(() => {
    const previousCamera = previousCameraRef.current;
    const controls = controlsRef.current;

    if (previousCamera && previousCamera !== camera) {
      camera.position.copy(previousCamera.position);
      camera.up.copy(previousCamera.up);

      if (
        camera instanceof THREE.OrthographicCamera
        && previousCamera instanceof THREE.OrthographicCamera
      ) {
        camera.zoom = previousCamera.zoom;
      }

      if (controls?.target) {
        camera.lookAt(controls.target);
      }
      camera.updateProjectionMatrix();
      controls?.update?.();
    }

    previousCameraRef.current = camera;
  }, [camera, controlsRef]);

  return null;
};

const CameraStatePublisher = ({
  controlsRef,
  onCameraStateChange,
}: {
  controlsRef: React.RefObject<any>;
  onCameraStateChange?: (state: CameraSyncState) => void;
}) => {
  const { camera } = useThree();
  const lastSignatureRef = useRef('');

  useFrame(() => {
    if (!onCameraStateChange) return;
    const controls = controlsRef.current;
    if (!controls?.target) return;

    const state: CameraSyncState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
      zoom: 'zoom' in camera ? Number(camera.zoom) : 1,
    };
    const signature = [
      ...state.position,
      ...state.target,
      ...state.up,
      state.zoom,
    ].map((value) => value.toFixed(4)).join('|');

    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    onCameraStateChange(state);
  });

  return null;
};

const CameraSyncBridge = ({
  controlsRef,
  syncId,
  command,
}: {
  controlsRef: React.RefObject<any>;
  syncId: string;
  command?: CameraSyncCommand | null;
}) => {
  const { camera } = useThree();
  const lastAppliedId = useRef<number | null>(null);

  useEffect(() => {
    if (!command || command.sourceId === syncId || lastAppliedId.current === command.id) return;
    const controls = controlsRef.current;
    if (!controls?.target) return;

    const { state } = command;
    camera.position.set(...state.position);
    camera.up.set(...state.up);
    if ('zoom' in camera) camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
    controls.target.set(...state.target);
    controls.update();
    lastAppliedId.current = command.id;
  }, [camera, command, controlsRef, syncId]);

  return null;
};

interface ThreeSpaceProps {
  pieces: MusicPiece[];
  domainPieces?: MusicPiece[];
  selectedPiece: SpatialPiece | null;
  onSelect: (piece: SpatialPiece) => void;
  onDeselect: () => void;
  config: SpaceConfig;
  playbackState: PlaybackState | null;
  focusMode: boolean;
  orthographicMode: boolean;
  currentCameraView: CameraView;
  clusterMethod: ClusterMethod;
  cameraCommand: CameraViewCommand | null;
  onHoverChange: (piece: SpatialPiece | null, x: number, y: number) => void;
  syncId?: string;
  cameraSyncCommand?: CameraSyncCommand | null;
  onCameraSync?: (sourceId: string, state: CameraSyncState) => void;
  onCameraStateChange?: (state: CameraSyncState) => void;
  label?: string;
  relatedRecordFileName?: string | null;
}

const ThreeSpace = ({ pieces, domainPieces, selectedPiece, onSelect, onDeselect, config, playbackState, focusMode, orthographicMode, currentCameraView, clusterMethod, cameraCommand, onHoverChange, syncId = 'main', cameraSyncCommand, onCameraSync, onCameraStateChange, label, relatedRecordFileName }: ThreeSpaceProps) => {
  const controlsRef = useRef<any>(null);
  const controlsActiveRef = useRef(false);
  const cameraSyncFrameRef = useRef(0);
  const selectedRecordFileName = selectedPiece?.fileName ?? null;
  const cameraControlConstraints = orbitControlConstraints(orthographicMode, currentCameraView);

  const spatialModel = useMemo(() => {
    if (!pieces.length) return { pieces: [] as SpatialPiece[], scenePoints: [] as [number, number, number][] };

    const axes = [config.xAxis, config.yAxis, config.zAxis];
    const axisValue = (piece: MusicPiece, axis: string) => {
      if (axis.startsWith('feature:')) {
        return piece.selectedFeatureValues[axis.replace(/^feature:/, '')] ?? 0;
      }
      const value = piece[axis as keyof MusicPiece];
      return typeof value === 'number' ? value : 0;
    };

    const rangeSource = domainPieces?.length ? domainPieces : pieces;
    const ranges = axes.reduce((acc, axis, index) => {
        const values = rangeSource
          .map(piece => axisValue(piece, axis))
          .filter(Number.isFinite);
        acc[axis] = {
          min: quantile(values, DOMAIN_LOW_QUANTILE),
          max: quantile(values, DOMAIN_HIGH_QUANTILE),
          range: index === 2 ? HEIGHT_RANGE : PLANE_RANGE,
        };
        return acc;
      }, {} as Record<string, { min: number; max: number; range: [number, number] }>);

    const getVal = (piece: MusicPiece, axis: string) => {
      const val = axisValue(piece, axis);
      const range = ranges[axis];
      if (!range) return 0;
      return scaleToRange(val, range, range.range);
    };

    const positionPiece = (p: MusicPiece) => ({
      ...p,
      position: [
        getVal(p, config.xAxis),
        getVal(p, config.yAxis),
        getVal(p, config.zAxis)
      ] as [number, number, number],
      color: getClusterMethodColor(p, clusterMethod),
      activeClusterValue: getClusterValue(p, clusterMethod),
    });

    const positionedPieces = pieces.map(positionPiece);
    const sceneSource = domainPieces?.length ? domainPieces : pieces;
    return {
      pieces: positionedPieces,
      scenePoints: sceneSource.map(piece => toScenePosition(positionPiece(piece).position)),
    };
  }, [pieces, domainPieces, config, clusterMethod]);

  const positionedPieces = spatialModel.pieces;

  const trajectories = useMemo(() => {
    const groups = new Map<string, SpatialPiece[]>();
    for (const piece of positionedPieces as SpatialPiece[]) {
      const group = groups.get(piece.fileName) ?? [];
      group.push(piece);
      groups.set(piece.fileName, group);
    }

    return Array.from(groups.entries()).map(([fileName, group]) => {
      const pieces = [...group].sort((a, b) => labelSortKey(a.segmentLabel) - labelSortKey(b.segmentLabel));
      return {
        fileName,
        color: pieces[0]?.color ?? '#ffffff',
        pieces,
        points: pieces.map(piece => toScenePosition(piece.position)),
        colors: pieces.map(piece => piece.color),
      };
    }).filter(path => path.points.length > 1);
  }, [positionedPieces]);

  const nodePieces = useMemo(() => (
    (positionedPieces as SpatialPiece[]).map(piece => ({
      ...piece,
      position: toScenePosition(piece.position),
    }))
  ), [positionedPieces]);

  const selectedClusterValue = selectedPiece ? getClusterValue(selectedPiece, clusterMethod) : null;

  const selectedRepresentativePiece = useMemo(() => {
    if (!selectedPiece) return null;
    const representativeId = getClusterRepresentativeId(selectedPiece, clusterMethod);
    if (!representativeId) return null;
    return nodePieces.find(piece => piece.id === representativeId) ?? null;
  }, [clusterMethod, nodePieces, selectedPiece]);

  const scenePoints = spatialModel.scenePoints;

  const sceneCenter = useMemo<[number, number, number]>(() => {
    if (!scenePoints.length) return CAMERA_TARGET;
    const box = new THREE.Box3();
    scenePoints.forEach(point => box.expandByPoint(new THREE.Vector3(...point)));
    const center = box.getCenter(new THREE.Vector3());
    return [center.x, center.y, center.z];
  }, [scenePoints]);

  const activeTrajectory = useMemo(() => {
    if (!playbackState) return null;
    const trajectory = trajectories.find(path => path.fileName === playbackState.fileName);
    if (!trajectory) return null;

    const time = playbackState.currentTime;
    const piecesInPath = trajectory.pieces;
    let progress = 0;
    let focusPoint: [number, number, number] | null = trajectory.points[0] ?? null;

    const denominator = Math.max(1, piecesInPath.length);

    const lastPiece = piecesInPath[piecesInPath.length - 1];
    const lastEnd = lastPiece?.segmentEndSec ?? 0;

    // Clamp: if audio time is past all segments, keep last tube fully active
    if (lastEnd > 0 && time >= lastEnd) {
      progress = 1;
    } else {
      for (let i = 0; i < piecesInPath.length; i += 1) {
        const piece = piecesInPath[i];
        const nextPiece = piecesInPath[i + 1];
        const start = piece.segmentStartSec;
        const end = nextPiece?.segmentStartSec ?? piece.segmentEndSec;

        if (time >= start) progress = i / denominator;
        if (end != null && time >= end) {
          progress = (i + 1) / denominator;
          continue;
        }
        if (time >= start && (end == null || time < end)) {
          const localProgress = end != null && end > start ? (time - start) / (end - start) : 1;
          progress = (i + Math.max(0, Math.min(1, localProgress))) / denominator;
          break;
        }
      }
    }
    focusPoint = trajectoryPointAtProgress(trajectory.points, true, progress) ?? focusPoint;

    return {
      fileName: trajectory.fileName,
      color: trajectory.color,
      points: trajectory.points,
      colors: trajectory.colors,
      focusPoint,
      progress: Math.max(0.001, Math.min(1, progress)),
      opacity: playbackState.playing ? 0.72 : 0.46,
    };
  }, [playbackState, trajectories]);

  return (
    <div
      className="relative"
      style={{
        width: '100%',
        height: '100%',
        pointerEvents: 'auto',
      }}
    >
      <Canvas
        key={orthographicMode ? 'orthographic' : 'perspective'}
        orthographic={orthographicMode}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={
          orthographicMode
            ? { position: CAMERA_POSITION, zoom: 42, near: -1000, far: 1000 }
            : { position: CAMERA_POSITION, fov: PERSPECTIVE_FOV, near: 0.1, far: 1000 }
        }
        onCreated={({ gl, camera }) => {
          gl.setClearColor('#050505');
          camera.lookAt(...sceneCenter);
        }}
      >
        {orthographicMode && (
          <Stars radius={100} depth={50} count={2000} factor={4} saturation={0} fade speed={0.5} />
        )}
        
        <group>
          {trajectories.map((path) => {
            const isSelected = path.fileName === selectedRecordFileName;
            const isRelated = path.fileName === relatedRecordFileName;
            const hasFocus = Boolean(selectedRecordFileName || relatedRecordFileName);
            const isPlaybackRecord = path.fileName === playbackState?.fileName;
            const isPlaybackTube = path.fileName === activeTrajectory?.fileName;
            const radius = isSelected
              ? ACTIVE_TRAJECTORY_RADIUS
              : isRelated
                ? ACTIVE_TRAJECTORY_RADIUS * 0.52
                : TRAJECTORY_RADIUS;
            const opacity = hasFocus
              ? isSelected
                ? isPlaybackTube
                  ? SELECTED_TRAJECTORY_PIPE_OPACITY
                  : SELECTED_TRAJECTORY_OPACITY
                : isRelated
                  ? RELATED_TRAJECTORY_OPACITY
                  : DIMMED_TRAJECTORY_OPACITY
              : isPlaybackRecord
                ? 0.07
                : DEFAULT_TRAJECTORY_OPACITY;
            const radialSegments = isSelected ? SELECTED_TUBE_RADIAL_SEGMENTS : TUBE_RADIAL_SEGMENTS;
            const segmentsPerPoint = isSelected ? SELECTED_TUBE_SEGMENTS_PER_POINT : TUBE_SEGMENTS_PER_POINT;

            return (
              <React.Fragment key={path.fileName}>
                {(isSelected || isRelated) && (
                  <TrajectoryTube
                    points={path.points}
                    color="#ffffff"
                    radius={isSelected ? ACTIVE_TRAJECTORY_RADIUS * 1.75 : ACTIVE_TRAJECTORY_RADIUS * 0.82}
                    opacity={
                      isSelected
                        ? isPlaybackTube
                          ? SELECTED_TRAJECTORY_PIPE_HALO_OPACITY
                          : SELECTED_TRAJECTORY_HALO_OPACITY
                        : RELATED_TRAJECTORY_HALO_OPACITY
                    }
                    radialSegments={SELECTED_TUBE_RADIAL_SEGMENTS}
                    segmentsPerPoint={SELECTED_TUBE_SEGMENTS_PER_POINT}
                    depthTest={false}
                    renderOrder={isSelected ? 8 : 5}
                    closed
                  />
                )}
                <TrajectoryTube
                  points={path.points}
                  pointColors={path.colors}
                  color={path.color}
                  radius={radius}
                  opacity={opacity}
                  radialSegments={radialSegments}
                  segmentsPerPoint={segmentsPerPoint}
                  depthTest={!isSelected}
                  renderOrder={isSelected ? 9 : isRelated ? 6 : 0}
                  closed
                />
              </React.Fragment>
            );
          })}

          {activeTrajectory && activeTrajectory.points.length > 1 && (
            <>
              <TrajectoryTube
                points={activeTrajectory.points}
                color="#ffffff"
                radius={ACTIVE_TRAJECTORY_RADIUS * 1.08}
                opacity={0.18}
                progress={activeTrajectory.progress}
                radialSegments={SELECTED_TUBE_RADIAL_SEGMENTS}
                segmentsPerPoint={SELECTED_TUBE_SEGMENTS_PER_POINT}
                depthTest={false}
                renderOrder={10}
                closed
              />
              <TrajectoryTube
                points={activeTrajectory.points}
                pointColors={activeTrajectory.colors}
                color={activeTrajectory.color}
                radius={ACTIVE_TRAJECTORY_RADIUS * 0.78}
                opacity={1}
                progress={activeTrajectory.progress}
                radialSegments={SELECTED_TUBE_RADIAL_SEGMENTS}
                segmentsPerPoint={SELECTED_TUBE_SEGMENTS_PER_POINT}
                depthTest={false}
                renderOrder={11}
                closed
              />
              <ActiveEndpointGlow position={activeTrajectory.focusPoint} />
            </>
          )}

          <NodeInstances
            pieces={nodePieces}
            playbackState={playbackState}
            selectedRecordFileName={selectedRecordFileName}
            selectedClusterValue={selectedClusterValue}
            controlsActiveRef={controlsActiveRef}
            onSelect={onSelect}
            onDeselect={onDeselect}
            onHoverChange={onHoverChange}
          />
          <ClusterRepresentativeMarker piece={selectedRepresentativePiece} />
        </group>

        <OrbitControls
          ref={controlsRef}
          makeDefault
          onStart={() => {
            controlsActiveRef.current = true;
          }}
          onEnd={() => {
            controlsActiveRef.current = false;
          }}
          onChange={() => {
            const controls = controlsRef.current;
            const camera = controls?.object as THREE.Camera | undefined;
            if (!controls?.target || !camera) return;
            const state: CameraSyncState = {
              position: [camera.position.x, camera.position.y, camera.position.z],
              target: [controls.target.x, controls.target.y, controls.target.z],
              up: [camera.up.x, camera.up.y, camera.up.z],
              zoom: 'zoom' in camera ? Number(camera.zoom) : 1,
            };
            onCameraStateChange?.(state);
            if (!controlsActiveRef.current || !onCameraSync) return;
            cameraSyncFrameRef.current += 1;
            if (cameraSyncFrameRef.current % 2 !== 0) return;
            onCameraSync(syncId, state);
          }}
          enableDamping={true}
          dampingFactor={0.075}
          target={sceneCenter}
          rotateSpeed={0.46}
          zoomSpeed={0.5}
          panSpeed={0.5}
          enablePan={true}
          enableRotate={cameraControlConstraints.enableRotate}
          screenSpacePanning={true}
          mouseButtons={{
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN,
          }}
          touches={{
            ONE: THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_PAN,
          }}
          minPolarAngle={cameraControlConstraints.minPolarAngle}
          maxPolarAngle={cameraControlConstraints.maxPolarAngle}
          maxDistance={260}
          minDistance={0.35}
          minZoom={1}
          maxZoom={320}
        />
        <CameraProjectionBridge controlsRef={controlsRef} />
        <CameraStatePublisher
          controlsRef={controlsRef}
          onCameraStateChange={onCameraStateChange}
        />
        {orthographicMode && <CameraHemisphereGuard controlsRef={controlsRef} />}
        <CameraFit
          controlsRef={controlsRef}
          points={scenePoints}
          orthographicMode={orthographicMode}
        />
        <CameraSyncBridge
          controlsRef={controlsRef}
          syncId={syncId}
          command={cameraSyncCommand}
        />
        <FollowCamera
          controlsRef={controlsRef}
          enabled={focusMode}
          fallbackTarget={sceneCenter}
          focusPoint={activeTrajectory?.focusPoint ?? null}
        />
        <CameraCommandHandler
          controlsRef={controlsRef}
          points={scenePoints}
          command={cameraCommand}
          orthographicMode={orthographicMode}
        />
      
      {/* t-SNE X/Y reference plane */}
      <gridHelper args={[56, 56, GRID_COLOR, '#080808']} position={[0, AXIS_MIN, 0]} />
      
      {/* Coordinate frame */}
      <group>
         <Line points={[[AXIS_MIN, AXIS_MIN, 0], [AXIS_MAX, AXIS_MIN, 0]]} color={AXIS_COLOR} lineWidth={1.8} transparent opacity={0.85} />
         <Line points={[[0, AXIS_MIN, AXIS_MIN], [0, AXIS_MIN, AXIS_MAX]]} color={AXIS_COLOR} lineWidth={1.8} transparent opacity={0.85} />
         <Line points={[[0, AXIS_MIN, 0], [0, AXIS_MAX, 0]]} color={AXIS_Z_COLOR} lineWidth={2} transparent opacity={0.8} />

         <Text position={[AXIS_MAX + 1.4, AXIS_MIN + 0.02, 0]} fontSize={0.48} color={AXIS_LABEL_COLOR} rotation={[-Math.PI / 2, 0, 0]} anchorX="left" anchorY="middle">{planeAxisLabel(config.xAxis).toUpperCase()}</Text>
         <Text position={[0, AXIS_MIN + 0.02, AXIS_MAX + 1.4]} fontSize={0.48} color={AXIS_LABEL_COLOR} rotation={[-Math.PI / 2, 0, 0]} anchorX="left" anchorY="middle">{planeAxisLabel(config.yAxis).toUpperCase()}</Text>
         <Text position={[0.35, AXIS_MAX + 1.1, 0]} fontSize={0.52} color={AXIS_LABEL_COLOR} rotation={[0, 0, 0]} anchorX="left" anchorY="middle">{axisLabel(config.zAxis).toUpperCase()}</Text>
      </group>
      </Canvas>
      {label && (
        <div className="pointer-events-none absolute left-4 top-4 rounded border border-white/10 bg-black/45 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/58 backdrop-blur-md">
          {label}
          <span className="ml-2 text-white/28">{pieces.length} segments</span>
        </div>
      )}
    </div>
  );
};

export default ThreeSpace;
