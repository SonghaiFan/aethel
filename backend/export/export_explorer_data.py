"""
export_explorer_data.py
=======================
Standalone script wrapper around FrontendExporter in tv_core.

Loads pipeline outputs from disk and produces:
  explorer_app/src/data/segment_visualization{suffix}.csv
  explorer_app/src/data/waveform_thumbnails{suffix}.json

Prefer running Phase 5 in pipeline.ipynb (uses in-memory variables, faster).
Use this script when you want to regenerate frontend data without re-running
the full pipeline (e.g. after tuning top_n_features or waveform_points).

Usage:
  python backend/export/export_explorer_data.py              # full data
  python backend/export/export_explorer_data.py --suffix _test  # test data
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure project root is on sys.path when script is run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pandas as pd
from tv_core import TVDataset, FrontendExporter


def main() -> None:
    parser = argparse.ArgumentParser(description="Regenerate explorer_app data files.")
    parser.add_argument("--suffix",          default="",  help="Output suffix, e.g. _test")
    parser.add_argument("--waveform-points", type=int, default=160)
    parser.add_argument("--top-n-features",  type=int, default=8)
    args = parser.parse_args()

    suffix = args.suffix
    root   = Path(__file__).resolve().parents[2]

    # ── Load pipeline outputs from disk ──────────────────────────────────────
    csv_name = f"data/TV_annotation_clean{'_test' if suffix == '_test' else ''}.csv"
    ds       = TVDataset(csv_name=csv_name)

    df_reduction = pd.read_csv(root / f"embeddings/reduction_embedding{suffix}.csv")
    df_clusters  = pd.read_csv(root / f"embeddings/clusters_embedding{suffix}.csv")
    thumbnail_df = pd.read_csv(root / f"features/thumbnail_features{suffix}.csv")
    selection    = pd.read_csv(
        root / f"features/handcrafted_feature_selection_composer{suffix}.csv"
    )

    print(f"Loaded: {len(ds.df)} records | reduction {df_reduction.shape} | "
          f"clusters {df_clusters.shape} | thumbnail {thumbnail_df.shape}")

    # ── Export ───────────────────────────────────────────────────────────────
    exporter = FrontendExporter(ds, top_n_features=args.top_n_features, verbose=True)
    result   = exporter.run(
        df_ann          = ds.df,
        df_reduction    = df_reduction,
        df_clusters     = df_clusters,
        thumbnail_df    = thumbnail_df,
        selection       = selection,
        output_suffix   = suffix,
        waveform_points = args.waveform_points,
        save            = True,
    )

    errors = result["errors"]
    print(f"\nDone. {len(result['df_vis'])} segments exported.")
    if errors:
        print(f"{len(errors)} waveform warnings (audio files missing or unreadable).")


if __name__ == "__main__":
    main()
