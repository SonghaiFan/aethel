"""
tv_core.py  —  Theme & Variations project core library
=======================================================
Centralised module for all reusable logic: paths, data loading,
feature extraction, MERT embedding, I/O helpers, and frontend export.

Designed so every notebook cell becomes a one-liner:

    from tv_core import TVDataset, Handcrafted, MERTEmbedder, Paths, FrontendExporter

    ds  = TVDataset()               # loads data/TV_annotation_clean.csv
    mbh = ds.mbh_piano()            # Mozart / Beethoven / Haydn piano subset

    hc  = Handcrafted()
    df_feat = hc.extract_batch(mbh) # returns DataFrame, saves CSV

    me  = MERTEmbedder()
    emb, meta = me.extract_batch(mbh)  # returns (N×1024 ndarray, DataFrame)

    # After running the full pipeline, export everything for the frontend:
    exporter = FrontendExporter(ds)
    exporter.run(df_ann=ds.df, df_reduction=df_reduction,
                 df_clusters=df_clusters, thumbnail_df=thumbnail_df,
                 selection=selection, output_suffix=OUTPUT_SUFFIX)
"""

from __future__ import annotations

import re
import os
import gc
import time
import warnings
from pathlib import Path
from typing import Callable, Iterable, Literal

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# librosa imports numba-jitted helpers. On the local Python 3.13 conda build,
# numba needs an explicit writable cache location before librosa is imported.
os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(".numba_cache").resolve()))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1.  PATHS  — single source of truth for all file locations
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class Paths:
    """Project-wide path constants.  All relative to ``root``."""

    def __init__(self, root: str | Path = ".", csv_name: str = "data/TV_annotation_clean.csv"):
        self.root      = Path(root).resolve()
        self.audio     = self.root / "audio"
        self.features  = self.root / "features"
        self.embeddings = self.root / "embeddings"
        self.data      = self.root / "data"
        self.models    = self.root / "models"
        # If user passed a bare filename (no directory), assume it lives under `data/`.
        csv_path = Path(csv_name)
        if csv_path.parent == Path("."):
            csv_path = Path("data") / csv_path.name
        self.csv_clean = self.root / csv_path

        self.features.mkdir(exist_ok=True)
        self.embeddings.mkdir(exist_ok=True)
        self.models.mkdir(exist_ok=True)

    def segment_wav(self, folder: str, fname: str, label: str) -> Path:
        return self.audio / folder / fname / f"{label}.wav"

    def raw_wav(self, folder: str, fname: str) -> Path:
        return self.audio / folder / f"{fname}.wav"

    def __repr__(self) -> str:
        return f"Paths(root={self.root})"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2.  DATASET  — load, filter, iterate
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_CORE_PAT  = re.compile(r"^(T|V[0-9]+)$")
_EXTRA_PAT = re.compile(r"^(I|C|Inter|B)$")

LabelSet = Literal["core", "extra", "all"]


