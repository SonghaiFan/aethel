import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { Search, X } from 'lucide-react';
import { SpatialPiece, ThumbnailProjectionConfig } from '../types';
import TsneTrajectoryThumbnail, { buildThumbnailProjectionModel } from './TsneTrajectoryThumbnail';

interface GalleryRecord {
  fileName: string;
  folder: string;
  musicName: string;
  composer: string;
  period: string;
  instrument: string;
  length: number;
  link: string;
  segments: SpatialPiece[];
}

interface GalleryViewProps {
  pieces: SpatialPiece[];
  thumbnailProjection: ThumbnailProjectionConfig;
  thumbnailProjectionModel?: ReturnType<typeof buildThumbnailProjectionModel> | null;
  onClose: () => void;
  onSelect: (piece: SpatialPiece) => void;
}

const segmentSortKey = (piece: SpatialPiece) => {
  if (piece.segmentLabel === 'T') return 0;
  const match = piece.segmentLabel.match(/^V(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : piece.segmentStartSec + 10000;
};

const projectionLabel = (projection: ThumbnailProjectionConfig) => (
  projection.camera ? `${projection.capturedView.toUpperCase()} Snapshot` : projection.plane.toUpperCase()
);

const axisLabel = (axis: string) => {
  if (axis === 'tsneX') return 't-SNE X';
  if (axis === 'tsneY') return 't-SNE Y';
  if (axis === 'selectedFeatureNorm') return 'Feature';
  return axis.startsWith('feature:') ? axis.replace(/^feature:/, '') : axis;
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

const projectionAxes = (projection: ThumbnailProjectionConfig): [string, string, string] => {
  const zAxis = projection.zAxis || 'selectedFeatureNorm';
  return ['tsneX', 'tsneY', zAxis];
};

const meanValue = (values: number[]) => {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return 0;
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
};

const GalleryView = ({ pieces, thumbnailProjection, thumbnailProjectionModel: capturedThumbnailProjectionModel, onClose, onSelect }: GalleryViewProps) => {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [periodFilter, setPeriodFilter] = useState('');
  const [composerFilter, setComposerFilter] = useState('');

  const records = useMemo<GalleryRecord[]>(() => {
    const groups = new Map<string, GalleryRecord>();

    pieces.forEach((piece) => {
      const record = groups.get(piece.fileName) ?? {
        fileName: piece.fileName,
        folder: piece.folder,
        musicName: piece.musicName,
        composer: piece.composer,
        period: piece.period,
        instrument: piece.instrument,
        length: piece.length,
        link: piece.link,
        segments: [],
      };
      record.segments.push(piece);
      groups.set(piece.fileName, record);
    });

    return Array.from(groups.values())
      .map(record => ({
        ...record,
        segments: [...record.segments].sort((a, b) => segmentSortKey(a) - segmentSortKey(b)),
      }))
      .sort((a, b) => a.composer.localeCompare(b.composer) || a.musicName.localeCompare(b.musicName));
  }, [pieces]);

  const composerOptions = useMemo(() => (
    Array.from(new Set(records.map(record => record.composer)))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  ), [records]);

  const periodOptions = useMemo(() => (
    Array.from(new Set(records.map(record => record.period)))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  ), [records]);

  const filteredRecords = useMemo(() => (
    records.filter(record => (
      (!periodFilter || record.period === periodFilter)
      && (!composerFilter || record.composer === composerFilter)
    ))
  ), [composerFilter, periodFilter, records]);

  const thumbnailProjectionModel = useMemo(
    () => capturedThumbnailProjectionModel ?? buildThumbnailProjectionModel(pieces, thumbnailProjection),
    [capturedThumbnailProjectionModel, pieces, thumbnailProjection]
  );

  const projectionValueColumns = useMemo(() => {
    const axes = projectionAxes(thumbnailProjection);
    return axes.map((axis, index) => ({
      id: `projection${index}`,
      label: axisLabel(axis),
      value: (record: GalleryRecord) => meanValue(record.segments.map(piece => axisValue(piece, axis))),
    }));
  }, [thumbnailProjection]);

  const columns = useMemo<ColumnDef<GalleryRecord>[]>(() => [
    {
      id: 'thumbnails',
      header: () => `Music Map ${projectionLabel(thumbnailProjection)}`,
      enableSorting: false,
      cell: ({ row }) => {
        const record = row.original;
        const firstSegment = record.segments[0];
        return (
          <button
            type="button"
            title={`${record.musicName} · ${record.segments.length} sections`}
            onClick={(event) => {
              event.stopPropagation();
              if (!firstSegment) return;
              onSelect(firstSegment);
              onClose();
            }}
            className="group/thumb rounded border border-white/8 bg-black/30 p-1.5 transition-colors hover:border-white/28"
          >
            <TsneTrajectoryThumbnail
              recordPieces={record.segments}
              projectionModel={thumbnailProjectionModel}
              activePieceId={firstSegment?.id}
              projection={thumbnailProjection}
              width={96}
              height={96}
              showLabels={false}
              onSelect={(piece) => {
                onSelect(piece);
                onClose();
              }}
            />
            <span className="mt-1 block text-center font-mono text-[9px] uppercase tracking-[0.1em] text-white/42 group-hover/thumb:text-white/76">
              {record.segments.length} sections
            </span>
          </button>
        );
      },
    },
    {
      accessorKey: 'composer',
      header: 'Composer',
      cell: info => <span className="text-white/82">{String(info.getValue())}</span>,
    },
    {
      accessorKey: 'musicName',
      header: 'Music',
      cell: info => (
        <span className="line-clamp-2 max-w-[360px] font-serif text-base italic leading-snug text-white/90">
          {String(info.getValue())}
        </span>
      ),
    },
    ...projectionValueColumns.map(column => ({
      id: column.id,
      header: column.label,
      accessorFn: column.value,
      cell: info => (
        <span className="font-mono text-[11px] text-white/62">
          {Number(info.getValue()).toFixed(2)}
        </span>
      ),
    } satisfies ColumnDef<GalleryRecord>)),
    {
      accessorKey: 'period',
      header: 'Period',
      cell: info => <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/58">{String(info.getValue())}</span>,
    },
    {
      accessorKey: 'instrument',
      header: 'Instrument',
      cell: info => <span className="text-white/52">{String(info.getValue())}</span>,
    },
    {
      accessorFn: row => row.segments.length,
      id: 'segments',
      header: 'Segments',
      cell: info => <span className="font-mono text-white/66">{Number(info.getValue())}</span>,
    },
    {
      accessorKey: 'length',
      header: 'Length',
      cell: info => <span className="font-mono text-white/55">{Number(info.getValue()).toFixed(2)}m</span>,
    },
  ], [onClose, onSelect, projectionValueColumns, thumbnailProjection, thumbnailProjectionModel]);

  const table = useReactTable({
    data: filteredRecords,
    columns,
    state: {
      sorting,
      globalFilter,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 20,
      },
    },
  });

  return (
    <motion.section
      initial={{ x: -48, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -48, opacity: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      className="absolute bottom-0 left-[400px] right-0 top-0 z-20 flex flex-col border-l border-white/10 bg-[#050505]/98 font-sans text-white shadow-2xl"
    >
      <header className="relative z-10 flex items-start justify-between border-b border-white/10 px-6 py-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-white/36">Dataset Gallery</p>
          <h2 className="mt-1 font-serif text-3xl font-light text-white">Record Archive</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/72 transition-colors hover:border-white/24 hover:text-white"
        >
          <X size={14} />
          Space
        </button>
      </header>

      <div className="relative z-10 grid grid-cols-[minmax(0,1fr)_180px_220px_120px] gap-3 border-b border-white/10 px-6 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" size={14} />
          <input
            value={globalFilter ?? ''}
            onChange={event => setGlobalFilter(event.target.value)}
            placeholder="Search composer, piece, instrument..."
            className="h-10 w-full rounded border border-white/10 bg-white/[0.045] pl-9 pr-3 text-sm text-white/78 outline-none transition-colors placeholder:text-white/24 focus:border-white/28"
          />
        </div>
        <select
          value={periodFilter}
          onChange={event => setPeriodFilter(event.target.value)}
          className="h-10 rounded border border-white/10 bg-black/50 px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-white/62 outline-none"
        >
          <option value="">All periods</option>
          {periodOptions.map(period => <option key={period} value={period}>{period}</option>)}
        </select>
        <select
          value={composerFilter}
          onChange={event => setComposerFilter(event.target.value)}
          className="h-10 rounded border border-white/10 bg-black/50 px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-white/62 outline-none"
        >
          <option value="">All composers</option>
          {composerOptions.map(composer => <option key={composer} value={composer}>{composer}</option>)}
        </select>
        <select
          value={table.getState().pagination.pageSize}
          onChange={event => table.setPageSize(Number(event.target.value))}
          className="h-10 rounded border border-white/10 bg-black/50 px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-white/62 outline-none"
        >
          {[20, 40, 80].map(size => <option key={size} value={size}>{size} rows</option>)}
        </select>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-auto px-6 py-4">
        <table className="w-full min-w-[1320px] border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-[#050505]/96 backdrop-blur-xl">
            {table.getHeaderGroups().map(headerGroup => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map(header => (
                  <th
                    key={header.id}
                    className="border-b border-white/12 px-3 py-3 font-mono text-[9px] uppercase tracking-[0.16em] text-white/42"
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={`flex items-center gap-1 ${header.column.getCanSort() ? 'cursor-pointer hover:text-white/76' : 'cursor-default'}`}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: '↑',
                        desc: '↓',
                      }[header.column.getIsSorted() as string] ?? ''}
                    </button>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(row => {
              const firstSegment = row.original.segments[0];
              return (
                <tr
                  key={row.id}
                  onClick={() => {
                    if (!firstSegment) return;
                    onSelect(firstSegment);
                    onClose();
                  }}
                  className="group cursor-pointer transition-colors hover:bg-white/[0.045]"
                >
                  {row.getVisibleCells().map(cell => (
                    <td key={cell.id} className="border-b border-white/[0.055] px-3 py-3 align-middle text-sm text-white/62">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="relative z-10 flex items-center justify-between border-t border-white/10 px-6 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-white/44">
        <span>
          {table.getFilteredRowModel().rows.length} matching records · click a row or thumbnail to select
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-25"
          >
            Prev
          </button>
          <span>
            Page {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-25"
          >
            Next
          </button>
        </div>
      </footer>
    </motion.section>
  );
};

export default GalleryView;
