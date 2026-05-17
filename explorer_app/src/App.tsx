import React, { useEffect, useState, useCallback, useMemo } from 'react';
import ThreeSpace from './components/ThreeSpace';
import UIOverlay from './components/UIOverlay';
import GalleryView from './components/GalleryView';
import { Camera } from 'lucide-react';
import { buildThumbnailProjectionModel, ThumbnailProjectionModel } from './components/TsneTrajectoryThumbnail';
import { CameraSyncCommand, CameraSyncState, CameraView, CameraViewCommand, ComposerCompareSummary, MusicPiece, PlaybackState, SimilarMatchWeights, SimilarRecordMatch, SpatialPiece, SpaceConfig, ThumbnailProjectionConfig, ThumbnailProjectionPlane } from './types';
import { parseCSV, processSpatialData, getUniquePeriods, getSelectedFeatureNames } from './utils/dataProcessor';
import { ClusterMethod, getClusterValue } from './utils/clusterMethods';
import csvText from './data/segment_visualization.csv?raw';

const DEFAULT_MATCH_WEIGHTS: SimilarMatchWeights = {
  shape: 0.55,
  position: 0.3,
  cluster: 0.15,
};

const thumbnailPlaneFromCameraView = (view: CameraView): ThumbnailProjectionPlane => {
  if (view === 'side') return 'xz';
  if (view === 'front') return 'yz';
  return 'xy';
};

const normalizeMatchWeights = (weights: SimilarMatchWeights): SimilarMatchWeights => {
  const shape = Math.max(0, weights.shape);
  const position = Math.max(0, weights.position);
  const cluster = Math.max(0, weights.cluster);
  const total = shape + position + cluster;
  if (total <= 0) return DEFAULT_MATCH_WEIGHTS;
  return {
    shape: shape / total,
    position: position / total,
    cluster: cluster / total,
  };
};

