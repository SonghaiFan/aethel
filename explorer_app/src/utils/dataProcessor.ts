import Papa from 'papaparse';
import { MusicPiece, SpatialPiece, Period } from '../types';

const PERIOD_ORDER: Record<string, number> = {
  'Renaissance': 0,
  'Baroque': 1,
  'Classical': 2,
  'Romantic': 3,
  'Modern': 4,
};

export const PERIOD_COLORS: Record<string, string> = {
  'Renaissance': '#fdf6e3',
  'Baroque': '#ff7f50',
  'Classical': '#ffd700',
  'Romantic': '#ff4500',
  'Modern': '#c0c0c0',
  'Unknown': '#808080',
};

export const CLUSTER_COLORS = [
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
];

export const clusterColor = (cluster: number | null | undefined): string => {
  if (cluster === null || cluster === undefined || Number.isNaN(cluster)) return '#808080';
  return CLUSTER_COLORS[Math.abs(cluster) % CLUSTER_COLORS.length];
};

export const mmssToSeconds = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const [minutesText, secondsText = '0'] = trimmed.split('.');
  const minutes = Number.parseInt(minutesText, 10);
  const seconds = Number.parseInt(secondsText.padEnd(2, '0').slice(0, 2), 10);

  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  return minutes * 60 + seconds;
};

