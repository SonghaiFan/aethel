import { MusicPiece } from '../types';

export type ClusterMethod = 'kmedoids' | 'kmeans' | 'ward' | 'hdbscan' | 'hdbscanNested';

const CLUSTER_PALETTES: Record<ClusterMethod, string[]> = {
  kmedoids: [
    '#21b7c8',
    '#f2c14e',
    '#e85d75',
    '#7f6df2',
    '#3ddc97',
    '#ff9f43',
    '#64d2ff',
    '#c9d6df',
    '#ff7a59',
    '#9cc9ff',
  ],
  kmeans: [
    '#3f88c5',
    '#d8a31a',
    '#c8556f',
    '#38a169',
    '#8f73d1',
    '#d76f30',
    '#4fb6b2',
    '#d7dde8',
    '#bd5d4f',
    '#7aa7d9',
  ],
  ward: [
    '#8ecae6',
    '#e9c46a',
    '#cdb4db',
    '#95d5b2',
    '#b8c0ff',
    '#f4a261',
    '#90dbf4',
    '#ffadad',
    '#d9ed92',
    '#a8c7fa',
  ],
  hdbscan: [
    '#56b4e9',
    '#e69f00',
    '#009e73',
    '#cc79a7',
    '#f0e442',
    '#0072b2',
    '#d55e00',
    '#8a5cf6',
    '#2ec4b6',
    '#f25f5c',
    '#b8de6f',
    '#8fa3b8',
  ],
  hdbscanNested: [
    '#4ea8de',
    '#ffbe0b',
    '#2a9d8f',
    '#b565d9',
    '#ef476f',
    '#00b4d8',
    '#f4d35e',
    '#70c1b3',
    '#9b5de5',
    '#f77f00',
    '#48cae4',
    '#6c8a93',
    '#a7c957',
    '#e76f51',
    '#5e81ac',
    '#80b918',
  ],
};

const HDBSCAN_ISLAND_PALETTE = [
  '#56b4e9',
  '#e69f00',
  '#009e73',
  '#cc79a7',
  '#f0e442',
  '#0072b2',
  '#d55e00',
  '#8a5cf6',
  '#2ec4b6',
  '#f25f5c',
  '#b8de6f',
  '#8fa3b8',
];

const HDBSCAN_SUBCLUSTER_PALETTE = [
  '#2f80ed',
  '#2fbf71',
  '#f2994a',
  '#9b51e0',
  '#eb5757',
  '#00a6a6',
  '#f2c94c',
  '#6fcf97',
  '#bb6bd9',
  '#ff7f50',
  '#56ccf2',
  '#70878f',
];

const HDBSCAN_NOISE_COLOR = '#343a42';
const HDBSCAN_MAJOR_COLOR = '#bfc5cf';
const HDBSCAN_SUB_NOISE_COLOR = '#747d89';
const UNKNOWN_CLUSTER_COLOR = '#6f7680';

export const CLUSTER_METHOD_OPTIONS: { id: ClusterMethod; label: string; description: string }[] = [
  { id: 'kmedoids', label: 'K-Medoids', description: 'three strong medoid colors' },
  { id: 'kmeans', label: 'KMeans', description: 'muted baseline partition' },
  { id: 'ward', label: 'Ward', description: 'soft hierarchy tones' },
  { id: 'hdbscan', label: 'HDBSCAN', description: 'gray field, colored islands' },
  { id: 'hdbscanNested', label: 'Nested HDBSCAN', description: 'colored piano subfields' },
];

export const getClusterValue = (piece: MusicPiece, method: ClusterMethod): number | null => {
  if (method === 'kmedoids') return piece.clusterKmedoids;
  if (method === 'kmeans') return piece.clusterKm;
  if (method === 'ward') return piece.clusterWard;
  if (method === 'hdbscanNested') {
    if (piece.clusterHdbscan === null) return null;
    if (
      piece.hdbscanMajorCluster !== null
      && piece.clusterHdbscan === piece.hdbscanMajorCluster
    ) {
      if (piece.clusterHdbscanSub === null) return null;
      if (piece.clusterHdbscanSub === -1) return -2;
      return 100 + piece.clusterHdbscanSub;
    }
    return piece.clusterHdbscan;
  }
  return piece.clusterHdbscan;
};

export const getClusterRepresentativeId = (piece: MusicPiece, method: ClusterMethod): string => {
  if (method === 'kmedoids') return piece.clusterKmedoidsRepresentativeId || piece.clusterRepresentative;
  if (method === 'kmeans') return piece.clusterKmRepresentativeId || piece.clusterRepresentative;
  if (method === 'ward') return piece.clusterWardRepresentativeId || piece.clusterRepresentative;
  if (method === 'hdbscanNested') {
    if (
      piece.hdbscanMajorCluster !== null
      && piece.clusterHdbscan === piece.hdbscanMajorCluster
      && piece.clusterHdbscanSub !== null
      && piece.clusterHdbscanSub >= 0
    ) {
      return piece.clusterHdbscanSubRepresentativeId;
    }
    return piece.clusterHdbscanRepresentativeId;
  }
  return piece.clusterHdbscanRepresentativeId;
};

export const getClusterSize = (piece: MusicPiece, method: ClusterMethod): number | null => {
  if (method === 'kmedoids') return piece.clusterKmedoidsSize;
  if (method === 'kmeans') return piece.clusterKmSize;
  if (method === 'ward') return piece.clusterWardSize;
  if (method === 'hdbscanNested') {
    if (
      piece.hdbscanMajorCluster !== null
      && piece.clusterHdbscan === piece.hdbscanMajorCluster
      && piece.clusterHdbscanSub !== null
    ) {
      return piece.clusterHdbscanSubSize;
    }
    return piece.clusterHdbscanSize;
  }
  return piece.clusterHdbscanSize;
};

export const getClusterValueColor = (
  method: ClusterMethod,
  value: number | null | undefined,
  isOutlier = false
): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return UNKNOWN_CLUSTER_COLOR;
  if (method === 'hdbscanNested') {
    if (value === -1) return HDBSCAN_NOISE_COLOR;
    if (value === -2) return HDBSCAN_SUB_NOISE_COLOR;
    if (value >= 100) {
      const subIndex = value - 100;
      return HDBSCAN_SUBCLUSTER_PALETTE[Math.abs(subIndex) % HDBSCAN_SUBCLUSTER_PALETTE.length];
    }
    return HDBSCAN_ISLAND_PALETTE[Math.abs(value) % HDBSCAN_ISLAND_PALETTE.length];
  }
  if (method === 'hdbscan') {
    if (value === -1 || isOutlier) return HDBSCAN_NOISE_COLOR;
    if (value === 9) return HDBSCAN_MAJOR_COLOR;
  }

  const palette = CLUSTER_PALETTES[method];
  const index = Math.abs(value) % palette.length;
  return palette[index];
};

export const getClusterMethodColor = (piece: MusicPiece, method: ClusterMethod): string => {
  const value = getClusterValue(piece, method);
  return getClusterValueColor(method, value, piece.isOutlier);
};
