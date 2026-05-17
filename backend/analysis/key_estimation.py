"""
Segment-level key estimation from audio chroma.

This module does not infer chord progressions; it estimates one global key per
segment directly from audio chroma. Optional manual comparison helpers are kept
for diagnostics, but the default batch output is fully computed from audio.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

import librosa
import numpy as np
import pandas as pd

from tv_core import LabelSet, TVDataset


TONICS_DISPLAY = ["C", "D-flat", "D", "E-flat", "E", "F", "F#", "G", "A-flat", "A", "B-flat", "B"]
TONIC_ALIASES = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "D-flat": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "E-flat": 3,
    "Eb": 3,
    "E": 4,
    "F-flat": 4,
    "Fb": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "G-flat": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "A-flat": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "B-flat": 10,
    "Bb": 10,
    "B": 11,
    "C-flat": 11,
    "Cb": 11,
}

# Krumhansl-Schmuckler key profiles, C major / C minor orientation.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_RE = re.compile(r"^\s*([A-G](?:#|b|-flat)?)\s+(major|minor)\s*$", re.IGNORECASE)


@dataclass
class SegmentKeyEstimator:
    """
    Estimate one global key per segment WAV using chroma/key-profile matching.

    Parameters
    ----------
    sr : int
        Working sample rate for librosa.
    chroma_method : {"cqt", "stft"}
        Chroma extraction method. CQT is musically cleaner; STFT is faster.
    trim_edge_fraction : float
        Fraction of frames to down-weight at the start and end of each segment.
    verbose : bool
        Print batch progress.
    """

    sr: int = 22050
    chroma_method: str = "cqt"
    trim_edge_fraction: float = 0.10
    verbose: bool = True

    def extract_one(self, wav_path: str | Path) -> dict:
        """Return inferred key information for one segment WAV."""
        wav_path = Path(wav_path)
        y, sr = librosa.load(wav_path, sr=self.sr, mono=True)
        if y.size == 0:
            raise ValueError("empty audio")

        chroma = self._chroma(y, sr)
        profile = self._weighted_pitch_class_profile(chroma)
        scores = self._key_scores(profile)
        order = np.argsort(scores)[::-1]
        best = int(order[0])
        second = int(order[1])

        best_key = self._key_name(best)
        second_key = self._key_name(second)
        best_score = float(scores[best])
        second_score = float(scores[second])
        probs = self._softmax(scores)

        return {
            "tonic_inferred": best_key.split()[0],
            "mode_inferred": best_key.split()[1],
            "key_inferred": best_key,
            "key_confidence": float(probs[best]),
            "key_margin": best_score - second_score,
            "key_score": best_score,
            "key_second_best": second_key,
            "key_second_score": second_score,
            "segment_duration_sec": float(librosa.get_duration(y=y, sr=sr)),
            "chroma_energy": float(np.sum(profile)),
        }

    def extract_batch(
        self,
        df: pd.DataFrame,
        ds: TVDataset,
        which: LabelSet = "core",
        save: bool = True,
        out_name: str = "segment_keys.csv",
        max_segments: int | None = None,
        progress_every: int = 50,
        compare_manual: bool = False,
    ) -> pd.DataFrame:
        """Estimate keys for a dataset subset and optionally save a CSV."""
        work = list(ds.iter_segments(df, which=which))
        if max_segments is not None:
            work = work[:max_segments]

        total = len(work)
        rows: list[dict] = []
        errors: list[dict] = []
        manual_maps = self.build_manual_key_maps(df) if compare_manual else {}

        for n, (row, label, wav_path) in enumerate(work, 1):
            fname = row["file_name (folderName_number)"]
            if self.verbose and (n == 1 or n % progress_every == 0 or n == total):
                print(f"[{n}/{total}] {fname} / {label}", flush=True)

            meta = {
                "file_name": fname,
                "folder": row["folder"],
                "composer": row["composer"],
                "piece": row["music_name"],
                "period": row["period"],
                "instrument": row["instrument"],
                "label": label,
                "segment_path": str(wav_path),
            }
            manual = manual_maps.get((fname, label), {})
            try:
                result = self.extract_one(wav_path)
                if compare_manual:
                    result.update(self._manual_comparison(result["key_inferred"], manual))
                rows.append({**meta, **result})
            except Exception as exc:
                errors.append({"file_name": fname, "label": label, "error": str(exc)})
                rows.append({**meta, **manual, "error": str(exc)} if compare_manual else {**meta, "error": str(exc)})

        out = pd.DataFrame(rows)
        if save:
            out_path = ds.paths.features / out_name
            out.to_csv(out_path, index=False)
            if self.verbose:
                print(f"Saved {len(out)} rows -> {out_path}")

        if errors and self.verbose:
            print(f"\nFinished with {len(errors)} errors:")
            for err in errors[:10]:
                print(f"  {err['file_name']} / {err['label']}: {err['error']}")
            if len(errors) > 10:
                print(f"  ... {len(errors) - 10} more")

        return out

    @classmethod
    def build_manual_key_maps(cls, df: pd.DataFrame) -> dict[tuple[str, str], dict]:
        """
        Build per-segment manual key lookup from a legacy CSV that has a
        ``chord`` column. The clean project CSV intentionally omits this field.

        Alignment statuses:
        - exact_all_labels: ``label`` and legacy ``chord`` counts match exactly.
        - core_only_chords: legacy chord count equals core label count.
        - skip_intro: first label is I and chords align to all labels after I.
        - ambiguous: chord exists but no safe automatic alignment is available.
        - missing: no chord string in the row.
        """
        maps: dict[tuple[str, str], dict] = {}
        for _, row in df.iterrows():
            fname = row["file_name (folderName_number)"]
            labels = TVDataset._raw_labels(row)
            chords = cls._split_chords(row.get("chord", ""))
            specs_all = TVDataset.segment_specs(row, "all")
            specs_core = TVDataset.segment_specs(row, "core")

            if not chords:
                for spec in specs_all:
                    maps[(fname, spec["segment_label"])] = {
                        "key_manual": "",
                        "manual_alignment_status": "missing",
                    }
                continue

            aligned: dict[int, str] = {}
            status = "ambiguous"
            if len(labels) == len(chords):
                aligned = {i: chord for i, chord in enumerate(chords)}
                status = "exact_all_labels"
            elif len(specs_core) == len(chords):
                aligned = {spec["position"]: chord for spec, chord in zip(specs_core, chords)}
                status = "core_only_chords"
            elif labels[:1] == ["I"] and len(labels) - 1 == len(chords):
                aligned = {i + 1: chord for i, chord in enumerate(chords)}
                status = "skip_intro"

            for spec in specs_all:
                manual_key = aligned.get(spec["position"], "")
                maps[(fname, spec["segment_label"])] = {
                    "key_manual": cls.normalize_key(manual_key),
                    "manual_alignment_status": status if manual_key else "ambiguous",
                }

        return maps

    @staticmethod
    def normalize_key(value: str) -> str:
        """Normalize key spellings like ``Bb major`` to ``A# major``."""
        if not value:
            return ""
        match = KEY_RE.match(str(value))
        if not match:
            return str(value).strip()
        tonic_raw, mode_raw = match.groups()
        tonic_idx = TONIC_ALIASES.get(tonic_raw)
        if tonic_idx is None:
            return str(value).strip()
        return f"{TONICS_DISPLAY[tonic_idx]} {mode_raw.lower()}"

    @staticmethod
    def key_distance(key_a: str, key_b: str) -> float:
        """Return circle-of-fifths tonic distance plus a small mode penalty."""
        parsed_a = SegmentKeyEstimator._parse_key(key_a)
        parsed_b = SegmentKeyEstimator._parse_key(key_b)
        if parsed_a is None or parsed_b is None:
            return np.nan
        tonic_a, mode_a = parsed_a
        tonic_b, mode_b = parsed_b
        fifth_a = (tonic_a * 7) % 12
        fifth_b = (tonic_b * 7) % 12
        tonic_distance = abs(fifth_a - fifth_b)
        tonic_distance = min(tonic_distance, 12 - tonic_distance)
        mode_penalty = 0 if mode_a == mode_b else 1
        return float(tonic_distance + mode_penalty)

    def _chroma(self, y: np.ndarray, sr: int) -> np.ndarray:
        if self.chroma_method == "stft":
            return librosa.feature.chroma_stft(y=y, sr=sr)
        if self.chroma_method == "cqt":
            return librosa.feature.chroma_cqt(y=y, sr=sr)
        raise ValueError("chroma_method must be 'cqt' or 'stft'")

    def _weighted_pitch_class_profile(self, chroma: np.ndarray) -> np.ndarray:
        if chroma.ndim != 2 or chroma.shape[0] != 12:
            raise ValueError(f"expected chroma shape (12, frames), got {chroma.shape}")
        frames = chroma.shape[1]
        weights = np.ones(frames, dtype=float)
        edge = int(frames * self.trim_edge_fraction)
        if edge > 0 and edge * 2 < frames:
            ramp = np.linspace(0.35, 1.0, edge)
            weights[:edge] = ramp
            weights[-edge:] = ramp[::-1]
        profile = np.average(chroma, axis=1, weights=weights)
        profile = np.maximum(profile, 0)
        total = profile.sum()
        if total <= 0:
            raise ValueError("zero chroma profile")
        return profile / total

    @staticmethod
    def _key_scores(profile: np.ndarray) -> np.ndarray:
        profile_z = SegmentKeyEstimator._zscore(profile)
        major_z = SegmentKeyEstimator._zscore(MAJOR_PROFILE)
        minor_z = SegmentKeyEstimator._zscore(MINOR_PROFILE)
        scores = []
        for tonic in range(12):
            scores.append(float(np.dot(profile_z, np.roll(major_z, tonic)) / 12.0))
        for tonic in range(12):
            scores.append(float(np.dot(profile_z, np.roll(minor_z, tonic)) / 12.0))
        return np.asarray(scores, dtype=float)

    @staticmethod
    def _key_name(index: int) -> str:
        mode = "major" if index < 12 else "minor"
        tonic = TONICS_DISPLAY[index % 12]
        return f"{tonic} {mode}"

    @staticmethod
    def _softmax(scores: np.ndarray) -> np.ndarray:
        centered = scores - np.max(scores)
        exp = np.exp(centered)
        return exp / exp.sum()

    @staticmethod
    def _zscore(values: np.ndarray) -> np.ndarray:
        values = np.asarray(values, dtype=float)
        std = values.std()
        if std == 0:
            return values - values.mean()
        return (values - values.mean()) / std

    @staticmethod
    def _split_chords(value: object) -> list[str]:
        if pd.isna(value) or str(value).strip() == "":
            return []
        return [part.strip() for part in str(value).split(";") if part.strip()]

    @staticmethod
    def _parse_key(value: str) -> tuple[int, str] | None:
        match = KEY_RE.match(str(value))
        if not match:
            return None
        tonic, mode = match.groups()
        tonic_idx = TONIC_ALIASES.get(tonic)
        if tonic_idx is None:
            return None
        return tonic_idx, mode.lower()

    def _manual_comparison(self, key_inferred: str, manual: dict) -> dict:
        manual_key = manual.get("key_manual", "")
        status = manual.get("manual_alignment_status", "")
        normalized_inferred = self.normalize_key(key_inferred)
        parsed_inferred = self._parse_key(normalized_inferred)
        parsed_manual = self._parse_key(manual_key)

        exact = ""
        tonic_match = ""
        mode_match = ""
        distance = np.nan
        if parsed_inferred is not None and parsed_manual is not None:
            exact = normalized_inferred == manual_key
            tonic_match = parsed_inferred[0] == parsed_manual[0]
            mode_match = parsed_inferred[1] == parsed_manual[1]
            distance = self.key_distance(normalized_inferred, manual_key)

        return {
            "key_manual": manual_key,
            "manual_alignment_status": status,
            "key_match_manual": exact,
            "tonic_match_manual": tonic_match,
            "mode_match_manual": mode_match,
            "key_distance_manual": distance,
        }
