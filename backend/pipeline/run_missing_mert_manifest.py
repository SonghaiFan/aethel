"""
Run MERT embedding extraction from a missing-segment manifest.

This script is intended for small Colab packages that contain only the WAV files
that are not already cached locally. It writes embeddings to the same
``embeddings/mert_embeddings/<folder>/<file_name>/<label>.npy`` layout used by
``MERTEmbedder.extract_batch`` so the results can be unzipped back into the
project and merged by rebuilding ``embeddings.npy`` from cache.

For Colab, pass ``--output-root /content/drive/MyDrive/<folder>`` so every
completed embedding is saved directly to Google Drive. If Colab disconnects,
rerun the same command and existing Drive files will be skipped.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="Project/package root.")
    parser.add_argument(
        "--manifest",
        default="missing_core_segments.csv",
        help="CSV with wav_path and embedding_path columns.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device override, e.g. cuda, cpu, or mps. Defaults to auto.",
    )
    parser.add_argument(
        "--torch-num-threads",
        type=int,
        default=None,
        help="CPU thread cap used only when device=cpu.",
    )
    parser.add_argument(
        "--max-segments",
        type=int,
        default=None,
        help="Optional cap for test runs.",
    )
    parser.add_argument(
        "--output-root",
        default=None,
        help=(
            "Optional output root for embeddings and index. Use a Google Drive "
            "path in Colab to persist partial results across disconnects."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    output_root = Path(args.output_root).resolve() if args.output_root else root
    output_root.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(root))
    from tv_core import MERTEmbedder

    manifest_path = root / args.manifest
    df = pd.read_csv(manifest_path)
    if args.max_segments is not None:
        df = df.head(args.max_segments).copy()

    embedder = MERTEmbedder(
        device=args.device,
        torch_num_threads=args.torch_num_threads,
        prefer_local=False,
    )
    records = []
    total = len(df)

    print(f"Manifest: {manifest_path}", flush=True)
    print(f"Segments to process: {total}", flush=True)
    print(f"Output root: {output_root}", flush=True)

    for idx, row in df.iterrows():
        n = len(records) + 1
        wav_path = root / row["wav_path"]
        emb_path = output_root / row["embedding_path"]
        fname = row["file_name"]
        label = row["label"]

        if emb_path.exists():
            print(f"SKIP  [{n}/{total}] {fname} / {label} already exists", flush=True)
            status = "cached"
            error = ""
        else:
            print(f"START [{n}/{total}] {fname} / {label}", flush=True)
            started = time.perf_counter()
            try:
                emb = embedder.extract_one(wav_path)
                emb_path.parent.mkdir(parents=True, exist_ok=True)
                np.save(emb_path, emb.astype("float32"))
                elapsed = time.perf_counter() - started
                print(f"DONE  [{n}/{total}] {fname} / {label} in {elapsed:.1f}s", flush=True)
                status = "extracted"
                error = ""
            except Exception as exc:
                print(f"ERROR [{n}/{total}] {fname} / {label}: {exc}", flush=True)
                status = "error"
                error = str(exc)

        records.append(
            {
                "file_name": fname,
                "composer": row.get("composer", ""),
                "period": row.get("period", ""),
                "label": label,
                "wav_path": row["wav_path"],
                "embedding_path": row["embedding_path"],
                "output_path": str(emb_path.relative_to(output_root)),
                "status": status,
                "error": error,
            }
        )
        out_path = output_root / "missing_core_embedding_index.csv"
        pd.DataFrame(records).to_csv(out_path, index=False)

    out_path = output_root / "missing_core_embedding_index.csv"
    pd.DataFrame(records).to_csv(out_path, index=False)
    print(f"Saved index -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
