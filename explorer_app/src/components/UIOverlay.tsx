import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CameraView, ComposerCompareSummary, PlaybackState, SimilarMatchWeights, SimilarRecordMatch, SpatialPiece, SpaceConfig, ThumbnailProjectionConfig } from '../types';
import { X, Search, Play, Pause, GitCompare, Table2, Layers3, Music2, Box, Headphones, MousePointer2, ArrowUpDown } from 'lucide-react';
import RecordWaveBar, { recordTimelineEnd } from './RecordWaveBar';
import TsneTrajectoryThumbnail from './TsneTrajectoryThumbnail';
import { CLUSTER_METHOD_OPTIONS, ClusterMethod, getClusterRepresentativeId, getClusterSize, getClusterValue, getClusterValueColor } from '../utils/clusterMethods';
import { compactSummaryList, getClusterSummary } from '../utils/clusterSummary';

type YouTubePlayer = {
  destroy: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  loadVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  pauseVideo: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
};

type YouTubeConstructor = new (
  element: HTMLElement,
  options: {
    height: string;
    width: string;
    videoId: string;
    playerVars: Record<string, string | number>;
    events: {
      onReady: (event: { target: YouTubePlayer }) => void;
      onStateChange: (event: { data: number; target: YouTubePlayer }) => void;
      onError: (event: { data: number }) => void;
    };
  }
) => YouTubePlayer;

declare global {
  interface Window {
    YT?: {
      Player: YouTubeConstructor;
      PlayerState?: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<void> | null = null;

const loadYouTubeApi = () => {
  if (window.YT?.Player) return Promise.resolve();
  if (!youtubeApiPromise) {
    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        resolve();
      };

      if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const startedAt = performance.now();
        const pollId = window.setInterval(() => {
          if (window.YT?.Player) {
            window.clearInterval(pollId);
            resolve();
          } else if (performance.now() - startedAt > 10000) {
            window.clearInterval(pollId);
            reject(new Error('Timed out waiting for YouTube IFrame API'));
          }
        }, 100);
        return;
      }

      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
      document.head.appendChild(tag);
    });
  }

  return youtubeApiPromise;
};

const extractYouTubeVideoId = (url: string) => {
  if (!url.trim()) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.replace('/', '').trim();
    if (parsed.hostname.includes('youtube.com')) {
      if (parsed.pathname.startsWith('/embed/')) return parsed.pathname.split('/')[2] ?? '';
      if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] ?? '';
      return parsed.searchParams.get('v') ?? '';
    }
  } catch {
    const match = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/);
    return match?.[1] ?? '';
  }
  return '';
};

// ── Metric descriptions ────────────────────────────────────────────────────
const METRIC_DESCRIPTIONS: Record<string, string> = {
  // Handcrafted features
  upward_ratio:          'Fraction of melodic intervals that move upward',
  leap_ratio:            'Fraction of intervals larger than a step (>2 semitones)',
  pitch_range:           'Semitone span from lowest to highest note',
  mfcc_mean_1:           'MFCC 1 — overall spectral energy / brightness',
  mfcc_mean_2:           'MFCC 2 — low vs high frequency balance',
  mfcc_mean_3:           'MFCC 3 — mid-frequency spectral shape',
  mfcc_mean_4:           'MFCC 4 — spectral texture detail',
  mfcc_mean_5:           'MFCC 5 — fine spectral contour component',
  mfcc_mean_6:           'MFCC 6 — spectral fine structure',
  mfcc_mean_7:           'MFCC 7 — higher-order spectral shape',
  mfcc_mean_8:           'MFCC 8 — harmonic texture component',
  mfcc_mean_9:           'MFCC 9 — spectral periodicity detail',
  mfcc_mean_10:          'MFCC 10 — timbral fine detail (mean)',
  mfcc_mean_11:          'MFCC 11 — high-order spectral coefficient',
  mfcc_mean_12:          'MFCC 12 — highest-order timbral mean',
  mfcc_var_1:            'MFCC 1 variance — dynamic variation in brightness',
  mfcc_var_2:            'MFCC 2 variance — tonal contrast variation',
  mfcc_var_3:            'MFCC 3 variance — mid-frequency fluctuation',
  mfcc_var_4:            'MFCC 4 variance — textural variation',
  mfcc_var_5:            'MFCC 5 variance — spectral contour change',
  mfcc_var_6:            'MFCC 6 variance — fine spectral fluctuation',
  mfcc_var_7:            'MFCC 7 variance — higher-order spectral change',
  mfcc_var_8:            'MFCC 8 variance — harmonic texture change',
  mfcc_var_9:            'MFCC 9 variance — periodicity fluctuation',
  mfcc_var_10:           'MFCC 10 variance — timbral detail fluctuation',
  mfcc_var_11:           'MFCC 11 variance — high-order spectral change',
  mfcc_var_12:           'MFCC 12 variance — highest-order timbral change',
  rms_mean:              'Average loudness / energy across the segment',
  rms_variance:          'How much loudness varies within the segment',
  spectral_centroid_mean:'Average frequency centre of mass — perceived brightness',
  spectral_brightness:   'Energy ratio above 1.5 kHz — overall sharpness',
  // Structural / metadata axes
  tsneX:                 't-SNE X — 2-D embedding of MERT neural features',
  tsneY:                 't-SNE Y — 2-D embedding of MERT neural features',
  periodVal:             'Historical era (Baroque → Classical → Romantic → Modern)',
  length:                'Total duration of the piece in minutes',
  variationNum:          'Number of variations in the piece',
};

const metricDescription = (value: string): string => {
  const key = value.startsWith('feature:') ? value.replace(/^feature:/, '') : value;
  return METRIC_DESCRIPTIONS[key.toLowerCase()] ?? '';
};

const fmtTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`;
};

const fmtPct = (value: number) => `${(Math.max(0, value) * 100).toFixed(1)}%`;

const fmtMetric = (value: number, digits = 2) => (
  Number.isFinite(value) ? value.toFixed(digits) : '0'
);

const summaryDelta = (a: number, b: number, digits = 2) => {
  const delta = a - b;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${fmtMetric(delta, digits)}`;
};

const plainMetricName = (value: string) => value.replaceAll('_', ' ');

const FRIENDLY_FEATURES: Record<string, { label: string; description: string }> = {
  tonal_centroid: {
    label: 'Key feeling',
    description: 'Dots are higher when the music has a stronger sense of key or harmony.',
  },
  rms_mean: {
    label: 'Loudness',
    description: 'Dots are higher when the music is louder or more energetic.',
  },
  rms_variance: {
    label: 'Loudness changes',
    description: 'Dots are higher when the music gets louder and softer more often.',
  },
  pitch_range: {
    label: 'High and low range',
    description: 'Dots are higher when the notes travel farther from low to high.',
  },
  upward_ratio: {
    label: 'Rising melody',
    description: 'Dots are higher when the melody moves upward more often.',
  },
  leap_ratio: {
    label: 'Melody jumps',
    description: 'Dots are higher when the melody uses bigger jumps between notes.',
  },
  spectral_centroid_mean: {
    label: 'Brightness',
    description: 'Dots are higher when the sound is brighter and sharper.',
  },
  spectral_brightness: {
    label: 'Sparkle',
    description: 'Dots are higher when the sound has more high-frequency sparkle.',
  },
  onset_density: {
    label: 'Activity',
    description: 'Dots are higher when more notes or attacks happen close together.',
  },
  note_density: {
    label: 'Note busyness',
    description: 'Dots are higher when the music feels busier with notes.',
  },
  rhythmic_variance: {
    label: 'Rhythm variety',
    description: 'Dots are higher when the rhythm changes more.',
  },
  tempo_stability: {
    label: 'Steady tempo',
    description: 'Dots are higher when the beat stays steadier.',
  },
  harmonic_stability: {
    label: 'Stable harmony',
    description: 'Dots are higher when the harmony feels more settled.',
  },
  chroma_entropy: {
    label: 'Key wandering',
    description: 'Dots are higher when the music wanders through more pitch colors.',
  },
};