export const parseCSV = (csvString: string): MusicPiece[] => {
  const result = Papa.parse(csvString, {
    header: true,
    skipEmptyLines: true,
  });

  const parseNullableInt = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isNaN(parsed) ? null : parsed;
  };
  const parseNullableFloat = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseFloat(String(value));
    return Number.isNaN(parsed) ? null : parsed;
  };
  const parseBoolean = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes'].includes(String(value).trim().toLowerCase());
  };

  return (result.data as any[]).map((row, idx) => {
    const fileName = row.file_name || row['file_name (folderName_number)'] || '';
    const recordBoundary = row.record_boundary || row.boundary || '';
    const recordLabel = row.record_label || row.label || '';
    const segmentLabel = row.segment_label || row.label || '';

    const boundaries = recordBoundary
      .split(';')
      .map((s: string) => mmssToSeconds(s))
      .filter((n: number | null): n is number => n !== null);
    const labels = recordLabel.split(';').map((s: string) => s.trim()).filter(Boolean);

    const segments = labels.map((label, i) => ({
      time: boundaries[i] ?? 0,
      label,
    }));
    const selectedFeatureValues = Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => key.startsWith('norm_'))
        .map(([key, value]) => [key.replace(/^norm_/, ''), parseFloat(String(value)) || 0])
    );
    const selectedFeatureRawValues = Object.fromEntries(
      Object.keys(selectedFeatureValues).map((feature) => [
        feature,
        parseFloat(row[`value_${feature}`]) || 0,
      ])
    );
    const defaultSelectedFeature = row.default_selected_feature || Object.keys(selectedFeatureValues)[0] || '';

    return {
      id: row.id || `${fileName}_${segmentLabel || idx}`,
      folder: row.folder || '',
      fileName,
      audioSrc: `/audio/${encodeURIComponent(row.folder || '')}/${encodeURIComponent(fileName)}.wav`,
      segmentLabel,
      segmentStartSec: parseFloat(row.segment_start_sec) || 0,
      segmentEndSec: parseFloat(row.segment_end_sec) || 0,
      segmentDurationSec: parseFloat(row.segment_duration_sec) || 0,
      length: parseFloat(row.length) || 0,
      musicName: row.music_name || 'Untitled',
      composer: row.composer || 'Unknown',
      period: row.period || 'Unknown',
      periodVal: PERIOD_ORDER[row.period] ?? 2.5,
      boundary: recordBoundary,
      label: recordLabel || segmentLabel,
      segments,
      chord: row.chord || '',
      link: row.link || '',
      variationNum: parseInt(row.variation_num) || 0,
      instrument: row.instrument || '',
      note: row.note || '',
      tsneX: parseFloat(row.tsne_x) || 0,
      tsneY: parseFloat(row.tsne_y) || 0,
      clusterKm: parseNullableInt(row.cluster_km),
      clusterKmedoids: parseNullableInt(row.cluster_kmedoids),
      clusterWard: parseNullableInt(row.cluster_ward),
      clusterHdbscan: parseNullableInt(row.cluster_hdbscan),
      clusterHdbscanSub: parseNullableInt(row.cluster_hdbscan_sub),
      clusterHdbscanNested: row.cluster_hdbscan_nested || '',
      hdbscanStrength: Number.parseFloat(row.hdbscan_strength) || 0,
      hdbscanSubStrength: Number.parseFloat(row.hdbscan_sub_strength) || 0,
      hdbscanSubIsOutlier: parseBoolean(row.hdbscan_sub_is_outlier),
      hdbscanMajorCluster: parseNullableInt(row.hdbscan_major_cluster),
      isOutlier: parseBoolean(row.is_outlier),
      clusterKmSize: parseNullableInt(row.cluster_km_size),
      clusterKmedoidsSize: parseNullableInt(row.cluster_kmedoids_size),
      clusterWardSize: parseNullableInt(row.cluster_ward_size),
      clusterHdbscanSize: parseNullableInt(row.cluster_hdbscan_size),
      clusterHdbscanSubSize: parseNullableInt(row.cluster_hdbscan_sub_size),
      clusterKmRepresentativeId: row.cluster_km_representative_id || '',
      clusterKmedoidsRepresentativeId: row.cluster_kmedoids_representative_id || '',
      clusterWardRepresentativeId: row.cluster_ward_representative_id || '',
      clusterHdbscanRepresentativeId: row.cluster_hdbscan_representative_id || '',
      clusterHdbscanSubRepresentativeId: row.cluster_hdbscan_sub_representative_id || '',
      clusterKmDistanceToRepresentative: parseNullableFloat(row.cluster_km_distance_to_representative),
      clusterKmedoidsDistanceToRepresentative: parseNullableFloat(row.cluster_kmedoids_distance_to_representative),
      clusterWardDistanceToRepresentative: parseNullableFloat(row.cluster_ward_distance_to_representative),
      clusterHdbscanDistanceToRepresentative: parseNullableFloat(row.cluster_hdbscan_distance_to_representative),
      clusterHdbscanSubDistanceToRepresentative: parseNullableFloat(row.cluster_hdbscan_sub_distance_to_representative),
      clusterRepresentative: row.cluster_representative || '',
      clusterRepresentativeDistance: parseNullableFloat(row.cluster_representative_distance),
      selectedFeature: defaultSelectedFeature,
      selectedFeatureValue: selectedFeatureRawValues[defaultSelectedFeature] ?? 0,
      selectedFeatureNorm: selectedFeatureValues[defaultSelectedFeature] ?? 0,
      selectedFeatureValues,
      selectedFeatureRawValues,
    };
  });
};

export const getSelectedFeatureNames = (pieces: MusicPiece[]): string[] => {
  const firstWithFeatures = pieces.find(piece => Object.keys(piece.selectedFeatureValues).length);
  if (!firstWithFeatures) return [];
  return Object.keys(firstWithFeatures.selectedFeatureValues);
};

export const getUniquePeriods = (pieces: MusicPiece[]): string[] => {
  const periods = Array.from(new Set(pieces.map(p => p.period))).filter(Boolean);
  const ordered = ['Renaissance', 'Baroque', 'Classical', 'Romantic', 'Modern', 'Contemporary'];
  return periods.sort((a, b) => {
    const ai = ordered.indexOf(a);
    const bi = ordered.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    return a.localeCompare(b);
  });
};

export const processSpatialData = (pieces: MusicPiece[]): SpatialPiece[] => {
  return pieces.map(piece => ({
    ...piece,
    position: [piece.tsneX, piece.tsneY, piece.selectedFeatureNorm],
    color: clusterColor(piece.clusterKm),
  }));
};
