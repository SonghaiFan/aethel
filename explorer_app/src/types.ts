export type Period = 'Baroque' | 'Classical' | 'Romantic' | 'Modern' | 'Renaissance' | string;

export interface MusicPiece {
  id: string;
  folder: string;
  fileName: string;
  audioSrc: string;
  segmentLabel: string;
  segmentStartSec: number;
  segmentEndSec: number;
  segmentDurationSec: number;
  length: number; // minutes
  musicName: string;
  composer: string;
  period: Period;
  periodVal: number; // For sorting/mapping
  boundary: string;
  label: string;
  segments: { time: number; label: string }[];
  chord: string;
  link: string;
  variationNum: number;
  instrument: string;
  note: string;
  tsneX: number;
  tsneY: number;
  clusterKm: number | null;
  clusterKmedoids: number | null;
  clusterWard: number | null;
  clusterHdbscan: number | null;
  clusterHdbscanSub: number | null;
  clusterHdbscanNested: string;
  hdbscanStrength: number;
  hdbscanSubStrength: number;
  hdbscanSubIsOutlier: boolean;
  hdbscanMajorCluster: number | null;
  isOutlier: boolean;
  clusterKmSize: number | null;
  clusterKmedoidsSize: number | null;
  clusterWardSize: number | null;
  clusterHdbscanSize: number | null;
  clusterHdbscanSubSize: number | null;
  clusterKmRepresentativeId: string;
  clusterKmedoidsRepresentativeId: string;
  clusterWardRepresentativeId: string;
  clusterHdbscanRepresentativeId: string;
  clusterHdbscanSubRepresentativeId: string;
  clusterKmDistanceToRepresentative: number | null;
  clusterKmedoidsDistanceToRepresentative: number | null;
  clusterWardDistanceToRepresentative: number | null;
  clusterHdbscanDistanceToRepresentative: number | null;
  clusterHdbscanSubDistanceToRepresentative: number | null;
  clusterRepresentative: string;
  clusterRepresentativeDistance: number | null;
  selectedFeature: string;
  selectedFeatureValue: number;
  selectedFeatureNorm: number;
  selectedFeatureValues: Record<string, number>;
  selectedFeatureRawValues: Record<string, number>;
}

export interface SpatialPiece extends MusicPiece {
  position: [number, number, number];
  color: string;
  activeClusterValue?: number | null;
}

export interface SpaceConfig {
  xAxis: string;
  yAxis: string;
  zAxis: string;
}

export type CameraView = 'front' | 'side' | 'top' | 'iso';

export type ThumbnailProjectionPlane = 'xy' | 'xz' | 'yz';

export interface ThumbnailProjectionConfig {
  plane: ThumbnailProjectionPlane;
  zAxis: string;
  capturedView: CameraView;
  camera?: CameraSyncState | null;
}

export interface CameraViewCommand {
  id: number;
  view: CameraView;
}

export interface CameraSyncState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom: number;
}

export interface CameraSyncCommand {
  id: number;
  sourceId: string;
  state: CameraSyncState;
}

export interface PlaybackState {
  fileName: string;
  currentTime: number;
  duration: number;
  playing: boolean;
}

export interface ComposerCompareSummary {
  composer: string;
  segmentCount: number;
  recordCount: number;
  themeShare: number;
  dominantCluster: number | null;
  dominantClusterShare: number;
  avgFeatureNorm: number;
  avgFeatureRaw: number;
  avgTrajectoryLength: number;
}

export interface SimilarRecordMatch {
  sourceFileName: string;
  sourceMusicName: string;
  sourceComposer: string;
  sourceSide: 'left' | 'right';
  targetFileName: string;
  targetMusicName: string;
  targetComposer: string;
  targetSegmentCount: number;
  targetRepresentativeId: string;
  shapeDistance: number;
  positionDistance: number;
  clusterDistance: number;
  combinedDistance: number;
  score: number;
}

export interface SimilarMatchWeights {
  shape: number;
  position: number;
  cluster: number;
}