const friendlyFeature = (feature: string) => (
  FRIENDLY_FEATURES[feature] ?? {
    label: plainMetricName(feature).replace(/^mfcc/i, 'tone color'),
    description: `Dots are higher when ${plainMetricName(feature)} is stronger.`,
  }
);

const FRIENDLY_CLUSTER_METHODS: Record<ClusterMethod, { label: string; description: string }> = {
  kmedoids: {
    label: 'Clear color families',
    description: 'Good default. It chooses a few clear musical families and colors each dot by its closest family.',
  },
  kmeans: {
    label: 'Simple color split',
    description: 'A basic split into even groups. Useful when you want a simple overview.',
  },
  ward: {
    label: 'Family tree colors',
    description: 'Groups dots by a tree-like family relationship.',
  },
  hdbscan: {
    label: 'Natural islands',
    description: 'Finds dense islands of similar music and leaves unusual dots quieter.',
  },
  hdbscanNested: {
    label: 'Detailed islands',
    description: 'A more detailed island view for close inspection.',
  },
};

const friendlyCluster = (method: ClusterMethod) => FRIENDLY_CLUSTER_METHODS[method];

const cameraLabel = (view: CameraView, friendlyMode: boolean) => {
  if (!friendlyMode) return view;
  if (view === 'top') return 'Map';
  if (view === 'iso') return '3D';
  return 'Side';
};

const MatchWeightSlider = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) => (
  <label className="block">
    <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-white/34">
      <span>{label}</span>
      <span>{Math.round(value * 100)}%</span>
    </div>
    <input
      aria-label={`${label} match weight`}
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-1.5 w-full accent-amber-200"
    />
  </label>
);

interface UIOverlayProps {
  selectedPiece: SpatialPiece | null;
  pieces: SpatialPiece[];
  onClose: () => void;
  piecesCount: number;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activePeriod: string | null;
  setActivePeriod: (p: string | null) => void;
  availablePeriods: string[];
  config: SpaceConfig;
  onUpdateConfig: (updates: Partial<SpaceConfig>) => void;
  selectedFeatures: string[];
  onPlaybackUpdate: (state: PlaybackState | null) => void;
  focusMode: boolean;
  setFocusMode: (enabled: boolean) => void;
  setOrthographicMode: (enabled: boolean) => void;
  currentCameraView: CameraView;
  clusterMethod: ClusterMethod;
  setClusterMethod: (method: ClusterMethod) => void;
  onCameraView: (view: CameraView) => void;
  hoveredPiece: SpatialPiece | null;
  hoverPos: { x: number; y: number };
  compareMode: boolean;
  setCompareMode: (enabled: boolean) => void;
  galleryMode: boolean;
  setGalleryMode: (enabled: boolean) => void;
  composerOptions: { composer: string; count: number }[];
  compareComposerA: string;
  setCompareComposerA: (composer: string) => void;
  compareComposerB: string;
  setCompareComposerB: (composer: string) => void;
  compareSummaryA: ComposerCompareSummary;
  compareSummaryB: ComposerCompareSummary;
  activeCompareFeature: string;
  similarRecordMatch: SimilarRecordMatch | null;
  similarMatchWeights: SimilarMatchWeights;
  setSimilarMatchWeights: (weights: SimilarMatchWeights) => void;
  thumbnailProjection: ThumbnailProjectionConfig;
  friendlyMode: boolean;
  setFriendlyMode: (enabled: boolean) => void;
  onSelectRecordById: (id: string) => void;
}

