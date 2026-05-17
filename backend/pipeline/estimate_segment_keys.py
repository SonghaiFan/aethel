"""Estimate segment-level keys from audio chroma.

Run from project root:

    python backend/pipeline/estimate_segment_keys.py --subset all --which core

The output is written to ``features/segment_keys.csv`` by default. This does
not modify ``data/TV_annotation_clean.csv``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.analysis.key_estimation import SegmentKeyEstimator
from tv_core import TVDataset


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--subset",
        default="all",
        choices=sorted(TVDataset.SUBSETS),
        help="Dataset subset to process.",
    )
    parser.add_argument(
        "--which",
        default="core",
        choices=["core", "extra", "all"],
        help="Segment label set to process.",
    )
    parser.add_argument(
        "--method",
        default="cqt",
        choices=["cqt", "stft"],
        help="Chroma extraction method. CQT is slower but usually cleaner.",
    )
    parser.add_argument(
        "--out",
        default="segment_keys.csv",
        help="Output CSV name under features/.",
    )
    parser.add_argument(
        "--max-segments",
        type=int,
        default=None,
        help="Optional cap for smoke tests.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=50,
        help="Print progress every N segments.",
    )
    parser.add_argument(
        "--compare-manual",
        action="store_true",
        help="Optional diagnostic for legacy/raw CSVs that still contain a chord column.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ds = TVDataset()
    df = ds.subset(args.subset)
    estimator = SegmentKeyEstimator(chroma_method=args.method, verbose=True)
    result = estimator.extract_batch(
        df,
        ds,
        which=args.which,
        save=True,
        out_name=args.out,
        max_segments=args.max_segments,
        progress_every=args.progress_every,
        compare_manual=args.compare_manual,
    )

    print(f"\nRows estimated: {len(result)}")
    if args.compare_manual:
        aligned = result[result["key_manual"].fillna("").astype(str).ne("")]
        print(f"Manual-aligned rows: {len(aligned)}")
    if args.compare_manual and len(aligned):
        exact = aligned["key_match_manual"].fillna(False).astype(bool).mean()
        tonic = aligned["tonic_match_manual"].fillna(False).astype(bool).mean()
        mode = aligned["mode_match_manual"].fillna(False).astype(bool).mean()
        print(f"Exact key accuracy against aligned manual labels: {exact:.1%}")
        print(f"Tonic accuracy against aligned manual labels:    {tonic:.1%}")
        print(f"Mode accuracy against aligned manual labels:     {mode:.1%}")
        print("\nManual alignment statuses:")
        print(aligned["manual_alignment_status"].value_counts().to_string())


if __name__ == "__main__":
    main()
