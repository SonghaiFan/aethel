import Papa from 'papaparse';
import clusterSummaryCsv from '../data/cluster_summary.csv?raw';
import { ClusterMethod } from './clusterMethods';

export interface ClusterSummaryRow {
  method: string;
  cluster: number;
  role: string;
  size: number;
  representativeId: string;
  themeCount: number;
  variationCount: number;
  themeRatio: number;
  topPeriods: string;
  topComposers: string;
  topLabels: string;
}

const methodToSummaryKey = (method: ClusterMethod) => {
  if (method === 'hdbscan') return 'hdbscan_umap';
  if (method === 'hdbscanNested') return 'hdbscan_nested';
  return method;
};

const normalizeClusterForSummary = (method: ClusterMethod, cluster: number) => {
  if (method !== 'hdbscanNested') return cluster;
  if (cluster === -2) return -1;
  if (cluster >= 100) return cluster - 100;
  return cluster;
};

const parseNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const summaryRows: ClusterSummaryRow[] = Papa.parse(clusterSummaryCsv, {
  header: true,
  skipEmptyLines: true,
}).data.map((row: any) => ({
  method: row.method || '',
  cluster: Number.parseInt(row.cluster, 10),
  role: row.role || '',
  size: parseNumber(row.size),
  representativeId: row.representative_id || '',
  themeCount: parseNumber(row.theme_count),
  variationCount: parseNumber(row.variation_count),
  themeRatio: parseNumber(row.theme_ratio),
  topPeriods: row.top_periods || '',
  topComposers: row.top_composers || '',
  topLabels: row.top_labels || '',
})).filter(row => row.method && Number.isFinite(row.cluster));

export const getClusterSummary = (
  method: ClusterMethod,
  cluster: number | null
): ClusterSummaryRow | null => {
  if (cluster === null || cluster === undefined) return null;
  const methodKey = methodToSummaryKey(method);
  const summaryCluster = normalizeClusterForSummary(method, cluster);
  return summaryRows.find(row => row.method === methodKey && row.cluster === summaryCluster) ?? null;
};

export const compactSummaryList = (value: string, limit = 3) => (
  value
    .split(';')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, limit)
);