const UIOverlay = ({ 
  selectedPiece, 
  pieces,
  onClose, 
  piecesCount,
  searchQuery,
  setSearchQuery,
  activePeriod,
  setActivePeriod,
  availablePeriods,
  config,
  onUpdateConfig,
  selectedFeatures,
  onPlaybackUpdate,
  focusMode,
  setFocusMode,
  setOrthographicMode,
  currentCameraView,
  clusterMethod,
  setClusterMethod,
  onCameraView,
  hoveredPiece,
  hoverPos,
  compareMode,
  setCompareMode,
  galleryMode,
  setGalleryMode,
  composerOptions,
  compareComposerA,
  setCompareComposerA,
  compareComposerB,
  setCompareComposerB,
  compareSummaryA,
  compareSummaryB,
  activeCompareFeature,
  similarRecordMatch,
  similarMatchWeights,
  setSimilarMatchWeights,
  thumbnailProjection,
  friendlyMode,
  setFriendlyMode,
  onSelectRecordById,
}: UIOverlayProps) => {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const youtubeHostRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const shouldAutoPlaySelection = useRef(false);
  const lastPlaybackEmitAt = useRef(0);
  const durationRef = useRef(0);
  const selectedPlaybackSourceRef = useRef<string | null>(null);
  const activeSegmentIndexRef = useRef(0);

  const youtubeVideoId = useMemo(() => extractYouTubeVideoId(selectedPiece?.link ?? ''), [selectedPiece?.link]);
  const useYouTubePlayback = Boolean(youtubeVideoId);
  const hasPlaybackSource = Boolean(youtubeVideoId || selectedPiece?.audioSrc);

  const activeZFeature = config.zAxis.startsWith('feature:')
    ? config.zAxis.replace(/^feature:/, '')
    : selectedPiece?.selectedFeature ?? '';
  const activeZNorm = activeZFeature && selectedPiece
    ? selectedPiece.selectedFeatureValues[activeZFeature] ?? selectedPiece.selectedFeatureNorm
    : selectedPiece?.selectedFeatureNorm ?? 0;
  const activeZRaw = activeZFeature && selectedPiece
    ? selectedPiece.selectedFeatureRawValues[activeZFeature] ?? selectedPiece.selectedFeatureValue
    : selectedPiece?.selectedFeatureValue ?? 0;
  const zFeatureOptions = selectedFeatures.length
    ? selectedFeatures
    : selectedPiece
      ? Object.keys(selectedPiece.selectedFeatureValues)
      : [];
  const selectedRecordPieces = useMemo(
    () => selectedPiece ? pieces.filter(piece => piece.fileName === selectedPiece.fileName) : [],
    [pieces, selectedPiece?.fileName]
  );
  const comparisonPiece = compareMode && similarRecordMatch?.targetRepresentativeId
    ? pieces.find(piece => piece.id === similarRecordMatch.targetRepresentativeId) ?? null
    : null;
  const comparisonRecordPieces = comparisonPiece
    ? pieces.filter(piece => piece.fileName === comparisonPiece.fileName)
    : [];
  const showCompareWaveStrips = Boolean(compareMode && selectedPiece && comparisonPiece);

  const segmentClusters = useMemo(() => {
    const clusters = new Map<string, number | null>();
    if (!selectedPiece) return clusters;

    for (const piece of pieces) {
      if (piece.fileName === selectedPiece.fileName) {
        clusters.set(piece.segmentLabel, getClusterValue(piece, clusterMethod));
      }
    }

    return clusters;
  }, [pieces, selectedPiece?.fileName, clusterMethod]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    activeSegmentIndexRef.current = activeSegmentIndex;
  }, [activeSegmentIndex]);

  const emitPlaybackUpdate = (time: number, isPlaying = playing, audioDuration = duration, force = false) => {
    if (!selectedPiece) {
      onPlaybackUpdate(null);
      return;
    }
    const now = performance.now();
    if (!force && isPlaying && now - lastPlaybackEmitAt.current < 90) return;
    lastPlaybackEmitAt.current = now;
    onPlaybackUpdate({
      fileName: selectedPiece.fileName,
      currentTime: time,
      duration: audioDuration,
      playing: isPlaying,
    });
  };

  const readPlaybackDuration = () => {
    if (useYouTubePlayback) return youtubePlayerRef.current?.getDuration() || durationRef.current || duration;
    return audioRef.current?.duration || durationRef.current || duration;
  };

  const readPlaybackTime = () => {
    if (useYouTubePlayback) return youtubePlayerRef.current?.getCurrentTime() || currentTime;
    return audioRef.current?.currentTime ?? currentTime;
  };

  const seekPlayback = (seconds: number) => {
    if (useYouTubePlayback) {
      youtubePlayerRef.current?.seekTo(seconds, true);
      return;
    }
    if (audioRef.current) audioRef.current.currentTime = seconds;
  };

  const playPlayback = () => {
    if (useYouTubePlayback) {
      youtubePlayerRef.current?.playVideo();
      return;
    }
    void audioRef.current?.play();
  };

  const pausePlayback = () => {
    if (useYouTubePlayback) {
      youtubePlayerRef.current?.pauseVideo();
      return;
    }
    audioRef.current?.pause();
  };

  useEffect(() => {
    if (!youtubeVideoId || !youtubeHostRef.current) {
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      return;
    }

    let cancelled = false;
    setIsReady(false);

    loadYouTubeApi()
      .then(() => {
        if (cancelled || !window.YT?.Player || !youtubeHostRef.current) return;

        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = new window.YT.Player(youtubeHostRef.current, {
          height: '100%',
          width: '100%',
          videoId: youtubeVideoId,
          playerVars: {
            controls: 0,
            disablekb: 1,
            playsinline: 1,
            rel: 0,
            start: Math.max(0, Math.floor(selectedPiece?.segmentStartSec ?? 0)),
            origin: window.location.origin,
          },
          events: {
            onReady: event => {
              if (cancelled || !selectedPiece) return;
              const nextDuration = event.target.getDuration() || recordTimelineEnd(selectedRecordPieces, selectedPiece, 0);
              setDuration(nextDuration);
              durationRef.current = nextDuration;
              setIsReady(true);
              event.target.seekTo(selectedPiece.segmentStartSec, true);
              setCurrentTime(selectedPiece.segmentStartSec);
              emitPlaybackUpdate(selectedPiece.segmentStartSec, shouldAutoPlaySelection.current, nextDuration, true);
              if (shouldAutoPlaySelection.current) {
                shouldAutoPlaySelection.current = false;
                event.target.playVideo();
              }
            },
            onStateChange: event => {
              if (!selectedPiece) return;
              const ytState = window.YT?.PlayerState;
              const isPlaying = event.data === (ytState?.PLAYING ?? 1);
              const isPaused = event.data === (ytState?.PAUSED ?? 2) || event.data === (ytState?.ENDED ?? 0);
              if (isPlaying) setPlaying(true);
              if (isPaused) setPlaying(false);
              if (isPlaying || isPaused) {
                const nextDuration = event.target.getDuration() || durationRef.current || duration;
                if (nextDuration) {
                  setDuration(nextDuration);
                  durationRef.current = nextDuration;
                }
                emitPlaybackUpdate(event.target.getCurrentTime(), isPlaying, nextDuration, true);
              }
            },
            onError: event => {
              console.error('YouTube playback error:', youtubeVideoId, event.data);
              setIsReady(false);
              setPlaying(false);
            },
          },
        });
      })
      .catch(err => {
        console.error('YouTube IFrame API unavailable:', err);
        if (!cancelled) setIsReady(false);
      });

    return () => {
      cancelled = true;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [youtubeVideoId]);

  useEffect(() => {
    const matchingSegmentIndex = selectedPiece?.segments.findIndex(segment => segment.label === selectedPiece.segmentLabel) ?? 0;
    const nextPlaybackSource = youtubeVideoId
      ? `youtube:${youtubeVideoId}`
      : selectedPiece?.audioSrc
        ? `audio:${selectedPiece.audioSrc}`
        : null;
    const playbackSourceChanged = selectedPlaybackSourceRef.current !== nextPlaybackSource;
    selectedPlaybackSourceRef.current = nextPlaybackSource;
    const currentPlaybackDuration = readPlaybackDuration();
    const nextDuration = playbackSourceChanged
      ? 0
      : Number.isFinite(currentPlaybackDuration) && currentPlaybackDuration
        ? currentPlaybackDuration
        : durationRef.current;

    setPlaying(false);
    setActiveSegmentIndex(Math.max(0, matchingSegmentIndex));
    activeSegmentIndexRef.current = Math.max(0, matchingSegmentIndex);
    setCurrentTime(selectedPiece?.segmentStartSec ?? 0);
    setDuration(nextDuration);
    durationRef.current = nextDuration;
    setIsReady(!playbackSourceChanged && Boolean(nextDuration));
    shouldAutoPlaySelection.current = Boolean(selectedPiece);
    onPlaybackUpdate(selectedPiece ? {
      fileName: selectedPiece.fileName,
      currentTime: selectedPiece.segmentStartSec,
      duration: nextDuration,
      playing: false,
    } : null);

    if (selectedPiece && !playbackSourceChanged && isReady) {
      seekPlayback(selectedPiece.segmentStartSec);
      playPlayback();
    }
  }, [selectedPiece?.audioSrc, selectedPiece?.id, selectedPiece?.segmentLabel, selectedPiece?.segmentStartSec, selectedPiece?.segments, youtubeVideoId]);

  useEffect(() => {
    if (!playing || !selectedPiece) return;
    let rafId = 0;

    const tick = () => {
      const nextTime = readPlaybackTime();
      const nextSegmentIndex = getSegmentIndexForTime(nextTime);
      if (nextSegmentIndex !== activeSegmentIndexRef.current) {
        activeSegmentIndexRef.current = nextSegmentIndex;
        setActiveSegmentIndex(nextSegmentIndex);
      }
      setCurrentTime(nextTime);
      emitPlaybackUpdate(nextTime, true, readPlaybackDuration());
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [playing, selectedPiece?.id, useYouTubePlayback]);

  const getSegmentEnd = (index: number) => {
    if (!selectedPiece) return 0;
    const next = selectedPiece.segments[index + 1];
    if (next) return next.time;
    if (selectedPiece.segmentEndSec) return selectedPiece.segmentEndSec;
    if (duration) return duration;
    return selectedPiece.segments[index]?.time ?? 0;
  };

  const getSegmentIndexForTime = (time: number) => {
    if (!selectedPiece?.segments.length) return 0;
    for (let index = selectedPiece.segments.length - 1; index >= 0; index -= 1) {
      if (time >= selectedPiece.segments[index].time) return index;
    }
    return 0;
  };

  const handleWavePick = (piece: SpatialPiece, seconds: number) => {
    if (!selectedPiece || piece.fileName !== selectedPiece.fileName) {
      onSelectRecordById(piece.id);
      return;
    }
    if (!hasPlaybackSource) return;
    const safeTime = Math.max(0, Math.min(recordTimelineEnd(selectedRecordPieces, selectedPiece, duration), seconds));

    try {
      seekPlayback(safeTime);
      const nextSegmentIndex = selectedPiece?.segments.findIndex(segment => segment.label === piece.segmentLabel) ?? 0;
      setActiveSegmentIndex(Math.max(0, nextSegmentIndex));
      activeSegmentIndexRef.current = Math.max(0, nextSegmentIndex);
      setCurrentTime(safeTime);
      setPlaying(true);
      emitPlaybackUpdate(safeTime, true, readPlaybackDuration(), true);
      playPlayback();
      if (piece.id !== selectedPiece?.id) onSelectRecordById(piece.id);
    } catch (err) {
      console.error('Waveform segment pick error:', err);
    }
  };

  const activeSegment = selectedPiece?.segments[activeSegmentIndex];

  const activeCluster = activeSegment
    ? segmentClusters.get(activeSegment.label) ?? null
    : selectedPiece
      ? getClusterValue(selectedPiece, clusterMethod)
      : null;
  const activeClusterSize = selectedPiece ? getClusterSize(selectedPiece, clusterMethod) : null;
  const activeClusterRepresentativeId = selectedPiece ? getClusterRepresentativeId(selectedPiece, clusterMethod) : '';
  const activeClusterSummary = getClusterSummary(clusterMethod, activeCluster);
  const activeClusterCount = activeClusterSummary?.size ?? activeClusterSize ?? 0;
  const activeClusterRatio = pieces.length ? activeClusterCount / pieces.length : 0;
  const activeClusterRatioPct = Math.max(0, Math.min(100, activeClusterRatio * 100));
  const activeClusterColor = getClusterValueColor(clusterMethod, activeCluster, selectedPiece?.isOutlier);

  const activeSegmentStart = activeSegment?.time ?? selectedPiece?.segmentStartSec ?? 0;
  const activeSegmentEnd = getSegmentEnd(activeSegmentIndex);
  const segmentElapsed = Math.max(0, currentTime - activeSegmentStart);
  const segmentDuration = Math.max(0, activeSegmentEnd - activeSegmentStart);
  const showHoverTooltip = Boolean(hoveredPiece && hoverPos.x > 4 && hoverPos.y > 4);
  const activeFriendlyFeature = friendlyFeature(activeZFeature);
  const activeFriendlyCluster = friendlyCluster(clusterMethod);
  const normalizedWeightTotal = similarMatchWeights.shape + similarMatchWeights.position + similarMatchWeights.cluster || 1;
  const normalizedWeights = {
    shape: similarMatchWeights.shape / normalizedWeightTotal,
    position: similarMatchWeights.position / normalizedWeightTotal,
    cluster: similarMatchWeights.cluster / normalizedWeightTotal,
  };
  const leftComposerName = compareSummaryA.composer || 'Left composer';
  const rightComposerName = compareSummaryB.composer || 'Right composer';
  const momentDiff = compareSummaryA.segmentCount - compareSummaryB.segmentCount;
  const heightDiff = compareSummaryA.avgFeatureNorm - compareSummaryB.avgFeatureNorm;
  const pathDiff = compareSummaryA.avgTrajectoryLength - compareSummaryB.avgTrajectoryLength;
  const tallerComposer = heightDiff >= 0 ? leftComposerName : rightComposerName;
  const wigglierComposer = pathDiff >= 0 ? leftComposerName : rightComposerName;
  const momentSentence = Math.abs(momentDiff) < 60
    ? 'Both composers have a similar number of music moments in this view.'
    : `${momentDiff >= 0 ? leftComposerName : rightComposerName} has more music moments in this view.`;
  const pathSentence = Math.abs(pathDiff) < 12
    ? 'Their path shapes look fairly similar.'
    : `${wigglierComposer} has the more winding path shape.`;
  const toggleFollowMode = () => {
    const next = !focusMode;
    if (next) {
      onCameraView('iso');
      setOrthographicMode(false);
    } else {
      setOrthographicMode(true);
    }
    setFocusMode(next);
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-10 font-sans text-white select-none">
      {/* Side Panel */}
      <aside className="pointer-events-auto absolute bottom-0 left-0 top-0 w-[400px] overflow-y-auto border-r border-white/10 bg-black/86 px-6 py-6 shadow-2xl backdrop-blur-2xl">
        <div className="space-y-5">
          <header className="space-y-3">
            <div className="space-y-1.5">
              <h1 className="text-5xl leading-none font-light tracking-tight serif">Aethel</h1>
              <p className="text-[11px] uppercase tracking-[0.28em] text-white/42 italic">
                {friendlyMode ? 'Listen, look, and compare variations' : 'Archives of Classical Variation'}
              </p>
            </div>
            <div className="inline-flex rounded-full border border-white/10 bg-white/[0.035] p-1 text-[10px] uppercase tracking-[0.14em] text-white/48">
              <button
                type="button"
                onClick={() => setFriendlyMode(true)}
                className={`rounded-full px-3 py-1.5 transition-all ${
                  friendlyMode ? 'bg-white text-black' : 'hover:bg-white/8 hover:text-white/78'
                }`}
              >
                Simple
              </button>
              <button
                type="button"
                onClick={() => setFriendlyMode(false)}
                className={`rounded-full px-3 py-1.5 transition-all ${
                  !friendlyMode ? 'bg-white text-black' : 'hover:bg-white/8 hover:text-white/78'
                }`}
              >
                Expert
              </button>
            </div>
          </header>

          <div className="flex flex-col gap-4">
            <div className="relative group w-full">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 opacity-34 group-focus-within:opacity-100 transition-opacity" size={17} />
              <input
                type="text"
                placeholder={friendlyMode ? 'Find a composer or piece...' : 'Search composer or piece...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-11 w-full bg-white/5 border border-white/10 rounded-full pl-11 pr-4 text-sm tracking-wide text-white/82 placeholder:text-white/28 focus:outline-none focus:border-white/24 transition-all"
              />
            </div>

            {friendlyMode && !selectedPiece && !compareMode && (
              <div className="rounded-lg border border-white/10 bg-white/[0.045] p-4 text-sm leading-relaxed text-white/68">
                <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-white/62">
                  <MousePointer2 size={15} />
                  <span>Start here</span>
                </div>
                <div className="space-y-2.5">
                  <p><span className="text-white/95">1.</span> Click a colored dot to pick a musical moment.</p>
                  <p><span className="text-white/95">2.</span> Press play at the bottom to listen.</p>
                  <p><span className="text-white/95">3.</span> Compare or browse when you want a wider view.</p>
                </div>
              </div>
            )}

            {/* Piece info appears below search when a piece is selected */}
            <AnimatePresence>
              {selectedPiece ? (
                <motion.div
                  key="piece-info"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22 }}
                  className="space-y-2"
                >
                  <div className="relative min-h-[196px] overflow-hidden rounded-lg border border-white/10 bg-white/[0.045] p-4">
                    {useYouTubePlayback && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.34]"
                      >
                        <div ref={youtubeHostRef} className="h-full w-full" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-r from-black via-black/82 to-black/28" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/18" />
                    <div className="relative z-10 grid min-h-[164px] grid-cols-[150px_minmax(0,1fr)] items-center gap-4">
                      <div className="flex h-[150px] w-[150px] shrink-0 items-center justify-center">
                        <TsneTrajectoryThumbnail
                          recordPieces={selectedRecordPieces}
                          domainPieces={pieces}
                          activePieceId={selectedPiece.id}
                          clusterMethod={clusterMethod}
                          projection={thumbnailProjection}
                          width={150}
                          height={150}
                          showLabels
                          onSelect={piece => onSelectRecordById(piece.id)}
                        />
                      </div>
                      <div className="min-w-0 space-y-2 self-center">
                        <p className="truncate text-[10px] uppercase tracking-[0.14em] text-white/46">
                          {selectedPiece.period} · {selectedPiece.composer}
                        </p>
                        <p className="line-clamp-3 font-serif text-[23px] font-light italic leading-[1.05] text-white/95">
                          {selectedPiece.musicName}
                        </p>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono text-white/52">
                          <span>{selectedPiece.length.toFixed(2)}m</span>
                          <span>{selectedPiece.variationNum} {friendlyMode ? 'variations' : 'vars'}</span>
                          <span>{friendlyMode ? 'section ' : ''}{activeSegment?.label ?? selectedPiece.segmentLabel}</span>
                          {!friendlyMode && <span>{clusterMethod}: {activeCluster ?? 'noise'}</span>}
                          {!friendlyMode && activeClusterSize != null && <span>n={activeClusterSize}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                  {friendlyMode && (
                    <div className="rounded-lg border border-white/10 bg-black/28 p-3 text-xs leading-relaxed text-white/50">
                      <p>
                        This dot is one section from the piece. Nearby dots usually sound or behave more alike in the learned music map.
                      </p>
                    </div>
                  )}
                  {!friendlyMode && activeClusterRepresentativeId && (
                    <p className="mt-1 truncate text-[10px] font-mono uppercase tracking-[0.12em] text-white/36">
                      representative {activeClusterRepresentativeId}
                    </p>
                  )}
                  {!friendlyMode && activeClusterSummary && (
                    <div className="mt-2 rounded-lg border border-white/10 bg-black/35 p-3 text-xs font-mono text-white/48">
                      <div className="mb-2 flex items-center justify-between gap-3 uppercase tracking-[0.12em] text-white/64">
                        <span className="inline-flex items-center gap-2"><Layers3 size={14} /> Composition</span>
                        <span>{activeClusterSummary.role}</span>
                      </div>

                      <div className="mb-2 space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-white/42">
                          <span>{activeClusterCount} segments</span>
                          <span>{activeClusterRatioPct.toFixed(1)}% of corpus</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-white/8">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${activeClusterRatioPct}%`,
                              minWidth: activeClusterRatioPct > 0 ? 2 : 0,
                              backgroundColor: activeClusterColor,
                            }}
                          />
                        </div>
                      </div>

                      <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 uppercase tracking-[0.1em] text-white/42">
                        <span>Theme share {(activeClusterSummary.themeRatio * 100).toFixed(1)}%</span>
                        <span>{activeClusterSummary.themeCount} themes</span>
                        <span>{activeClusterSummary.variationCount} variations</span>
                      </div>
                      <div className="space-y-0.5 normal-case tracking-normal">
                        <p className="truncate">Historical profile: {compactSummaryList(activeClusterSummary.topPeriods).join(' · ')}</p>
                        <p className="truncate">Composer concentration: {compactSummaryList(activeClusterSummary.topComposers).join(' · ')}</p>
                        <p className="truncate">Structural labels: {compactSummaryList(activeClusterSummary.topLabels, 4).join(' · ')}</p>
                      </div>
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="period-pills"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex flex-wrap gap-2"
                >
                  {availablePeriods.map(period => (
                    <button
                      key={period}
                      onClick={() => setActivePeriod(activePeriod === period ? null : period)}
                      className={`px-3.5 py-1.5 rounded-full text-[11px] uppercase tracking-widest border transition-all ${
                        activePeriod === period
                          ? 'bg-white text-black border-white'
                          : 'bg-white/5 border-white/5 opacity-50 hover:opacity-100 hover:border-white/10'
                      }`}
                    >
                      {period}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2 text-xs uppercase tracking-[0.14em] text-white/44">
              <Music2 size={15} />
              <span>{piecesCount} {friendlyMode ? 'music moments shown' : 'segments shown'}</span>
            </div>

            {!friendlyMode && (
            <section className="space-y-3 rounded-lg border border-white/10 bg-white/[0.025] p-4">
               <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-white/54">
                 <Box size={16} />
                 <span>{friendlyMode ? 'Picture' : 'Space'}</span>
               </div>
               <div className="grid grid-cols-1 gap-3">
                  {friendlyMode ? (
                    <div className="space-y-1.5">
                      <p className="text-sm text-white/72">Music space</p>
                      <p className="text-xs normal-case leading-snug tracking-normal text-white/42">
                        Dots that sit close together usually sound or behave more alike. Dots farther apart are more different.
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-5 gap-y-1 font-mono uppercase tracking-[0.08em]">
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-white/38">X</span>
                        <p className="text-sm text-white/72">t-SNE X</p>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-white/38">Y</span>
                        <p className="text-sm text-white/72">t-SNE Y</p>
                      </div>
                      <p className="col-span-2 text-[11px] normal-case leading-snug tracking-normal text-white/34">
                        embedding plane fixed
                      </p>
                    </div>
                  )}
                  <div className={`w-full ${friendlyMode ? '' : 'font-mono uppercase tracking-[0.08em]'}`}>
                    <label htmlFor="z-axis-feature" className="text-[10px] text-white/42">
                      {friendlyMode ? 'Height shows' : 'Z feature'}
                    </label>
                    <div className="relative mt-1">
                      <select
                        id="z-axis-feature"
                        value={activeZFeature}
                        onChange={(event) => onUpdateConfig({ zAxis: `feature:${event.target.value}` })}
                        className="w-full appearance-none rounded border border-white/10 bg-black/45 py-2.5 pl-3 pr-8 text-xs uppercase tracking-[0.07em] text-white/76 outline-none transition-colors hover:border-white/20 focus:border-white/35"
                      >
                        {zFeatureOptions.map(feature => (
                          <option key={feature} value={feature}>
                            {friendlyMode ? friendlyFeature(feature).label : plainMetricName(feature)}
                          </option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-white/35">v</span>
                    </div>
                    <p className="mt-1.5 text-xs normal-case leading-snug tracking-normal text-white/42">
                      {friendlyMode
                        ? activeFriendlyFeature.description
                        : metricDescription(activeZFeature) || 'selected feature height'}
                    </p>
                  </div>
                  <div className={`w-full ${friendlyMode ? '' : 'font-mono uppercase tracking-[0.08em]'}`}>
                    <label htmlFor="cluster-method" className="text-[10px] text-white/42">
                      {friendlyMode ? 'Color groups' : 'Cluster method'}
                    </label>
                    <div className="relative mt-1">
                      <select
                        id="cluster-method"
                        value={clusterMethod}
                        onChange={(event) => setClusterMethod(event.target.value as ClusterMethod)}
                        className="w-full appearance-none rounded border border-white/10 bg-black/45 py-2.5 pl-3 pr-8 text-xs uppercase tracking-[0.07em] text-white/76 outline-none transition-colors hover:border-white/20 focus:border-white/35"
                      >
                        {CLUSTER_METHOD_OPTIONS.map(option => (
                          <option key={option.id} value={option.id}>
                            {friendlyMode ? friendlyCluster(option.id).label : option.label}
                          </option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-white/35">v</span>
                    </div>
                    <p className="mt-1.5 text-xs normal-case leading-snug tracking-normal text-white/42">
                      {friendlyMode
                        ? activeFriendlyCluster.description
                        : CLUSTER_METHOD_OPTIONS.find(option => option.id === clusterMethod)?.description ?? 'cluster layer'}
                    </p>
                  </div>
               </div>
            </section>
            )}

            {compareMode && (
            <section className="space-y-3 rounded-lg border border-white/10 bg-white/[0.025] p-4 font-mono uppercase tracking-[0.08em]">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-white/54">
                <GitCompare size={16} />
                <span>{friendlyMode ? 'Compare' : 'Compare Setup'}</span>
              </div>
              <div className="space-y-2.5">
                  <div className="grid w-full grid-cols-2 gap-2">
                    <div className="min-w-0">
                      <label htmlFor="compare-composer-a" className="text-[10px] text-white/40">
                        {friendlyMode ? 'Left composer' : 'Left'}
                      </label>
                      <select
                        id="compare-composer-a"
                        value={compareComposerA}
                        onChange={(event) => setCompareComposerA(event.target.value)}
                        className="mt-1 w-full appearance-none rounded border border-white/10 bg-black/45 px-2 py-2 text-xs text-white/76 outline-none transition-colors hover:border-white/20 focus:border-white/35"
                      >
                        {composerOptions.map(option => (
                          <option key={option.composer} value={option.composer}>
                            {option.composer} ({option.count})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="min-w-0">
                      <label htmlFor="compare-composer-b" className="text-[10px] text-white/40">
                        {friendlyMode ? 'Right composer' : 'Right'}
                      </label>
                      <select
                        id="compare-composer-b"
                        value={compareComposerB}
                        onChange={(event) => setCompareComposerB(event.target.value)}
                        className="mt-1 w-full appearance-none rounded border border-white/10 bg-black/45 px-2 py-2 text-xs text-white/76 outline-none transition-colors hover:border-white/20 focus:border-white/35"
                      >
                        {composerOptions.map(option => (
                          <option key={option.composer} value={option.composer}>
                            {option.composer} ({option.count})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {!friendlyMode && (
                    <div className="w-full rounded border border-white/10 bg-black/45 p-3 text-xs text-white/50 backdrop-blur-xl">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-white/62">Match weights</span>
                        <span className="text-[9px] normal-case tracking-normal text-white/30">
                          normalized for scoring
                        </span>
                      </div>
                      <div className="space-y-2">
                        <MatchWeightSlider
                          label="Path shape"
                          value={similarMatchWeights.shape}
                          onChange={(shape) => setSimilarMatchWeights({ ...similarMatchWeights, shape })}
                        />
                        <MatchWeightSlider
                          label="Map position"
                          value={similarMatchWeights.position}
                          onChange={(position) => setSimilarMatchWeights({ ...similarMatchWeights, position })}
                        />
                        <MatchWeightSlider
                          label="Color groups"
                          value={similarMatchWeights.cluster}
                          onChange={(cluster) => setSimilarMatchWeights({ ...similarMatchWeights, cluster })}
                        />
                      </div>
                      <p className="mt-2 text-[10px] normal-case tracking-normal text-white/34">
                        Active mix: shape {Math.round(normalizedWeights.shape * 100)}%, position {Math.round(normalizedWeights.position * 100)}%, cluster {Math.round(normalizedWeights.cluster * 100)}%.
                      </p>
                    </div>
                  )}

                  {!friendlyMode && (
                  <div className="w-full rounded border border-white/10 bg-black/45 p-3 text-xs text-white/50 backdrop-blur-xl">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-white/62">{friendlyMode ? 'Quick comparison' : 'Difference summary'}</span>
                      <span className="text-[9px] normal-case tracking-normal text-white/30">
                        {friendlyMode ? activeFriendlyFeature.label : plainMetricName(activeCompareFeature)}
                      </span>
                    </div>
                    {friendlyMode ? (
                      <div className="space-y-3 normal-case leading-relaxed tracking-normal text-white/58">
                        <p>
                          {momentSentence}
                        </p>
                        <p>
                          For <span className="text-white/82">{activeFriendlyFeature.label.toLowerCase()}</span>, <span className="text-white/82">{tallerComposer}</span> usually sits higher.
                        </p>
                        <p>
                          {pathSentence}
                        </p>
                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <div className="rounded border border-white/8 bg-white/[0.035] p-2">
                            <p className="text-[10px] uppercase tracking-[0.1em] text-white/34">Pieces</p>
                            <p className="mt-1 text-white/72">{compareSummaryA.recordCount} vs {compareSummaryB.recordCount}</p>
                          </div>
                          <div className="rounded border border-white/8 bg-white/[0.035] p-2">
                            <p className="text-[10px] uppercase tracking-[0.1em] text-white/34">Theme share</p>
                            <p className="mt-1 text-white/72">{fmtPct(compareSummaryA.themeShare)} vs {fmtPct(compareSummaryB.themeShare)}</p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1fr_0.85fr_0.85fr_0.65fr] gap-x-2 gap-y-1.5 normal-case tracking-normal">
                        <span className="uppercase tracking-[0.08em] text-white/28">Metric</span>
                        <span className="truncate uppercase tracking-[0.08em] text-white/36" title={compareSummaryA.composer}>Left</span>
                        <span className="truncate uppercase tracking-[0.08em] text-white/36" title={compareSummaryB.composer}>Right</span>
                        <span className="uppercase tracking-[0.08em] text-white/36">Diff</span>

                        <span>Segments</span>
                        <span>{compareSummaryA.segmentCount}</span>
                        <span>{compareSummaryB.segmentCount}</span>
                        <span>{summaryDelta(compareSummaryA.segmentCount, compareSummaryB.segmentCount, 0)}</span>

                        <span>Records</span>
                        <span>{compareSummaryA.recordCount}</span>
                        <span>{compareSummaryB.recordCount}</span>
                        <span>{summaryDelta(compareSummaryA.recordCount, compareSummaryB.recordCount, 0)}</span>

                        <span>Theme share</span>
                        <span>{fmtPct(compareSummaryA.themeShare)}</span>
                        <span>{fmtPct(compareSummaryB.themeShare)}</span>
                        <span>{summaryDelta(compareSummaryA.themeShare * 100, compareSummaryB.themeShare * 100, 1)}pp</span>

                        <span>Dominant cluster</span>
                        <span>{compareSummaryA.dominantCluster ?? 'n/a'} · {fmtPct(compareSummaryA.dominantClusterShare)}</span>
                        <span>{compareSummaryB.dominantCluster ?? 'n/a'} · {fmtPct(compareSummaryB.dominantClusterShare)}</span>
                        <span>{summaryDelta(compareSummaryA.dominantClusterShare * 100, compareSummaryB.dominantClusterShare * 100, 1)}pp</span>

                        <span>Avg feature</span>
                        <span>{fmtMetric(compareSummaryA.avgFeatureNorm, 3)}</span>
                        <span>{fmtMetric(compareSummaryB.avgFeatureNorm, 3)}</span>
                        <span>{summaryDelta(compareSummaryA.avgFeatureNorm, compareSummaryB.avgFeatureNorm, 3)}</span>

                        <span>Avg trajectory</span>
                        <span>{fmtMetric(compareSummaryA.avgTrajectoryLength, 1)}</span>
                        <span>{fmtMetric(compareSummaryB.avgTrajectoryLength, 1)}</span>
                        <span>{summaryDelta(compareSummaryA.avgTrajectoryLength, compareSummaryB.avgTrajectoryLength, 1)}</span>
                      </div>
                    )}
                  </div>
                  )}

                  <div className="w-full rounded border border-[#c8a55a]/20 bg-[#221706]/70 p-3 text-xs text-white/52 shadow-[inset_0_1px_0_rgba(231,201,128,0.06)] backdrop-blur-xl">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-white/66">{friendlyMode ? 'Closest match' : 'Similar record'}</span>
                      <span className="text-[9px] normal-case tracking-normal text-white/30">
                        {friendlyMode ? 'overall likeness' : 'weighted match'}
                      </span>
                    </div>
                    {similarRecordMatch ? (
                      <div className="space-y-2 normal-case tracking-normal">
                        <div className="space-y-1">
                          <p className="truncate text-white/78" title={similarRecordMatch.targetMusicName}>
                            {similarRecordMatch.targetMusicName}
                          </p>
                          <p className="truncate text-white/38" title={similarRecordMatch.targetFileName}>
                            {similarRecordMatch.targetComposer} · {similarRecordMatch.targetFileName}
                          </p>
                        </div>
                        {friendlyMode ? (
                          <div className="space-y-2">
                            <p className="leading-relaxed text-white/52">
                              This is the closest match using path shape, map position, and color groups together.
                            </p>
                            <div>
                              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.1em] text-white/34">
                                <span>Match strength</span>
                                <span>{fmtPct(similarRecordMatch.score)}</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-[#b8954c]/14">
                                <div
                                  className="h-full rounded-full bg-[#d8bc75]/80"
                                  style={{ width: `${Math.max(4, Math.min(100, similarRecordMatch.score * 100))}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-4 gap-2 font-mono uppercase tracking-[0.08em]">
                            <div>
                              <p className="text-[9px] text-white/30">Score</p>
                              <p className="text-white/70">{fmtPct(similarRecordMatch.score)}</p>
                            </div>
                            <div>
                              <p className="text-[9px] text-white/30">Shape</p>
                              <p className="text-white/70">{fmtMetric(similarRecordMatch.shapeDistance, 3)}</p>
                            </div>
                            <div>
                              <p className="text-[9px] text-white/30">Position</p>
                              <p className="text-white/70">{fmtMetric(similarRecordMatch.positionDistance, 2)}</p>
                            </div>
                            <div>
                              <p className="text-[9px] text-white/30">Cluster</p>
                              <p className="text-white/70">{fmtPct(1 - similarRecordMatch.clusterDistance)}</p>
                            </div>
                          </div>
                        )}
                        {similarRecordMatch.targetRepresentativeId && (
                          <button
                            type="button"
                            onClick={() => onSelectRecordById(similarRecordMatch.targetRepresentativeId)}
                            className={`rounded border border-[#c8a55a]/22 bg-[#d6b464]/[0.055] px-2.5 py-1.5 text-white/58 transition-colors hover:border-[#d8bc75]/38 hover:bg-[#d6b464]/[0.085] hover:text-white/84 ${
                              friendlyMode ? 'text-xs' : 'font-mono text-[10px] uppercase tracking-[0.1em]'
                            }`}
                          >
                            {friendlyMode ? 'Open this match' : 'Select match'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="normal-case leading-snug tracking-normal text-white/34">
                        {friendlyMode
                          ? 'Click a piece in either side. The app will find the closest path from the other composer.'
                          : 'Select a record in either composer panel to find the closest trajectory from the other composer.'}
                      </p>
                    )}
                  </div>
              </div>
            </section>
            )}
          </div>
        </div>
      </aside>
        
        <div className="pointer-events-auto fixed right-6 top-5 z-30 flex max-w-[calc(100vw-430px)] flex-wrap items-center justify-end gap-1.5 rounded-full border border-white/10 bg-black/52 px-2.5 py-2 shadow-2xl backdrop-blur-xl">
          {!focusMode && (
            <div className="flex items-center gap-1 rounded-full bg-white/[0.045] p-1">
              {(['top', 'side', 'iso'] as const).map(view => (
                <button
                  key={view}
                  type="button"
                  onClick={() => onCameraView(view)}
                  className={`rounded-full px-2.5 py-1 text-xs font-light uppercase tracking-[0.14em] transition-colors ${
                    currentCameraView === view
                      ? 'bg-white/16 text-white'
                      : 'text-white/54 hover:bg-white/8 hover:text-white/82'
                  }`}
                >
                  {cameraLabel(view, friendlyMode)}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            title={focusMode ? 'Stop following playback' : 'Follow playback in depth 3D'}
            onClick={toggleFollowMode}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-light uppercase tracking-[0.14em] transition-colors ${
              focusMode
                ? 'bg-white/18 text-white'
                : 'text-white/54 hover:bg-white/8 hover:text-white/82'
            }`}
          >
            <Headphones size={13} />
            {focusMode ? 'Following' : 'Follow'}
          </button>

          <button
            type="button"
            onClick={() => setGalleryMode(!galleryMode)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-light uppercase tracking-[0.14em] transition-colors ${
              galleryMode
                ? 'bg-white/18 text-white'
                : 'text-white/54 hover:bg-white/8 hover:text-white/82'
            }`}
          >
            <Table2 size={13} />
            {friendlyMode ? 'Gallery' : 'Gallery'}
          </button>

          <button
            type="button"
            onClick={() => setCompareMode(!compareMode)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-light uppercase tracking-[0.14em] transition-colors ${
              compareMode
                ? 'bg-white/18 text-white'
                : 'text-white/54 hover:bg-white/8 hover:text-white/82'
            }`}
          >
            <GitCompare size={13} />
            {friendlyMode ? 'Compare' : 'Compare'}
          </button>
        </div>

      {/* Details Panel */}
      <AnimatePresence>
        {selectedPiece && (
          <motion.div
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
            className={`absolute bottom-0 left-[400px] right-0 bg-black/92 backdrop-blur-3xl border-t border-white/10 pointer-events-auto shadow-2xl z-20 overflow-visible ${
              showCompareWaveStrips ? 'h-[184px]' : 'h-[144px]'
            }`}
          >
            <button 
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="absolute top-2.5 right-4 p-2 opacity-40 hover:opacity-100 transition-opacity cursor-pointer z-10"
            >
              <X size={18} />
            </button>

            {/* Bottom panel: [play btn] [waveform strips] */}
            <div className={`flex h-full min-w-0 gap-4 pr-14 ${showCompareWaveStrips ? 'px-6 py-4' : 'px-5 py-3'}`}>
              {/* Play / Pause button */}
              {hasPlaybackSource && (
                <div className={`shrink-0 flex ${showCompareWaveStrips ? 'w-11 items-center justify-center' : 'items-center'}`}>
                  <button
                    onClick={() => {
                      if (!isReady) return;
                      if (!playing) {
                        const audioDuration = readPlaybackDuration();
                        if (audioDuration && readPlaybackTime() >= audioDuration - 0.05) {
                          const activeStart = selectedPiece.segments[activeSegmentIndex]?.time ?? selectedPiece.segmentStartSec;
                          seekPlayback(activeStart);
                          setCurrentTime(activeStart);
                          emitPlaybackUpdate(activeStart, true, audioDuration, true);
                        }
                        playPlayback();
                      } else {
                        pausePlayback();
                      }
                    }}
                    className={`${showCompareWaveStrips ? 'h-11 w-11' : 'h-12 w-12'} bg-white/92 text-black rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shrink-0 shadow-lg shadow-white/10`}
                  >
                    {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} className="translate-x-0.5" fill="currentColor" />}
                  </button>
                </div>
              )}

              {/* Waveform */}
              {hasPlaybackSource && (
                <div className={`flex-1 min-w-0 flex flex-col ${showCompareWaveStrips ? 'justify-center gap-3' : 'justify-center gap-2'}`}>
                  <section className="min-w-0 flex flex-col gap-1.5">
                    <AnimatePresence initial={false} mode="popLayout">
                    {showCompareWaveStrips && (
                      <motion.div
                        key={`selected-${selectedPiece.fileName}`}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                        className="grid grid-cols-[116px_1fr_40px] items-center gap-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[10px] uppercase tracking-[0.14em] text-white/38">
                            {friendlyMode ? 'Now playing' : 'Playing record'}
                          </p>
                          <p className="truncate text-xs text-white/70" title={selectedPiece.musicName}>
                            {selectedPiece.musicName}
                          </p>
                          <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-white/42">
                            {(activeSegment?.label ?? selectedPiece.segmentLabel)} · {fmtTime(segmentElapsed)} / {fmtTime(segmentDuration)}
                          </p>
                        </div>
                        <RecordWaveBar
                          piece={selectedPiece}
                          recordPieces={selectedRecordPieces}
                          clusterMethod={clusterMethod}
                          activePieceId={selectedPiece.id}
                          currentTime={currentTime}
                          duration={duration}
                          className="h-11"
                          showLabels
                          showProgress
                          onPick={handleWavePick}
                        />
                        <div className="h-10 w-10" />
                      </motion.div>
                    )}
                    </AnimatePresence>
                    {!showCompareWaveStrips && (
                      <RecordWaveBar
                        piece={selectedPiece}
                        recordPieces={selectedRecordPieces}
                        clusterMethod={clusterMethod}
                        activePieceId={selectedPiece.id}
                        currentTime={currentTime}
                        duration={duration}
                        className="flex-1 min-h-[72px]"
                        showLabels
                        showProgress
                        onPick={handleWavePick}
                      />
                    )}

                    {!showCompareWaveStrips && (
                    <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-[0.14em] text-white/46">
                      <span className="text-white/68">{activeSegment?.label ?? selectedPiece.segmentLabel}</span>
                      <span>{fmtTime(segmentElapsed)} / {fmtTime(segmentDuration)}</span>
                    </div>
                    )}
                  </section>

                  {showCompareWaveStrips && comparisonPiece && (
                    <AnimatePresence initial={false} mode="popLayout">
                      <motion.div
                        key={`match-${comparisonPiece.fileName}`}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <section className="grid min-h-0 grid-cols-[116px_1fr_40px] items-center gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-white/38">
                              {friendlyMode ? 'Closest match' : 'Matched record'}
                            </p>
                            <p className="truncate text-xs text-white/70" title={comparisonPiece.musicName}>
                              {comparisonPiece.musicName}
                            </p>
                          </div>
                          <RecordWaveBar
                            piece={comparisonPiece}
                            recordPieces={comparisonRecordPieces}
                            clusterMethod={clusterMethod}
                            activePieceId={selectedPiece?.fileName === comparisonPiece.fileName ? selectedPiece.id : comparisonPiece.id}
                            className="h-11"
                            onPick={(piece) => onSelectRecordById(piece.id)}
                          />
                          <button
                            type="button"
                            onClick={() => onSelectRecordById(similarRecordMatch?.targetRepresentativeId ?? comparisonPiece.id)}
                            aria-label="Switch to this record"
                            title="Switch to this record"
                            className="inline-flex h-10 w-10 items-center justify-center rounded border border-white/10 bg-white/[0.045] text-white/54 transition-colors hover:border-white/22 hover:bg-white/[0.075] hover:text-white/82"
                          >
                            <ArrowUpDown size={15} />
                          </button>
                        </section>
                      </motion.div>
                    </AnimatePresence>
                  )}

                  {!useYouTubePlayback && (
                    <audio
                      ref={audioRef}
                      src={selectedPiece.audioSrc}
                      preload="metadata"
                      onCanPlay={() => setIsReady(true)}
                      onLoadedMetadata={(event) => {
                        const nextDuration = event.currentTarget.duration || 0;
                        setDuration(nextDuration);
                        durationRef.current = nextDuration;
                        event.currentTarget.currentTime = selectedPiece.segmentStartSec;
                        setCurrentTime(selectedPiece.segmentStartSec);
                        emitPlaybackUpdate(selectedPiece.segmentStartSec, shouldAutoPlaySelection.current, nextDuration, true);
                        if (shouldAutoPlaySelection.current) {
                          shouldAutoPlaySelection.current = false;
                          void event.currentTarget.play().catch(() => {});
                        }
                      }}
                      onTimeUpdate={(event) => {
                        const t = event.currentTarget.currentTime;
                        const nextSegmentIndex = getSegmentIndexForTime(t);
                        if (nextSegmentIndex !== activeSegmentIndexRef.current) {
                          activeSegmentIndexRef.current = nextSegmentIndex;
                          setActiveSegmentIndex(nextSegmentIndex);
                        }
                        setCurrentTime(t);
                        emitPlaybackUpdate(t, !event.currentTarget.paused, event.currentTarget.duration || duration);
                      }}
                      onPlay={(event) => {
                        setPlaying(true);
                        emitPlaybackUpdate(event.currentTarget.currentTime, true, event.currentTarget.duration || duration, true);
                      }}
                      onPause={(event) => {
                        setPlaying(false);
                        emitPlaybackUpdate(event.currentTarget.currentTime, false, event.currentTarget.duration || duration, true);
                      }}
                      onEnded={(event) => {
                        setPlaying(false);
                        emitPlaybackUpdate(event.currentTarget.currentTime, false, event.currentTarget.duration || duration, true);
                      }}
                      onError={(event) => {
                        console.error('Local audio playback error:', selectedPiece.audioSrc, event.currentTarget.error);
                        setIsReady(false);
                      }}
                      className="hidden"
                    />
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Info */}
      {!selectedPiece && (
        <div className="pointer-events-none absolute bottom-12 left-[400px] right-0 flex justify-center">
          <div className="px-4 py-2 bg-black/40 backdrop-blur-sm rounded-full border border-white/5 opacity-60">
            <p className="text-[10px] uppercase tracking-[0.5em] animate-pulse">
              {friendlyMode ? 'Click any dot to hear the music' : 'Select a piece to begin exploration'}
            </p>
          </div>
        </div>
      )}

      {/* Hover tooltip — fixed overlay, follows cursor */}
      <AnimatePresence>
        {showHoverTooltip && hoveredPiece && (
          <motion.div
            key={hoveredPiece.id}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.12 }}
            className="fixed pointer-events-none z-50"
            style={{
              left: hoverPos.x + 14,
              top: hoverPos.y - 10,
              transform: hoverPos.x > window.innerWidth * 0.7 ? 'translateX(calc(-100% - 28px))' : undefined,
            }}
          >
            <div className="bg-black/85 backdrop-blur-xl border border-white/10 rounded-lg px-3.5 py-2.5 shadow-2xl">
              <p className="text-white/40 text-[9px] uppercase tracking-[0.3em]">{hoveredPiece.period} · {hoveredPiece.composer}</p>
              <p className="text-white text-sm font-light serif italic">{hoveredPiece.musicName}</p>
              <p className="text-white/40 text-[10px] font-mono">{hoveredPiece.segmentLabel} · {hoveredPiece.fileName}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default UIOverlay;