class TVDataset:
    """
    Wrapper around TV_annotation_clean.csv.

    Parameters
    ----------
    root : str | Path
        Project root directory (default: current working directory).

    Examples
    --------
    >>> ds = TVDataset()
    >>> ds.df.shape
    (692, ...)
    >>> mbh = ds.mbh_piano()
    >>> len(mbh)
    277
    """

    # Composers for MBH subset
    MBH_COMPOSERS = [
        "Wolfgang Amadeus Mozart",
        "Ludwig van Beethoven",
        "Joseph Haydn",
    ]

    # ── Named subset definitions ─────────────────────────────────
    # Each entry: (description, composers_filter, instruments_filter, periods_filter)
    # None means "no filter on this axis".
    SUBSETS: dict[str, dict] = {
        # Original focus: Classical-era piano works by Mozart/Beethoven/Haydn
        "mbh_piano": dict(
            description="Mozart / Beethoven / Haydn — piano only",
            composers=MBH_COMPOSERS,
            instruments=["piano"],
            periods=None,
        ),
        # All piano works regardless of period or composer
        "piano_all": dict(
            description="All composers — piano only (Classical + Romantic + Modern)",
            composers=None,
            instruments=["piano"],
            periods=None,
        ),
        # Piano works by period
        "piano_classical": dict(
            description="Classical period — piano only",
            composers=None,
            instruments=["piano"],
            periods=["Classical"],
        ),
        "piano_romantic": dict(
            description="Romantic period — piano only",
            composers=None,
            instruments=["piano"],
            periods=["Romantic"],
        ),
        "piano_modern": dict(
            description="Modern period — piano only",
            composers=None,
            instruments=["piano"],
            periods=["Modern"],
        ),
        # Full dataset — every instrument and period
        "all": dict(
            description="Full dataset — all composers, instruments, and periods",
            composers=None,
            instruments=None,
            periods=None,
        ),
    }

    def __init__(self, root: str | Path = ".", csv_name: str = "data/TV_annotation_clean.csv"):
        self.paths = Paths(root, csv_name=csv_name)
        self.df    = pd.read_csv(self.paths.csv_clean)
        print(f"TVDataset: loaded {len(self.df)} records from {self.paths.csv_clean.name}")

    # ── Subset helpers ───────────────────────────────────────────

    def mbh_piano(self) -> pd.DataFrame:
        """Mozart / Beethoven / Haydn, instrument == 'piano'. (Shortcut for subset('mbh_piano').)"""
        return self.subset("mbh_piano")

    def subset(self, name: str = "mbh_piano") -> pd.DataFrame:
        """
        Return a named subset of the dataset.

        Parameters
        ----------
        name : str
            One of the keys in TVDataset.SUBSETS:
              'mbh_piano'       — Mozart / Beethoven / Haydn, piano only  (default)
              'piano_all'       — all piano works across all periods
              'piano_classical' — Classical-period piano
              'piano_romantic'  — Romantic-period piano
              'piano_modern'    — Modern-period piano
              'all'             — entire dataset, no filtering

        Returns
        -------
        pd.DataFrame
            Filtered copy of self.df.
        """
        if name not in self.SUBSETS:
            valid = ", ".join(f"'{k}'" for k in self.SUBSETS)
            raise ValueError(f"Unknown subset {name!r}. Valid options: {valid}")

        spec = self.SUBSETS[name]
        sub  = self.filter(
            composers   = spec["composers"],
            instruments = spec["instruments"],
            periods     = spec["periods"],
        )
        print(f"Subset '{name}' ({spec['description']}): {len(sub)} records")
        return sub

    def filter(
        self,
        composers: list[str] | None = None,
        instruments: list[str] | None = None,
        periods: list[str] | None = None,
    ) -> pd.DataFrame:
        """Flexible subset selection. Pass None for any axis to skip that filter."""
        mask = pd.Series([True] * len(self.df), index=self.df.index)
        if composers:
            mask &= self.df["composer"].isin(composers)
        if instruments:
            mask &= self.df["instrument"].str.lower().str.strip().isin(
                [i.lower() for i in instruments]
            )
        if periods:
            mask &= self.df["period"].isin(periods)
        return self.df[mask].copy().reset_index(drop=True)

    # ── Label helpers ────────────────────────────────────────────

    @staticmethod
    def _raw_labels(row: pd.Series) -> list[str]:
        return [s.strip() for s in str(row["label"]).split(";") if s.strip()]

    @staticmethod
    def _label_in_set(label: str, which: LabelSet) -> bool:
        if which == "all":
            return True
        if which == "core":
            return bool(_CORE_PAT.match(label))
        if which == "extra":
            return bool(_EXTRA_PAT.match(label))
        raise ValueError(f"which must be 'core', 'extra', or 'all', got {which!r}")

    @staticmethod
    def occurrence_label(label: str, occurrence: int, total: int) -> str:
        """Return the disk/cache label for a repeated segment label."""
        return f"{label}__{occurrence + 1}" if total > 1 else label

    @staticmethod
    def base_label(label: str) -> str:
        """Strip occurrence suffix from a segment label if present."""
        return re.sub(r"__\d+$", "", str(label))

    @classmethod
    def segment_specs(cls, row: pd.Series, which: LabelSet = "core") -> list[dict]:
        """Return ordered segment metadata with occurrence-aware disk labels."""
        labels = cls._raw_labels(row)
        totals = pd.Series(labels).value_counts().to_dict()
        seen: dict[str, int] = {}
        specs = []
        for position, label in enumerate(labels):
            occurrence = seen.get(label, 0)
            seen[label] = occurrence + 1
            if not cls._label_in_set(label, which):
                continue
            total = int(totals.get(label, 1))
            specs.append({
                "position": position,
                "label": label,
                "segment_label": cls.occurrence_label(label, occurrence, total),
                "occurrence": occurrence,
                "occurrence_total": total,
            })
        return specs

    @classmethod
    def labels(cls, row: pd.Series, which: LabelSet = "core") -> list[str]:
        """
        Return labels for a row filtered by ``which``:
          'core'  → T, V1..Vn
          'extra' → I, C, Inter, B
          'all'   → all labels

        Repeated labels in the same record are made occurrence-aware, e.g.
        ``T__1``, ``T__2``. Non-repeated labels keep their original name.
        """
        return [spec["segment_label"] for spec in cls.segment_specs(row, which)]

    def segment_path(self, row: pd.Series, label: str) -> Path:
        return self.paths.segment_wav(row["folder"], row["file_name (folderName_number)"], label)

    def raw_wav_path(self, row: pd.Series) -> Path:
        return self.paths.raw_wav(row["folder"], row["file_name (folderName_number)"])

    # ── Segment iterator ─────────────────────────────────────────

    def iter_segments(
        self,
        df: pd.DataFrame | None = None,
        which: LabelSet = "core",
        skip: set[str] | None = None,
    ) -> Iterable[tuple[pd.Series, str, Path]]:
        """
        Yield (row, label, wav_path) for every existing segment WAV.

        Parameters
        ----------
        df    : subset DataFrame (default: self.df)
        which : label set to iterate ('core' | 'extra' | 'all')
        skip  : set of file_name values to skip
        """
        df    = self.df if df is None else df
        skip  = skip or set()
        for _, row in df.iterrows():
            fname = row["file_name (folderName_number)"]
            if fname in skip:
                continue
            for spec in self.segment_specs(row, which):
                lbl = spec["segment_label"]
                wav = self.segment_path(row, lbl)
                if wav.exists():
                    yield row, lbl, wav

    # ── Summary ──────────────────────────────────────────────────

    def summary(self, df: pd.DataFrame | None = None) -> pd.DataFrame:
        df = self.df if df is None else df
        return pd.DataFrame({
            "total":      [len(df)],
            "composers":  [df["composer"].nunique()],
            "Classical":  [(df["period"] == "Classical").sum()],
            "Romantic":   [(df["period"] == "Romantic").sum()],
            "Modern":     [(df["period"] == "Modern").sum()],
            "var_min":    [df["variation_num"].min()],
            "var_max":    [df["variation_num"].max()],
        })


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3.  HANDCRAFTED FEATURES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class Handcrafted:
    """
    Extract interpretable handcrafted features from segment WAV files.

    Features:
      Pitch     : mean_pitch, pitch_range, pitch_variance,
                  contour_changes, upward_ratio, leap_ratio          (6)
      Rhythm    : onset_density, tempo_stability,
                  note_density, rhythmic_variance                    (4)
      Dynamics  : rms_mean, rms_variance                             (2)
      Harmony   : chroma_entropy, tonal_centroid, harmonic_stability (3)
      Key        : key_tonic_pc, key_mode_major, key_confidence,
                  key_margin, key_score, key_second_tonic_pc,
                  key_second_mode_major, key_tonic_sin/cos,
                  key_fifths_sin/cos                                (11)
      Timbre    : spectral_centroid_mean, spectral_brightness,
                  mfcc_mean_0..12, mfcc_var_0..12                   (2+26)

    Examples
    --------
    >>> ds = TVDataset()
    >>> hc = Handcrafted()
    >>> df_feat = hc.extract_batch(ds.mbh_piano(), ds)
    >>> df_feat.shape
    (N, 39)
    """

    SR = 22050  # our WAVs are already 22050 Hz mono
    KEY_FEATURE_COLS = [
        "key_tonic_pc",
        "key_mode_major",
        "key_confidence",
        "key_margin",
        "key_score",
        "key_second_tonic_pc",
        "key_second_mode_major",
        "key_tonic_sin",
        "key_tonic_cos",
        "key_fifths_sin",
        "key_fifths_cos",
    ]
    _MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    _MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    def extract_one(self, wav_path: str | Path) -> dict:
        """
        Extract features from a single WAV file.
        Returns a dict of {feature_name: float}.
        All features are scalar floats; NaN when not computable.
        """
        import librosa

        y, _ = librosa.load(str(wav_path), sr=self.SR, mono=True)
        feat: dict = {}

        # ── Pitch ────────────────────────────────────────────────
        # ``pyin`` is more detailed but far too slow for thousands of segments.
        # ``yin`` keeps the pitch-summary features practical for batch runs.
        f0 = librosa.yin(
            y,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"),
            sr=self.SR,
            frame_length=2048,
            hop_length=1024,
        )
        f0v = f0[np.isfinite(f0)]
        if len(f0v) > 1:
            diff = np.diff(f0v)
            feat.update({
                "mean_pitch":      float(np.mean(f0v)),
                "pitch_range":     float(np.ptp(f0v)),
                "pitch_variance":  float(np.var(f0v)),
                "contour_changes": float(np.sum(np.diff(np.sign(diff)) != 0)),
                "upward_ratio":    float(np.sum(diff > 0) / len(diff)),
                "leap_ratio":      float(np.sum(np.abs(diff) > 100) / len(diff)),
            })
        else:
            for k in ["mean_pitch", "pitch_range", "pitch_variance",
                      "contour_changes", "upward_ratio", "leap_ratio"]:
                feat[k] = float("nan")

        # ── Rhythm ───────────────────────────────────────────────
        onset_frames = librosa.onset.onset_detect(y=y, sr=self.SR)
        onset_times  = librosa.frames_to_time(onset_frames, sr=self.SR)
        duration     = librosa.get_duration(y=y, sr=self.SR)
        feat["onset_density"] = float(len(onset_times) / duration) if duration > 0 else float("nan")
        feat["note_density"]  = feat["onset_density"]
        if len(onset_times) > 1:
            ioi = np.diff(onset_times)
            feat["tempo_stability"]   = float(1.0 / (np.std(ioi) + 1e-6))
            feat["rhythmic_variance"] = float(np.var(ioi))
        else:
            feat["tempo_stability"]   = float("nan")
            feat["rhythmic_variance"] = float("nan")

        # ── Dynamics ─────────────────────────────────────────────
        rms = librosa.feature.rms(y=y)[0]
        feat["rms_mean"]     = float(np.mean(rms))
        feat["rms_variance"] = float(np.var(rms))

        # ── Harmony ──────────────────────────────────────────────
        chroma      = librosa.feature.chroma_cqt(y=y, sr=self.SR)
        chroma_mean = chroma.mean(axis=1)
        chroma_norm = chroma_mean / (chroma_mean.sum() + 1e-6)
        feat["chroma_entropy"]     = float(-np.sum(chroma_norm * np.log(chroma_norm + 1e-6)))
        feat["tonal_centroid"]     = float(np.dot(np.arange(12), chroma_norm))
        feat["harmonic_stability"] = float(np.max(chroma_norm))
        feat.update(self._key_features(chroma_norm))

        # ── Timbre ───────────────────────────────────────────────
        spec_c = librosa.feature.spectral_centroid(y=y, sr=self.SR)[0]
        feat["spectral_centroid_mean"] = float(np.mean(spec_c))
        feat["spectral_brightness"]    = float(np.mean(spec_c) / (self.SR / 2))
        mfcc = librosa.feature.mfcc(y=y, sr=self.SR, n_mfcc=13)
        for i in range(13):
            feat[f"mfcc_mean_{i}"] = float(np.mean(mfcc[i]))
            feat[f"mfcc_var_{i}"]  = float(np.var(mfcc[i]))

        return feat

    def extract_key_features_one(self, wav_path: str | Path) -> dict[str, float]:
        """Compute only the key-related handcrafted feature columns for cache upgrades."""
        import librosa

        y, _ = librosa.load(str(wav_path), sr=self.SR, mono=True)
        chroma = librosa.feature.chroma_cqt(y=y, sr=self.SR)
        chroma_mean = chroma.mean(axis=1)
        chroma_norm = chroma_mean / (chroma_mean.sum() + 1e-6)
        return self._key_features(chroma_norm)

    @classmethod
    def _key_features(cls, chroma_norm: np.ndarray) -> dict[str, float]:
        """Return numeric key-estimation features from a 12-D chroma profile."""
        if chroma_norm.shape[0] != 12 or not np.isfinite(chroma_norm).any():
            return {col: float("nan") for col in cls.KEY_FEATURE_COLS}

        profile = np.asarray(chroma_norm, dtype=float)
        profile = profile / (profile.sum() + 1e-12)
        profile_z = cls._zscore(profile)
        major_z = cls._zscore(cls._MAJOR_PROFILE)
        minor_z = cls._zscore(cls._MINOR_PROFILE)

        scores = []
        for tonic in range(12):
            scores.append(float(np.dot(profile_z, np.roll(major_z, tonic)) / 12.0))
        for tonic in range(12):
            scores.append(float(np.dot(profile_z, np.roll(minor_z, tonic)) / 12.0))
        scores_arr = np.asarray(scores, dtype=float)
        order = np.argsort(scores_arr)[::-1]
        best = int(order[0])
        second = int(order[1])
        probs = cls._softmax(scores_arr)

        tonic = best % 12
        second_tonic = second % 12
        mode_major = 1.0 if best < 12 else 0.0
        second_mode_major = 1.0 if second < 12 else 0.0
        tonic_angle = 2.0 * np.pi * tonic / 12.0
        fifths_pos = (tonic * 7) % 12
        fifths_angle = 2.0 * np.pi * fifths_pos / 12.0

        return {
            "key_tonic_pc": float(tonic),
            "key_mode_major": mode_major,
            "key_confidence": float(probs[best]),
            "key_margin": float(scores_arr[best] - scores_arr[second]),
            "key_score": float(scores_arr[best]),
            "key_second_tonic_pc": float(second_tonic),
            "key_second_mode_major": second_mode_major,
            "key_tonic_sin": float(np.sin(tonic_angle)),
            "key_tonic_cos": float(np.cos(tonic_angle)),
            "key_fifths_sin": float(np.sin(fifths_angle)),
            "key_fifths_cos": float(np.cos(fifths_angle)),
        }

    @staticmethod
    def _zscore(values: np.ndarray) -> np.ndarray:
        values = np.asarray(values, dtype=float)
        std = values.std()
        if std == 0:
            return values - values.mean()
        return (values - values.mean()) / std

    @staticmethod
    def _softmax(scores: np.ndarray) -> np.ndarray:
        centered = scores - np.max(scores)
        exp = np.exp(centered)
        return exp / exp.sum()

    def extract_batch(
        self,
        df: pd.DataFrame,
        ds: TVDataset,
        which: LabelSet = "core",
        save: bool = True,
        out_name: str = "handcrafted_features.csv",
        progress_every: int = 50,
        resume: bool = True,
    ) -> pd.DataFrame:
        """
        Extract features for all segments in ``df``.

        Parameters
        ----------
        df             : subset DataFrame (e.g. ds.mbh_piano())
        ds             : TVDataset instance (for path resolution)
        which          : which labels to process ('core' | 'extra' | 'all')
        save           : if True, save to features/<out_name>
        out_name       : output CSV filename
        progress_every : print progress every N segments
        resume         : if True and output CSV exists, skip already extracted
                 (matched by file_name + label)

        Returns
        -------
        pd.DataFrame with one row per segment, feature columns + metadata.
        """
        out = ds.paths.features / out_name
        records, errors = [], []
        n_cached = 0
        n_key_upgraded = 0
        n_new = 0
        existing_map: dict[tuple[str, str], dict] = {}
        started_at = time.time()
        work = list(ds.iter_segments(df, which))
        total = len(work)
        print(f"Handcrafted.extract_batch: {total} {which} segments -> {out.name}")

        if resume and out.exists():
            try:
                df_existing = pd.read_csv(out)
                if {"file_name", "label"}.issubset(df_existing.columns):
                    stale = 0
                    for rec in df_existing.to_dict(orient="records"):
                        if not all(col in rec for col in self.KEY_FEATURE_COLS):
                            stale += 1
                        key = (str(rec.get("file_name", "")), str(rec.get("label", "")))
                        existing_map[key] = rec
                    print(f"Resume: loaded {len(existing_map)} cached rows from {out}")
                    if stale:
                        print(f"Resume: {stale} cached rows will be upgraded with key_* only")
                else:
                    print("Resume skipped: existing CSV has no file_name/label columns")
            except Exception as e:
                print(f"Resume skipped: failed to read existing CSV ({e})")

        for n, (row, lbl, wav) in enumerate(work):
            key = (str(row["file_name (folderName_number)"]), str(lbl))
            action = "new"
            if key in existing_map:
                rec = dict(existing_map[key])
                missing_key_cols = [col for col in self.KEY_FEATURE_COLS if col not in rec or pd.isna(rec[col])]
                if missing_key_cols:
                    rec.update(self.extract_key_features_one(wav))
                    n_key_upgraded += 1
                    action = "upgrade-key"
                else:
                    action = "cache"
                records.append(rec)
                n_cached += 1
            else:
                try:
                    feat = self.extract_one(wav)
                    feat.update({
                        "file_name":  row["file_name (folderName_number)"],
                        "composer":   row["composer"],
                        "piece":      row["music_name"],
                        "period":     row["period"],
                        "instrument": row["instrument"],
                        "label":      lbl,
                    })
                    records.append(feat)
                    n_new += 1
                except Exception as e:
                    action = "error"
                    errors.append({"file": row["file_name (folderName_number)"],
                                   "label": lbl, "error": str(e)})

            if (n + 1) == 1 or (n + 1) % progress_every == 0 or (n + 1) == total:
                elapsed = time.time() - started_at
                rate = (n + 1) / elapsed if elapsed > 0 else 0.0
                remaining = (total - (n + 1)) / rate if rate > 0 else float("nan")
                print(
                    f"  [{n+1}/{total}] {row['file_name (folderName_number)']} / {lbl} "
                    f"({action}) | cache={n_cached} key_upgrades={n_key_upgraded} "
                    f"new={n_new} errors={len(errors)} | elapsed={elapsed/60:.1f}m "
                    f"eta={remaining/60:.1f}m",
                    flush=True,
                )

        df_feat = pd.DataFrame(records)

        # Reorder: metadata first, then features
        meta_cols = ["file_name", "composer", "piece", "period", "instrument", "label"]
        feat_cols = [c for c in df_feat.columns if c not in meta_cols]
        df_feat   = df_feat[meta_cols + feat_cols]

        if save:
            df_feat.to_csv(out, index=False)
            print(f"\nSaved {len(df_feat)} rows → {out}")

        if resume:
            print(f"Cached reused: {n_cached}")
            print(f"Key-only upgrades: {n_key_upgraded}")
            print(f"Newly extracted: {len(df_feat) - n_cached}")

        if errors:
            print(f"Errors ({len(errors)}):")
            for e in errors:
                print(f"  {e['file']} / {e['label']}: {e['error']}")

        return df_feat


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4.  MERT EMBEDDING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class MERTEmbedder:
    """
    Extract 1024-D audio embeddings using MERT-v1-330M.

    - Resamples 22050 Hz WAVs to 24000 Hz (MERT's expected rate).
    - Defaults to the archive-compatible pooling strategy:
      mean over all hidden layers, then mean over time frames.
    - Saves one ``.npy`` file per segment, so runs can resume and old
      archive embeddings can be reused.
    - Saves checkpoint every ``checkpoint_every`` segments so runs
      can be resumed after interruption.

    Examples
    --------
    >>> ds  = TVDataset()
    >>> me  = MERTEmbedder()              # downloads model on first run
    >>> emb, meta = me.extract_batch(ds.mbh_piano(), ds)
    >>> emb.shape
    (N, 1024)
    """

    MODEL_ID = "m-a-p/MERT-v1-330M"
    MERT_SR  = 24000   # MERT's required sample rate
    LOCAL_MODEL_DIR = Paths().models / "MERT-v1-330M"

    def __init__(
        self,
        device: str | None = None,
        pooling: Literal["all_layers_mean", "last_hidden_mean"] = "all_layers_mean",
        torch_num_threads: int | None = None,
        model_dir: str | Path | None = None,
        prefer_local: bool = True,
    ):
        self._processor = None
        self._model     = None
        self.device     = device or self._auto_device()
        self.pooling    = pooling
        self.model_dir  = Path(model_dir).expanduser().resolve() if model_dir else self.LOCAL_MODEL_DIR
        self.prefer_local = prefer_local
        if pooling not in {"all_layers_mean", "last_hidden_mean"}:
            raise ValueError("pooling must be 'all_layers_mean' or 'last_hidden_mean'")
        self.torch_num_threads = self._configure_torch_threads(torch_num_threads)
        thread_text = (
            f", torch threads = {self.torch_num_threads}"
            if self.torch_num_threads is not None else ""
        )
        print(f"MERTEmbedder: device = {self.device}, pooling = {self.pooling}{thread_text}")

    # ── Lazy model loading ───────────────────────────────────────

    def _auto_device(self) -> str:
        import torch
        if torch.cuda.is_available():  return "cuda"
        try:
            import torch
            if torch.backends.mps.is_available(): return "mps"
        except Exception:
            pass
        return "cpu"

    def _configure_torch_threads(self, torch_num_threads: int | None) -> int | None:
        if self.device != "cpu":
            return None
        import torch

        env_value = os.environ.get("MERT_TORCH_THREADS") or os.environ.get("TORCH_NUM_THREADS")
        if torch_num_threads is None and env_value:
            try:
                torch_num_threads = int(env_value)
            except ValueError:
                torch_num_threads = None
        if torch_num_threads is None:
            torch_num_threads = min(4, os.cpu_count() or 4)
        torch.set_num_threads(max(1, torch_num_threads))
        return torch.get_num_threads()

    def _load_model(self):
        if self._model is not None:
            return
        from transformers import AutoProcessor, AutoModel

        model_source = self.model_dir if self.prefer_local and self._has_local_model() else self.MODEL_ID
        local_only = model_source == self.model_dir
        if local_only:
            print(f"Loading local MERT model from {model_source} …")
        else:
            print(f"Loading {self.MODEL_ID} …")
        self._processor = AutoProcessor.from_pretrained(
            model_source, trust_remote_code=True, local_files_only=local_only)
        self._model = AutoModel.from_pretrained(
            model_source, trust_remote_code=True, local_files_only=local_only).to(self.device)
        self._model.eval()
        print("Model ready.")

    def _has_local_model(self) -> bool:
        required = [
            "config.json",
            "configuration_MERT.py",
            "modeling_MERT.py",
            "preprocessor_config.json",
            "pytorch_model.bin",
        ]
        return self.model_dir.is_dir() and all((self.model_dir / name).exists() for name in required)

    # ── Single segment ───────────────────────────────────────────

    def extract_one(self, wav_path: str | Path) -> np.ndarray:
        """
        Extract 1024-D embedding from a single WAV file.
        Loads model on first call (lazy).
        """
        import torch
        import torchaudio
        import torchaudio.transforms as T

        self._load_model()

        waveform, sample_rate = torchaudio.load(str(wav_path))
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        waveform = waveform.squeeze(0)
        if sample_rate != self.MERT_SR:
            waveform = T.Resample(sample_rate, self.MERT_SR)(waveform)

        inputs = self._processor(waveform.numpy(), sampling_rate=self.MERT_SR, return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = self._model(**inputs, output_hidden_states=True)

        if self.pooling == "all_layers_mean":
            # Archive-compatible but memory-conscious:
            # mean each layer over time first, then mean the small layer vectors.
            layer_means = [hidden.squeeze(0).mean(dim=0) for hidden in outputs.hidden_states]
            embedding = torch.stack(layer_means).mean(dim=0).detach().cpu().float().numpy()
        else:
            # Last hidden state: (1, T, 1024) -> mean over T -> (1024,).
            last_hidden = outputs.hidden_states[-1]
            embedding = last_hidden.mean(dim=1).squeeze(0).detach().cpu().float().numpy()
        del inputs, outputs, waveform
        if self.device == "cuda":
            torch.cuda.empty_cache()
        elif self.device == "mps" and hasattr(torch, "mps"):
            torch.mps.empty_cache()
        gc.collect()
        return embedding

    @staticmethod
    def segment_embedding_path(ds: TVDataset, row: pd.Series, label: str) -> Path:
        """Per-segment cache path compatible with the old archive layout."""
        return (
            ds.paths.embeddings
            / "mert_embeddings"
            / row["folder"]
            / row["file_name (folderName_number)"]
            / f"{label}.npy"
        )

    # ── Batch extraction ─────────────────────────────────────────

    def extract_batch(
        self,
        df: pd.DataFrame,
        ds: TVDataset,
        which: LabelSet = "core",
        save: bool = True,
        emb_name: str = "embeddings.npy",
        meta_name: str = "embedding_meta.csv",
        index_name: str = "mert_embedding_index.csv",
        checkpoint_every: int = 50,
        progress_every: int = 10,
        print_each_start: bool = True,
        max_new_segments: int | None = None,
    ) -> tuple[np.ndarray, pd.DataFrame]:
        """
        Extract embeddings for all segments in ``df``.

        Parameters
        ----------
        df                : subset DataFrame
        ds                : TVDataset instance
        which             : label set ('core' | 'extra' | 'all')
        save              : save outputs to embeddings/
        emb_name          : output .npy filename
        meta_name         : output metadata CSV filename
        checkpoint_every  : save checkpoint every N segments
        progress_every    : print progress every N segments
        print_each_start   : print each segment before extraction starts

        Returns
        -------
        emb_matrix : np.ndarray  shape (N, 1024), float32
        df_meta    : pd.DataFrame  N rows with file_name, composer, period, label
        """
        ckpt_path = ds.paths.embeddings / "_checkpoint.npz"
        index_path = ds.paths.embeddings / index_name

        work = list(ds.iter_segments(df, which))
        cached = []
        todo = []
        for row, lbl, wav in work:
            emb_path = self.segment_embedding_path(ds, row, lbl)
            if emb_path.exists():
                cached.append((row, lbl, wav, emb_path))
            else:
                todo.append((row, lbl, wav, emb_path))

        durations: dict[Path, float] = {}
        try:
            import soundfile as sf
            for _, _, wav, _ in todo:
                durations[wav] = sf.info(str(wav)).duration
            todo.sort(key=lambda item: durations[item[2]])
        except Exception:
            pass
        if max_new_segments is not None:
            todo = todo[:max_new_segments]

        print(f"Segments total: {len(work)}", flush=True)
        print(f"Segments cached: {len(cached)}", flush=True)
        print(f"Segments to embed: {len(todo)}", flush=True)

        if todo:
            self._load_model()

        errors = []
        index_records = []
        for n, (row, lbl, wav, emb_path) in enumerate(todo):
            fname = row["file_name (folderName_number)"]
            duration = durations.get(wav)
            duration_text = f", {duration:.1f}s" if duration is not None else ""
            try:
                if print_each_start:
                    print(
                        f"  START [{n+1}/{len(todo)}] {fname} / {lbl}{duration_text}",
                        flush=True,
                    )
                t0 = time.perf_counter()
                emb = self.extract_one(wav)
                elapsed = time.perf_counter() - t0
                emb_path.parent.mkdir(parents=True, exist_ok=True)
                np.save(emb_path, emb.astype("float32"))
                index_records.append({
                    "file_name": fname,
                    "composer":  row["composer"],
                    "period":    row["period"],
                    "label":     lbl,
                    "embedding_path": str(emb_path.relative_to(ds.paths.root)),
                    "pooling": self.pooling,
                    "status": "extracted",
                    "error": "",
                })

                if (
                    print_each_start
                    or (n + 1) % progress_every == 0
                    or (n + 1) == len(todo)
                ):
                    print(
                        f"  DONE  [{n+1}/{len(todo)}] {fname} / {lbl}"
                        f" in {elapsed:.1f}s",
                        flush=True,
                    )

                if (n + 1) % checkpoint_every == 0:
                    self._save_matrix_from_cache(work, ds, emb_name, meta_name, index_name)
                    np.savez(ckpt_path, processed=n + 1, total=len(todo))
                    print(
                        f"  → checkpoint saved ({n+1}/{len(todo)} new, "
                        f"{len(cached)+n+1} total cached)",
                        flush=True,
                    )

            except Exception as e:
                errors.append({"file": fname, "label": lbl, "error": str(e)})
                index_records.append({
                    "file_name": fname,
                    "composer":  row["composer"],
                    "period":    row["period"],
                    "label":     lbl,
                    "embedding_path": str(emb_path.relative_to(ds.paths.root)),
                    "pooling": self.pooling,
                    "status": "error",
                    "error": str(e),
                })
                print(f"  ERROR: {fname} / {lbl} — {e}", flush=True)

        if save:
            emb_matrix, df_meta = self._save_matrix_from_cache(
                work, ds, emb_name, meta_name, index_name, extra_index_records=index_records
            )
            print(f"\nSaved embeddings → {ds.paths.embeddings / emb_name}  {emb_matrix.shape}")
            print(f"Saved metadata   → {ds.paths.embeddings / meta_name}  {len(df_meta)} rows")
            print(f"Saved index      → {index_path}")
            if ckpt_path.exists():
                ckpt_path.unlink()  # clean up checkpoint
        else:
            emb_matrix, df_meta = self._matrix_from_cache(work, ds)

        if errors:
            print(f"Errors ({len(errors)}):")
            for e in errors:
                print(f"  {e['file']} / {e['label']}: {e['error']}")

        return emb_matrix, df_meta

    def _matrix_from_cache(
        self,
        work: list[tuple[pd.Series, str, Path]],
        ds: TVDataset,
    ) -> tuple[np.ndarray, pd.DataFrame]:
        emb_list = []
        meta_list = []

        for row, lbl, _ in work:
            emb_path = self.segment_embedding_path(ds, row, lbl)
            if not emb_path.exists():
                continue
            emb_list.append(np.load(emb_path).astype("float32"))
            meta_list.append({
                "file_name": row["file_name (folderName_number)"],
                "composer": row["composer"],
                "period": row["period"],
                "label": lbl,
                "embedding_path": str(emb_path.relative_to(ds.paths.root)),
                "pooling": self.pooling,
            })

        emb_matrix = (
            np.stack(emb_list).astype("float32")
            if emb_list else np.empty((0, 1024), dtype="float32")
        )
        return emb_matrix, pd.DataFrame(meta_list)

    def _save_matrix_from_cache(
        self,
        work: list[tuple[pd.Series, str, Path]],
        ds: TVDataset,
        emb_name: str,
        meta_name: str,
        index_name: str,
        extra_index_records: list[dict] | None = None,
    ) -> tuple[np.ndarray, pd.DataFrame]:
        emb_matrix, df_meta = self._matrix_from_cache(work, ds)
        np.save(ds.paths.embeddings / emb_name, emb_matrix)
        df_meta.to_csv(ds.paths.embeddings / meta_name, index=False)

        index_records = []
        for _, row in df_meta.iterrows():
            index_records.append({
                **row.to_dict(),
                "status": "cached_or_extracted",
                "error": "",
            })
        if extra_index_records:
            index_records.extend([r for r in extra_index_records if r["status"] == "error"])
        pd.DataFrame(index_records).to_csv(ds.paths.embeddings / index_name, index=False)
        return emb_matrix, df_meta

    # ── Load saved outputs ───────────────────────────────────────

    @staticmethod
    def load(
        ds: TVDataset,
        emb_name: str = "embeddings.npy",
        meta_name: str = "embedding_meta.csv",
    ) -> tuple[np.ndarray, pd.DataFrame]:
        """Load previously saved embeddings from disk."""
        emb_path  = ds.paths.embeddings / emb_name
        meta_path = ds.paths.embeddings / meta_name
        emb_matrix = np.load(emb_path)
        df_meta    = pd.read_csv(meta_path)
        print(f"Loaded embeddings: {emb_matrix.shape}  meta: {len(df_meta)} rows")
        return emb_matrix, df_meta


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5.  SIMILARITY  — cosine similarity matrix helpers
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class Similarity:
    """
    Cosine similarity utilities on top of an embedding matrix.

    Examples
    --------
    >>> sim = Similarity(emb_matrix, df_meta)
    >>> sim.matrix.shape          # (N, N)
    >>> sim.within_piece("WAMozart_K265")   # Theme ↔ Variations for one piece
    """

    def __init__(self, emb_matrix: np.ndarray, df_meta: pd.DataFrame):
        from sklearn.metrics.pairwise import cosine_similarity
        self.emb    = emb_matrix
        self.meta   = df_meta.reset_index(drop=True)
        self.matrix = cosine_similarity(emb_matrix).astype("float32")

    def save(self, ds: TVDataset, name: str = "cosine_similarity.npy"):
        out = ds.paths.embeddings / name
        np.save(out, self.matrix)
        print(f"Saved similarity matrix → {out}  {self.matrix.shape}")

    @staticmethod
    def load(ds: TVDataset, name: str = "cosine_similarity.npy") -> np.ndarray:
        path = ds.paths.embeddings / name
        mat  = np.load(path)
        print(f"Loaded similarity matrix: {mat.shape}")
        return mat

    def within_piece(self, file_prefix: str) -> tuple[np.ndarray, list[str]]:
        """
        Return the sub-similarity-matrix and labels for one piece.
        ``file_prefix`` is matched against the start of file_name
        (e.g. 'WAMozart_K265' matches all recordings of that piece).
        """
        mask   = self.meta["file_name"].str.startswith(file_prefix)
        idx    = self.meta[mask].index.tolist()
        labels = self.meta.loc[idx, "label"].tolist()
        sub    = self.matrix[np.ix_(idx, idx)]
        return sub, labels

    def within_recording(self, file_name: str) -> tuple[np.ndarray, list[str]]:
        """Return the sub-similarity-matrix and labels for one recording."""
        mask   = self.meta["file_name"] == file_name
        idx    = self.meta[mask].index.tolist()
        labels = self.meta.loc[idx, "label"].tolist()
        sub    = self.matrix[np.ix_(idx, idx)]
        return sub, labels

    def top_similar(
        self,
        file_name: str,
        label: str,
        n: int = 10,
    ) -> pd.DataFrame:
        """Return the N most similar segments to a given (file_name, label)."""
        mask = (self.meta["file_name"] == file_name) & (self.meta["label"] == label)
        if not mask.any():
            raise KeyError(f"({file_name}, {label}) not found in metadata.")
        idx     = self.meta[mask].index[0]
        scores  = self.matrix[idx]
        top_idx = np.argsort(scores)[::-1][1:n+1]
        result  = self.meta.iloc[top_idx].copy()
        result["similarity"] = scores[top_idx]
        return result.reset_index(drop=True)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6.  FRONTEND EXPORTER — build explorer_app data from pipeline outputs
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class FrontendExporter:
    """Build the two data files that explorer_app needs.

    Accepts in-memory DataFrames produced by the pipeline notebook so nothing
    needs to be re-read from disk.  Can also be driven from the standalone
    ``backend/export/export_explorer_data.py`` script.

    Outputs (written to ``explorer_app/src/data/``):
      segment_visualization{suffix}.csv   — one row per segment, all metadata
      waveform_thumbnails{suffix}.json    — waveform + feature data per segment

    Typical notebook usage::

        from tv_core import FrontendExporter
        exporter = FrontendExporter(ds, top_n_features=8)
        exporter.run(
            df_ann          = ds.df,
            df_reduction    = df_reduction,
            df_clusters     = df_clusters,
            thumbnail_df    = thumbnail_df,
            selection       = selection,
            output_suffix   = OUTPUT_SUFFIX,
            waveform_points = 160,
        )
    """

    GROUP_COLORS: dict[str, str] = {
        "pitch":       "#4C78A8",
        "rhythm":      "#F58518",
        "dynamics":    "#E45756",
        "harmony":     "#72B7B2",
        "timbre":      "#54A24B",
        "timbre_mfcc": "#B279A2",
        "other":       "#8A8A8A",
    }

    def __init__(self, ds: "TVDataset", top_n_features: int = 8, verbose: bool = True):
        self.ds               = ds
        self.top_n_features   = top_n_features
        self.verbose          = verbose

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _mmss_to_sec(val: float) -> float:
        """MM.SS float → seconds.  e.g. 1.54 → 114.0"""
        val  = float(val)
        mins = int(val)
        secs = round((val - mins) * 100, 6)
        return mins * 60 + secs

    @staticmethod
    def _sec_to_mmss(sec: float) -> str:
        """Seconds → MM.SS string.  e.g. 114.0 → '1.54'"""
        sec  = max(0.0, float(sec))
        mins = int(sec) // 60
        secs = round(sec - mins * 60)
        return f"{mins}.{secs:02d}"

    @staticmethod
    def _parse_boundaries(boundary_str: str) -> list[float]:
        return [FrontendExporter._mmss_to_sec(float(b.strip()))
                for b in str(boundary_str).split(";")]

    @staticmethod
    def _downsample_waveform(y: np.ndarray, max_points: int) -> list[float]:
        import numpy as np
        if y.ndim > 1:
            y = y.mean(axis=1)
        if len(y) == 0:
            return []
        if len(y) > max_points:
            idx = np.linspace(0, len(y) - 1, max_points).astype(int)
            y   = y[idx]
        y = y.astype("float32")
        denom = float(np.max(np.abs(y)))
        if denom > 0:
            y = y / denom
        return [round(float(v), 4) for v in y]

    @staticmethod
    def _with_segment_occurrence(df: pd.DataFrame, label_col: str = "label") -> pd.DataFrame:
        """Add a stable occurrence index for duplicate file/label segment keys."""
        out = df.copy()
        if {"file_name", label_col}.issubset(out.columns):
            out["_segment_occurrence"] = out.groupby(
                ["file_name", label_col], sort=False
            ).cumcount()
        else:
            out["_segment_occurrence"] = 0
        return out

    @staticmethod
    def _segment_id(file_name: str, label: str, occurrence: int) -> str:
        """Stable unique id."""
        return f"{file_name}__{label}"

    # ── public API ───────────────────────────────────────────────────────────

    def build_segment_csv(
        self,
        df_ann:        pd.DataFrame,
        df_reduction:  pd.DataFrame,
        df_clusters:   pd.DataFrame,
        thumbnail_df:  pd.DataFrame,
        selected_features: list[str],
        feature_to_rank:   dict[str, int],
        feature_to_group:  dict[str, str],
    ) -> pd.DataFrame:
        """Merge annotation + pipeline outputs into one flat DataFrame."""
        ann = df_ann.rename(columns={"file_name (folderName_number)": "file_name"}).copy()
        df_reduction = self._with_segment_occurrence(df_reduction)
        df_clusters = self._with_segment_occurrence(df_clusters)
        thumbnail_df = self._with_segment_occurrence(thumbnail_df)
        rows = []

        for _, rec in ann.iterrows():
            file_name  = rec["file_name"]
            folder     = rec["folder"]
            boundaries = self._parse_boundaries(rec["boundary"])
            all_labels = [l.strip() for l in str(rec["label"]).split(";")]
            specs = self.ds.segment_specs(rec, "core")

            for spec in specs:
                idx = int(spec["position"])
                base_lbl = spec["label"]
                lbl = spec["segment_label"]
                occurrence = int(spec["occurrence"])

                start_sec = int(round(boundaries[idx]))
                end_sec   = int(round(boundaries[idx + 1])) if idx + 1 < len(boundaries) \
                            else int(round(boundaries[-1]))
                duration  = end_sec - start_sec

                red_row = df_reduction[
                    (df_reduction["file_name"] == file_name)
                    & (df_reduction["label"] == lbl)
                ]
                tsne_x = round(float(red_row["tsne_x"].iloc[0]), 6) if len(red_row) else None
                tsne_y = round(float(red_row["tsne_y"].iloc[0]), 6) if len(red_row) else None

                clu_row = df_clusters[
                    (df_clusters["file_name"] == file_name)
                    & (df_clusters["label"] == lbl)
                ]
                cluster_data = self._cluster_export_fields(clu_row)

                th_row = thumbnail_df[
                    (thumbnail_df["file_name"] == file_name)
                    & (thumbnail_df["label"] == lbl)
                ]
                feature_data: dict = {}
                for feat in selected_features:
                    if len(th_row):
                        value = round(float(th_row[feat].iloc[0]), 6) \
                                if feat in th_row.columns else None
                        norm  = round(float(th_row[f"norm_{feat}"].iloc[0]), 4) \
                                if f"norm_{feat}" in th_row.columns else None
                    else:
                        value = norm = None
                    feature_data[f"feature_rank_{feat}"] = feature_to_rank.get(feat, 0)
                    feature_data[f"value_{feat}"]        = value
                    feature_data[f"norm_{feat}"]         = norm

                rows.append({
                    "id":                       self._segment_id(file_name, lbl, occurrence),
                    "folder":                   folder,
                    "file_name":                file_name,
                    "segment_label":            lbl,
                    "segment_base_label":       base_lbl,
                    "segment_occurrence":       occurrence,
                    "music_name":               rec.get("music_name", ""),
                    "composer":                 rec.get("composer", ""),
                    "period":                   rec.get("period", ""),
                    "instrument":               rec.get("instrument", ""),
                    "length":                   rec.get("length", None),
                    "variation_num":            rec.get("variation_num", None),
                    "link":                     rec.get("link", ""),
                    "note":                     rec.get("note", ""),
                    "record_boundary":          "; ".join(
                                                    self._sec_to_mmss(b) for b in boundaries),
                    "record_label":             "; ".join(all_labels),
                    "segment_start_sec":        start_sec,
                    "segment_end_sec":          end_sec,
                    "segment_duration_sec":     duration,
                    "tsne_x":                   tsne_x,
                    "tsne_y":                   tsne_y,
                    **cluster_data,
                    "default_selected_feature": selected_features[0] if selected_features else "",
                    **feature_data,
                })

        return pd.DataFrame(rows)

    @staticmethod
    def _cluster_export_fields(clu_row: pd.DataFrame) -> dict:
        """Return all frontend-facing cluster fields for one segment."""

        def get(name: str, default=None):
            if not len(clu_row) or name not in clu_row.columns:
                return default
            value = clu_row[name].iloc[0]
            return default if pd.isna(value) else value

        def is_blank(value) -> bool:
            return value is None or (isinstance(value, str) and value.strip() == "")

        def as_int(name: str):
            value = get(name)
            return None if is_blank(value) else int(float(value))

        def as_float(name: str):
            value = get(name)
            return None if is_blank(value) else round(float(value), 6)

        def as_bool(name: str):
            value = get(name, False)
            if is_blank(value):
                return False
            if isinstance(value, str):
                return value.strip().lower() in {"true", "1", "yes"}
            return bool(value)

        def as_str(name: str):
            value = get(name, "")
            return "" if value is None else str(value)

        return {
            "cluster_km": as_int("cluster_km"),
            "cluster_kmedoids": as_int("cluster_kmedoids"),
            "cluster_ward": as_int("cluster_ward"),
            "cluster_hdbscan": as_int("cluster_hdbscan"),
            "cluster_hdbscan_sub": as_int("cluster_hdbscan_sub"),
            "cluster_hdbscan_nested": as_str("cluster_hdbscan_nested"),
            "hdbscan_is_outlier": as_bool("hdbscan_is_outlier"),
            "hdbscan_strength": as_float("hdbscan_strength"),
            "hdbscan_sub_is_outlier": as_bool("hdbscan_sub_is_outlier"),
            "hdbscan_sub_strength": as_float("hdbscan_sub_strength"),
            "hdbscan_major_cluster": as_int("hdbscan_major_cluster"),
            "cluster_km_size": as_int("cluster_km_size"),
            "cluster_km_representative_id": as_str("cluster_km_representative_id"),
            "cluster_km_distance_to_representative": as_float("cluster_km_distance_to_representative"),
            "cluster_kmedoids_size": as_int("cluster_kmedoids_size"),
            "cluster_kmedoids_representative_id": as_str("cluster_kmedoids_representative_id"),
            "cluster_kmedoids_distance_to_representative": as_float(
                "cluster_kmedoids_distance_to_representative"
            ),
            "cluster_ward_size": as_int("cluster_ward_size"),
            "cluster_ward_representative_id": as_str("cluster_ward_representative_id"),
            "cluster_ward_distance_to_representative": as_float(
                "cluster_ward_distance_to_representative"
            ),
            "cluster_hdbscan_size": as_int("cluster_hdbscan_size"),
            "cluster_hdbscan_representative_id": as_str("cluster_hdbscan_representative_id"),
            "cluster_hdbscan_distance_to_representative": as_float(
                "cluster_hdbscan_distance_to_representative"
            ),
            "cluster_hdbscan_sub_size": as_int("cluster_hdbscan_sub_size"),
            "cluster_hdbscan_sub_representative_id": as_str(
                "cluster_hdbscan_sub_representative_id"
            ),
            "cluster_hdbscan_sub_distance_to_representative": as_float(
                "cluster_hdbscan_sub_distance_to_representative"
            ),
            "is_outlier": as_bool("is_outlier"),
            "cluster_representative": as_str("cluster_representative"),
            "cluster_representative_distance": as_float("cluster_representative_distance"),
        }

    def build_waveform_json(
        self,
        df_vis:            pd.DataFrame,
        thumbnail_df:      pd.DataFrame,
        selected_features: list[str],
        feature_to_group:  dict[str, str],
        waveform_points:   int = 160,
    ) -> tuple[dict, list[dict]]:
        """Build the waveform_thumbnails JSON payload."""
        import soundfile as sf
        audio_root   = self.ds.paths.audio
        thumb_lookup = thumbnail_df.set_index(["file_name", "label"])
        items, errors = [], []

        for _, row in df_vis.iterrows():
            file_name = row["file_name"]
            label     = row["segment_label"]
            folder    = row["folder"]
            wav_path  = audio_root / folder / file_name / f"{label}.wav"

            waveform: list[float] = []
            if wav_path.exists():
                try:
                    y, _ = sf.read(str(wav_path), dtype="float32", always_2d=False)
                    waveform = self._downsample_waveform(y, waveform_points)
                except Exception as exc:
                    errors.append({"id": row["id"], "error": str(exc)})
            else:
                errors.append({"id": row["id"], "error": f"missing wav: {wav_path}"})

            try:
                th = thumb_lookup.loc[(file_name, label)]
                if isinstance(th, pd.DataFrame):
                    th = th.iloc[0]
                features = {
                    feat: round(float(th[f"norm_{feat}"]), 4)
                    for feat in selected_features
                    if f"norm_{feat}" in thumbnail_df.columns
                }
            except KeyError:
                features = {feat: 0.0 for feat in selected_features}

            items.append({
                "id":                    row["id"],
                "fileName":              file_name,
                "segmentLabel":          label,
                "clusterKm":             None if pd.isna(row["cluster_km"]) else int(row["cluster_km"]),
                "clusterKmedoids":       None if pd.isna(row["cluster_kmedoids"]) else int(row["cluster_kmedoids"]),
                "clusterWard":           None if pd.isna(row["cluster_ward"]) else int(row["cluster_ward"]),
                "clusterHdbscan":        None if pd.isna(row["cluster_hdbscan"]) else int(row["cluster_hdbscan"]),
                "clusterHdbscanSub":     None if pd.isna(row["cluster_hdbscan_sub"]) else int(row["cluster_hdbscan_sub"]),
                "clusterHdbscanNested":  row["cluster_hdbscan_nested"],
                "isOutlier":             bool(row["is_outlier"]),
                "clusterRepresentative": row["cluster_representative"],
                "waveform":              waveform,
                "features":              features,
            })

        payload = {
            "version":          1,
            "waveformPoints":   waveform_points,
            "selectedFeatures": selected_features,
            "featureGroups":    {f: feature_to_group.get(f, "other")
                                 for f in selected_features},
            "groupColors":      self.GROUP_COLORS,
            "items":            items,
        }
        return payload, errors

    def run(
        self,
        df_ann:          pd.DataFrame,
        df_reduction:    pd.DataFrame,
        df_clusters:     pd.DataFrame,
        thumbnail_df:    pd.DataFrame,
        selection:       pd.DataFrame,
        output_suffix:   str  = "",
        waveform_points: int  = 160,
        save:            bool = True,
    ) -> dict[str, object]:
        """Build and optionally save both frontend data files.

        Returns a dict with keys ``df_vis``, ``payload``, ``errors``.
        """
        import json

        sel_sorted = selection.sort_values("overall_rank")
        selected_features: list[str] = [
            f for f in sel_sorted["feature"].tolist()
            if f"norm_{f}" in thumbnail_df.columns
        ][: self.top_n_features]
        feature_to_rank  = {r["feature"]: int(r["overall_rank"])
                            for _, r in sel_sorted.iterrows()}
        feature_to_group = dict(zip(sel_sorted["feature"], sel_sorted["group"]))

        if self.verbose:
            print(f"Selected features ({len(selected_features)}): {selected_features}")

        # ── segment CSV ──────────────────────────────────────────────────────
        if self.verbose:
            print("\nBuilding segment_visualization CSV...")
        df_vis = self.build_segment_csv(
            df_ann, df_reduction, df_clusters, thumbnail_df,
            selected_features, feature_to_rank, feature_to_group,
        )

        # ── waveform JSON ─────────────────────────────────────────────────────
        if self.verbose:
            print("Building waveform_thumbnails JSON...")
        payload, errors = self.build_waveform_json(
            df_vis, thumbnail_df, selected_features, feature_to_group, waveform_points,
        )

        # ── save ──────────────────────────────────────────────────────────────
        if save:
            out_dir = self.ds.paths.root / "explorer_app" / "src" / "data"
            out_dir.mkdir(parents=True, exist_ok=True)

            vis_path   = out_dir / f"segment_visualization{output_suffix}.csv"
            thumb_path = out_dir / f"waveform_thumbnails{output_suffix}.json"

            df_vis.to_csv(vis_path, index=False)
            thumb_path.write_text(
                json.dumps(payload, separators=(",", ":")), encoding="utf-8"
            )

            if self.verbose:
                print(f"  -> {vis_path}  ({len(df_vis)} rows)")
                print(f"  -> {thumb_path}  ({len(payload['items'])} items)")
                if errors:
                    print(f"  Warnings: {len(errors)} waveform read errors")
                    for e in errors[:5]:
                        print(f"    {e['id']}: {e['error']}")

        return {"df_vis": df_vis, "payload": payload, "errors": errors}