export default function App() {
  const [pieces, setPieces] = useState<SpatialPiece[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [selectedPiece, setSelectedPiece] = useState<SpatialPiece | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activePeriod, setActivePeriod] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [orthographicMode, setOrthographicMode] = useState(true);
  const [currentCameraView, setCurrentCameraView] = useState<CameraView>('iso');
  const [clusterMethod, setClusterMethod] = useState<ClusterMethod>('kmedoids');
  const [cameraCommand, setCameraCommand] = useState<CameraViewCommand | null>(null);
  const [cameraSyncCommand, setCameraSyncCommand] = useState<CameraSyncCommand | null>(null);
  const [hoveredPiece, setHoveredPiece] = useState<SpatialPiece | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [compareMode, setCompareMode] = useState(false);
  const [galleryMode, setGalleryMode] = useState(false);
  const [compareComposerA, setCompareComposerA] = useState('');
  const [compareComposerB, setCompareComposerB] = useState('');
  const [friendlyMode, setFriendlyMode] = useState(true);
  const [similarMatchWeights, setSimilarMatchWeights] = useState<SimilarMatchWeights>(DEFAULT_MATCH_WEIGHTS);
  const [spaceConfig, setSpaceConfig] = useState<SpaceConfig>({
    xAxis: 'tsneX',
    yAxis: 'tsneY',
    zAxis: '',
  });
  const [thumbnailProjection, setThumbnailProjection] = useState<ThumbnailProjectionConfig>({
    plane: 'xy',
    zAxis: '',
    capturedView: 'top',
    camera: null,
  });
  const [thumbnailProjectionModel, setThumbnailProjectionModel] = useState<ThumbnailProjectionModel | null>(null);
  const [currentCameraState, setCurrentCameraState] = useState<CameraSyncState | null>(null);
  const [snapshotFlash, setSnapshotFlash] = useState(false);

  const activeCompareFeature = spaceConfig.zAxis.startsWith('feature:')
    ? spaceConfig.zAxis.replace(/^feature:/, '')
    : selectedFeatures[0] ?? '';
  const liveThumbnailProjection = useMemo<ThumbnailProjectionConfig>(() => ({
    plane: thumbnailPlaneFromCameraView(currentCameraView),
    zAxis: spaceConfig.zAxis || 'selectedFeatureNorm',
    capturedView: currentCameraView,
    camera: currentCameraState,
  }), [currentCameraState, currentCameraView, spaceConfig.zAxis]);

  const groupRecords = useCallback((recordPieces: SpatialPiece[]) => {
    const groups = new Map<string, SpatialPiece[]>();
    recordPieces.forEach((piece) => {
      const group = groups.get(piece.fileName) ?? [];
      group.push(piece);
      groups.set(piece.fileName, group);
    });
    return groups;
  }, []);

  const trajectoryPoint = useCallback((piece: SpatialPiece): [number, number, number] => [
    piece.tsneX,
    piece.tsneY,
    activeCompareFeature ? piece.selectedFeatureValues[activeCompareFeature] ?? 0 : piece.selectedFeatureNorm,
  ], [activeCompareFeature]);

  const recordCentroid = useCallback((recordPieces: SpatialPiece[]) => {
    if (!recordPieces.length) return null;
    const sum = recordPieces.reduce<[number, number, number]>((acc, piece) => {
      const point = trajectoryPoint(piece);
      return [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]];
    }, [0, 0, 0]);
    return sum.map(value => value / recordPieces.length) as [number, number, number];
  }, [trajectoryPoint]);

  const centroidDistance = useCallback((a: [number, number, number] | null, b: [number, number, number] | null) => {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }, []);

  const clusterSequence = useCallback((recordPieces: SpatialPiece[]) => (
    [...recordPieces]
      .sort((a, b) => a.segmentStartSec - b.segmentStartSec)
      .map(piece => getClusterValue(piece, clusterMethod))
  ), [clusterMethod]);

  const clusterSequenceDistance = useCallback((a: (number | null)[], b: (number | null)[]) => {
    const count = Math.max(a.length, b.length);
    if (!count) return 1;
    let mismatches = 0;
    for (let index = 0; index < count; index += 1) {
      if ((a[index] ?? null) !== (b[index] ?? null)) mismatches += 1;
    }
    return mismatches / count;
  }, []);

  const resampleTrajectory = useCallback((recordPieces: SpatialPiece[], samples = 16) => {
    const sorted = [...recordPieces].sort((a, b) => a.segmentStartSec - b.segmentStartSec);
    const points = sorted.map(trajectoryPoint);
    if (points.length < 2) return null;

    const lengths: number[] = [0];
    for (let index = 1; index < points.length; index += 1) {
      const prev = points[index - 1];
      const current = points[index];
      lengths.push(lengths[index - 1] + Math.hypot(
        current[0] - prev[0],
        current[1] - prev[1],
        current[2] - prev[2]
      ));
    }

    const total = lengths[lengths.length - 1];
    if (!Number.isFinite(total) || total <= 0) return null;

    const resampled: [number, number, number][] = [];
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      const target = (sampleIndex / Math.max(1, samples - 1)) * total;
      let segmentIndex = 1;
      while (segmentIndex < lengths.length - 1 && lengths[segmentIndex] < target) segmentIndex += 1;
      const prevLength = lengths[segmentIndex - 1];
      const nextLength = lengths[segmentIndex];
      const t = nextLength > prevLength ? (target - prevLength) / (nextLength - prevLength) : 0;
      const prev = points[segmentIndex - 1];
      const next = points[segmentIndex];
      resampled.push([
        prev[0] + ((next[0] - prev[0]) * t),
        prev[1] + ((next[1] - prev[1]) * t),
        prev[2] + ((next[2] - prev[2]) * t),
      ]);
    }

    const centroid = resampled.reduce<[number, number, number]>(
      (sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]],
      [0, 0, 0]
    ).map(value => value / resampled.length) as [number, number, number];
    const centered = resampled.map<[number, number, number]>(point => [
      point[0] - centroid[0],
      point[1] - centroid[1],
      point[2] - centroid[2],
    ]);
    const scale = Math.sqrt(centered.reduce((sum, point) => (
      sum + point[0] ** 2 + point[1] ** 2 + point[2] ** 2
    ), 0) / centered.length) || 1;

    return centered.map<[number, number, number]>(point => [
      point[0] / scale,
      point[1] / scale,
      point[2] / scale,
    ]);
  }, [trajectoryPoint]);

  const trajectoryDistance = useCallback((a: [number, number, number][], b: [number, number, number][]) => {
    const count = Math.min(a.length, b.length);
    if (!count) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let index = 0; index < count; index += 1) {
      sum += Math.hypot(
        a[index][0] - b[index][0],
        a[index][1] - b[index][1],
        a[index][2] - b[index][2]
      ) ** 2;
    }
    return Math.sqrt(sum / count);
  }, []);

  const filteredPieces = useMemo(() => {
    return pieces.filter(p => {
      const matchesSearch = p.musicName.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          p.composer.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesPeriod = !activePeriod || p.period === activePeriod;
      return matchesSearch && matchesPeriod;
    });
  }, [pieces, searchQuery, activePeriod]);

  const composerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    pieces.forEach(piece => {
      counts.set(piece.composer, (counts.get(piece.composer) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([composer, count]) => ({ composer, count }));
  }, [pieces]);

  useEffect(() => {
    if (!composerOptions.length) return;
    setCompareComposerA(prev => prev || composerOptions[0]?.composer || '');
    setCompareComposerB(prev => prev || composerOptions.find(option => option.composer !== composerOptions[0]?.composer)?.composer || '');
  }, [composerOptions]);

  const comparePiecesA = useMemo(() => (
    pieces.filter(piece => (
      piece.composer === compareComposerA
      && (!activePeriod || piece.period === activePeriod)
    ))
  ), [activePeriod, compareComposerA, pieces]);

  const comparePiecesB = useMemo(() => (
    pieces.filter(piece => (
      piece.composer === compareComposerB
      && (!activePeriod || piece.period === activePeriod)
    ))
  ), [activePeriod, compareComposerB, pieces]);

  const compareDomainPieces = useMemo(() => (
    [...comparePiecesA, ...comparePiecesB]
  ), [comparePiecesA, comparePiecesB]);

  const buildCompareSummary = useCallback((composer: string, composerPieces: SpatialPiece[]): ComposerCompareSummary => {
    const records = new Set(composerPieces.map(piece => piece.fileName));
    const themeCount = composerPieces.filter(piece => piece.segmentLabel === 'T').length;
    const clusterCounts = new Map<number, number>();
    let featureNormSum = 0;
    let featureRawSum = 0;

    composerPieces.forEach((piece) => {
      const cluster = getClusterValue(piece, clusterMethod);
      if (cluster !== null && cluster !== undefined) {
        clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
      }
      featureNormSum += activeCompareFeature ? piece.selectedFeatureValues[activeCompareFeature] ?? 0 : piece.selectedFeatureNorm;
      featureRawSum += activeCompareFeature ? piece.selectedFeatureRawValues[activeCompareFeature] ?? 0 : piece.selectedFeatureValue;
    });

    const dominant = Array.from(clusterCounts.entries()).sort((a, b) => b[1] - a[1])[0];

    const recordGroups = new Map<string, SpatialPiece[]>();
    composerPieces.forEach((piece) => {
      const group = recordGroups.get(piece.fileName) ?? [];
      group.push(piece);
      recordGroups.set(piece.fileName, group);
    });

    const trajectoryLengths = Array.from(recordGroups.values()).map((group) => {
      const sorted = [...group].sort((a, b) => a.segmentStartSec - b.segmentStartSec);
      let length = 0;
      for (let index = 1; index < sorted.length; index += 1) {
        const prev = sorted[index - 1];
        const current = sorted[index];
        const prevZ = activeCompareFeature ? prev.selectedFeatureValues[activeCompareFeature] ?? 0 : prev.selectedFeatureNorm;
        const currentZ = activeCompareFeature ? current.selectedFeatureValues[activeCompareFeature] ?? 0 : current.selectedFeatureNorm;
        length += Math.hypot(
          current.tsneX - prev.tsneX,
          current.tsneY - prev.tsneY,
          currentZ - prevZ
        );
      }
      return length;
    }).filter(Number.isFinite);

    const segmentCount = composerPieces.length;
    return {
      composer,
      segmentCount,
      recordCount: records.size,
      themeShare: segmentCount ? themeCount / segmentCount : 0,
      dominantCluster: dominant?.[0] ?? null,
      dominantClusterShare: segmentCount && dominant ? dominant[1] / segmentCount : 0,
      avgFeatureNorm: segmentCount ? featureNormSum / segmentCount : 0,
      avgFeatureRaw: segmentCount ? featureRawSum / segmentCount : 0,
      avgTrajectoryLength: trajectoryLengths.length
        ? trajectoryLengths.reduce((sum, value) => sum + value, 0) / trajectoryLengths.length
        : 0,
    };
  }, [activeCompareFeature, clusterMethod, selectedFeatures]);

  const compareSummaryA = useMemo(() => (
    buildCompareSummary(compareComposerA, comparePiecesA)
  ), [buildCompareSummary, compareComposerA, comparePiecesA]);

  const compareSummaryB = useMemo(() => (
    buildCompareSummary(compareComposerB, comparePiecesB)
  ), [buildCompareSummary, compareComposerB, comparePiecesB]);

  const similarRecordMatch = useMemo<SimilarRecordMatch | null>(() => {
    if (!compareMode || !selectedPiece) return null;
    const sourceSide = selectedPiece.composer === compareComposerA
      ? 'left'
      : selectedPiece.composer === compareComposerB
        ? 'right'
        : null;
    if (!sourceSide) return null;

    const sourcePieces = sourceSide === 'left' ? comparePiecesA : comparePiecesB;
    const targetPieces = sourceSide === 'left' ? comparePiecesB : comparePiecesA;
    const sourceRecord = groupRecords(sourcePieces).get(selectedPiece.fileName);
    if (!sourceRecord || sourceRecord.length < 2 || targetPieces.length < 2) return null;

    const sourceTrajectory = resampleTrajectory(sourceRecord);
    if (!sourceTrajectory) return null;
    const sourceCentroid = recordCentroid(sourceRecord);
    const sourceClusters = clusterSequence(sourceRecord);

    let best: {
      fileName: string;
      pieces: SpatialPiece[];
      shapeDistance: number;
      positionDistance: number;
      clusterDistance: number;
      combinedDistance: number;
    } | null = null;

    const candidates: Array<{
      fileName: string;
      pieces: SpatialPiece[];
      shapeDistance: number;
      positionDistance: number;
      clusterDistance: number;
    }> = [];

    for (const [fileName, candidatePieces] of groupRecords(targetPieces)) {
      if (candidatePieces.length < 2) continue;
      const candidateTrajectory = resampleTrajectory(candidatePieces);
      if (!candidateTrajectory) continue;
      const shapeDistance = trajectoryDistance(sourceTrajectory, candidateTrajectory);
      const positionDistance = centroidDistance(sourceCentroid, recordCentroid(candidatePieces));
      const clusterDistance = clusterSequenceDistance(sourceClusters, clusterSequence(candidatePieces));
      if (![shapeDistance, positionDistance, clusterDistance].every(Number.isFinite)) continue;
      candidates.push({ fileName, pieces: candidatePieces, shapeDistance, positionDistance, clusterDistance });
    }

    const maxShape = Math.max(...candidates.map(candidate => candidate.shapeDistance), 0.0001);
    const maxPosition = Math.max(...candidates.map(candidate => candidate.positionDistance), 0.0001);
    const weights = normalizeMatchWeights(similarMatchWeights);

    candidates.forEach((candidate) => {
      const combinedDistance = (
        weights.shape * (candidate.shapeDistance / maxShape)
        + weights.position * (candidate.positionDistance / maxPosition)
        + weights.cluster * candidate.clusterDistance
      );
      if (!best || combinedDistance < best.combinedDistance) {
        best = { ...candidate, combinedDistance };
      }
    });

    if (!best) return null;
    const targetRepresentative = [...best.pieces].sort((a, b) => a.segmentStartSec - b.segmentStartSec)[0];
    const score = Math.max(0, Math.min(1, 1 / (1 + best.combinedDistance)));

    return {
      sourceFileName: selectedPiece.fileName,
      sourceMusicName: selectedPiece.musicName,
      sourceComposer: selectedPiece.composer,
      sourceSide,
      targetFileName: best.fileName,
      targetMusicName: targetRepresentative?.musicName ?? best.fileName,
      targetComposer: targetRepresentative?.composer ?? '',
      targetSegmentCount: best.pieces.length,
      targetRepresentativeId: targetRepresentative?.id ?? '',
      shapeDistance: best.shapeDistance,
      positionDistance: best.positionDistance,
      clusterDistance: best.clusterDistance,
      combinedDistance: best.combinedDistance,
      score,
    };
  }, [
    centroidDistance,
    clusterSequence,
    clusterSequenceDistance,
    compareComposerA,
    compareComposerB,
    compareMode,
    comparePiecesA,
    comparePiecesB,
    groupRecords,
    recordCentroid,
    resampleTrajectory,
    selectedPiece,
    similarMatchWeights,
    trajectoryDistance,
  ]);

  useEffect(() => {
    try {
      const parsedData = parseCSV(csvText);
      const spatialData = processSpatialData(parsedData);
      const featureNames = getSelectedFeatureNames(parsedData);
      setPeriods(getUniquePeriods(parsedData));
      setSelectedFeatures(featureNames);
      setSpaceConfig(prev => ({
        ...prev,
        xAxis: 'tsneX',
        yAxis: 'tsneY',
        zAxis: prev.zAxis || (featureNames[0] ? `feature:${featureNames[0]}` : 'selectedFeatureNorm'),
      }));
      setThumbnailProjection(prev => ({
        ...prev,
        zAxis: prev.zAxis || (featureNames[0] ? `feature:${featureNames[0]}` : 'selectedFeatureNorm'),
      }));
      setPieces(spatialData);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSelect = useCallback((piece: SpatialPiece) => {
    setSelectedPiece(piece);
  }, []);

  const handleHoverChange = useCallback((piece: SpatialPiece | null, x: number, y: number) => {
    setHoveredPiece(piece);
    if (piece) setHoverPos({ x, y });
  }, []);

  const handleCloseDetails = useCallback(() => {
    setSelectedPiece(null);
    setPlaybackState(null);
  }, []);

  const handleCameraView = useCallback((view: CameraView) => {
    setCurrentCameraView(view);
    setCameraCommand({ view, id: Date.now() });
  }, []);

  const handleSnapshotThumbnailProjection = useCallback(() => {
    setThumbnailProjection(liveThumbnailProjection);
    setThumbnailProjectionModel(buildThumbnailProjectionModel(pieces, liveThumbnailProjection));
    setSnapshotFlash(false);
    window.setTimeout(() => setSnapshotFlash(true), 0);
    window.setTimeout(() => setSnapshotFlash(false), 360);
  }, [liveThumbnailProjection, pieces]);

  useEffect(() => {
    if (isLoading || focusMode) return;
    setCameraCommand({ view: currentCameraView, id: Date.now() });
  }, [currentCameraView, focusMode, isLoading, orthographicMode]);

  const handleCameraSync = useCallback((sourceId: string, state: CameraSyncState) => {
    setCameraSyncCommand({ sourceId, state, id: Date.now() });
  }, []);

  const handleGalleryModeChange = useCallback((enabled: boolean) => {
    const cameraState = currentCameraState;
    setGalleryMode(enabled);
    if (!enabled || !cameraState) return;

    const preserveCamera = () => {
      setCameraSyncCommand({
        sourceId: 'gallery-preserve',
        state: cameraState,
        id: Date.now(),
      });
    };
    preserveCamera();
    window.requestAnimationFrame(preserveCamera);
  }, [currentCameraState]);

  const selectedPieceA = comparePiecesA.some(piece => piece.id === selectedPiece?.id) ? selectedPiece : null;
  const selectedPieceB = comparePiecesB.some(piece => piece.id === selectedPiece?.id) ? selectedPiece : null;
  const bottomPanelHeight = selectedPiece
    ? compareMode && similarRecordMatch ? 184 : 144
    : 0;

  if (isLoading) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center font-sans">
        <div className="space-y-4 text-center">
          <div className="w-12 h-[1px] bg-white/20 mx-auto overflow-hidden">
             <div className="w-full h-full bg-white animate-slide-right" />
          </div>
          <p className="text-[10px] uppercase tracking-[0.4em] opacity-40">Loading Archive</p>
        </div>
        <style>{`
          @keyframes slide-right {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
          }
          .animate-slide-right {
            animation: slide-right 1.5s infinite ease-in-out;
          }
        `}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center font-sans p-8">
        <div className="max-w-md space-y-4 text-center">
          <p className="text-red-500/80 text-sm font-mono">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="text-[10px] uppercase tracking-[0.2em] border border-white/10 px-4 py-2 rounded hover:bg-white/5 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="relative w-screen h-screen bg-black overflow-hidden">
      {/* Background Atmosphere */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-50">
        <div className="absolute top-[20%] left-[10%] w-[40vw] h-[40vw] bg-orange-900/20 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[10%] right-[10%] w-[30vw] h-[30vw] bg-white/5 blur-[100px] rounded-full animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div
        className="absolute right-0 top-0 overflow-hidden"
        style={{
          left: 400,
          bottom: bottomPanelHeight,
        }}
      >
        {compareMode && compareComposerA && compareComposerB ? (
          <div className="absolute inset-0 grid grid-cols-2">
            <div className="relative min-w-0 border-r border-white/10">
              <ThreeSpace
                pieces={comparePiecesA}
                domainPieces={compareDomainPieces}
                selectedPiece={selectedPieceA}
                onSelect={handleSelect}
                onDeselect={handleCloseDetails}
                config={spaceConfig}
                playbackState={playbackState}
                focusMode={focusMode}
                orthographicMode={orthographicMode}
                currentCameraView={currentCameraView}
                clusterMethod={clusterMethod}
                cameraCommand={cameraCommand}
                cameraSyncCommand={cameraSyncCommand}
                onCameraSync={handleCameraSync}
                onCameraStateChange={setCurrentCameraState}
                syncId="compare-a"
                label={compareComposerA}
                relatedRecordFileName={similarRecordMatch?.sourceSide === 'right' ? similarRecordMatch.targetFileName : null}
                onHoverChange={handleHoverChange}
              />
            </div>
            <div className="relative min-w-0">
              <ThreeSpace
                pieces={comparePiecesB}
                domainPieces={compareDomainPieces}
                selectedPiece={selectedPieceB}
                onSelect={handleSelect}
                onDeselect={handleCloseDetails}
                config={spaceConfig}
                playbackState={playbackState}
                focusMode={focusMode}
                orthographicMode={orthographicMode}
                currentCameraView={currentCameraView}
                clusterMethod={clusterMethod}
                cameraCommand={cameraCommand}
                cameraSyncCommand={cameraSyncCommand}
                onCameraSync={handleCameraSync}
                onCameraStateChange={setCurrentCameraState}
                syncId="compare-b"
                label={compareComposerB}
                relatedRecordFileName={similarRecordMatch?.sourceSide === 'left' ? similarRecordMatch.targetFileName : null}
                onHoverChange={handleHoverChange}
              />
            </div>
          </div>
        ) : (
          <ThreeSpace
            pieces={filteredPieces}
            selectedPiece={selectedPiece}
            onSelect={handleSelect}
            onDeselect={handleCloseDetails}
            config={spaceConfig}
            playbackState={playbackState}
            focusMode={focusMode}
            orthographicMode={orthographicMode}
            currentCameraView={currentCameraView}
            clusterMethod={clusterMethod}
            cameraCommand={cameraCommand}
            cameraSyncCommand={cameraSyncCommand}
            onCameraStateChange={setCurrentCameraState}
            onHoverChange={handleHoverChange}
          />
        )}
      </div>

      {galleryMode && (
        <GalleryView
          pieces={pieces}
          thumbnailProjection={thumbnailProjection}
          thumbnailProjectionModel={thumbnailProjectionModel}
          onClose={() => setGalleryMode(false)}
          onSelect={handleSelect}
        />
      )}

      {selectedPiece && !galleryMode && (
        <>
          <div
            className={`pointer-events-none absolute top-0 right-0 z-20 bg-white transition-opacity duration-500 ${
              snapshotFlash ? 'opacity-75' : 'opacity-0'
            }`}
            style={{
              left: 400,
              bottom: bottomPanelHeight,
            }}
          />
          <div
            className="pointer-events-none absolute right-0 z-30 flex justify-center"
            style={{
              left: 400,
              bottom: bottomPanelHeight + 20,
            }}
          >
            <button
              type="button"
              onClick={handleSnapshotThumbnailProjection}
              title="Snapshot this live 3D view into the gallery"
              className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/58 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/62 shadow-2xl shadow-black/30 backdrop-blur-xl transition-all hover:border-white/28 hover:bg-white/12 hover:text-white/92 active:scale-95"
            >
              <Camera size={14} />
              Snapshot View
            </button>
          </div>
        </>
      )}

      <UIOverlay
          selectedPiece={selectedPiece}
          pieces={pieces}
          onClose={handleCloseDetails}
          piecesCount={compareMode ? comparePiecesA.length + comparePiecesB.length : filteredPieces.length}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          activePeriod={activePeriod}
          setActivePeriod={setActivePeriod}
          availablePeriods={periods}
          config={spaceConfig}
          onUpdateConfig={(updates) => setSpaceConfig(prev => ({
            ...prev,
            ...updates,
            xAxis: 'tsneX',
            yAxis: 'tsneY',
          }))}
          selectedFeatures={selectedFeatures}
          onPlaybackUpdate={setPlaybackState}
          focusMode={focusMode}
          setFocusMode={setFocusMode}
          setOrthographicMode={setOrthographicMode}
          currentCameraView={currentCameraView}
          clusterMethod={clusterMethod}
          setClusterMethod={setClusterMethod}
          onCameraView={handleCameraView}
          hoveredPiece={hoveredPiece}
          hoverPos={hoverPos}
          compareMode={compareMode}
          setCompareMode={setCompareMode}
          galleryMode={galleryMode}
          setGalleryMode={handleGalleryModeChange}
          composerOptions={composerOptions}
          compareComposerA={compareComposerA}
          setCompareComposerA={setCompareComposerA}
          compareComposerB={compareComposerB}
          setCompareComposerB={setCompareComposerB}
          compareSummaryA={compareSummaryA}
          compareSummaryB={compareSummaryB}
          activeCompareFeature={activeCompareFeature}
          similarRecordMatch={similarRecordMatch}
          similarMatchWeights={similarMatchWeights}
          setSimilarMatchWeights={setSimilarMatchWeights}
          thumbnailProjection={liveThumbnailProjection}
          friendlyMode={friendlyMode}
          setFriendlyMode={setFriendlyMode}
          onSelectRecordById={(id) => {
            const next = pieces.find(piece => piece.id === id);
            if (next) handleSelect(next);
          }}
        />

      {/* Atmospheric Vignette */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,transparent_20%,rgba(0,0,0,0.8)_100%)]" />
    </main>
  );
}
