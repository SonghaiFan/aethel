"""Import reusable archive MERT embeddings into the current project cache."""

from __future__ import annotations

import re
import sys
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

# Ensure project root is on sys.path when script is run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tv_core import TVDataset, MERTEmbedder


ARCHIVE_EMB_DIR = Path("/Users/songhaifan/Desktop/archive/segmented_audio/mert_embeddings")
ARCHIVE_INDEX = Path(
    "/Users/songhaifan/Desktop/archive/2026-03-14_post_reslice/"
    "segmented_audio/mert_embedding_index.csv"
)
CORE_PAT = re.compile(r"^(T|V[0-9]+)$")


def main() -> None:
    ds = TVDataset()
    mbh = ds.mbh_piano()
    archive_index = pd.read_csv(ARCHIVE_INDEX) if ARCHIVE_INDEX.exists() else pd.DataFrame()

    copied = []
    skipped = []

    for _, row in mbh.iterrows():
        folder = row["folder"]
        fname = row["file_name (folderName_number)"]
        labels = [s.strip() for s in str(row["label"]).split(";") if CORE_PAT.match(s.strip())]

        for label in labels:
            src = ARCHIVE_EMB_DIR / folder / fname / f"{label}.npy"
            dst = MERTEmbedder.segment_embedding_path(ds, row, label)

            if not src.exists():
                skipped.append({"file_name": fname, "label": label, "reason": "missing_in_archive"})
                continue

            arr = np.load(src, mmap_mode="r")
            if arr.shape != (1024,):
                skipped.append({
                    "file_name": fname,
                    "label": label,
                    "reason": f"bad_shape_{arr.shape}",
                })
                continue

            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

            copied.append({
                "file_name": fname,
                "folder": folder,
                "label": label,
                "source_path": str(src),
                "embedding_path": str(dst.relative_to(ds.paths.root)),
                "pooling": "all_layers_mean",
                "source": "archive",
            })

    copied_df = pd.DataFrame(copied)
    skipped_df = pd.DataFrame(skipped)
    copied_df.to_csv(ds.paths.embeddings / "archive_imported_mert_embeddings.csv", index=False)
    skipped_df.to_csv(ds.paths.embeddings / "archive_missing_mert_embeddings.csv", index=False)

    print(f"Archive index rows: {len(archive_index)}")
    print(f"Copied archive embeddings: {len(copied_df)}")
    print(f"Still missing from archive: {len(skipped_df)}")
    print(f"Output cache root: {ds.paths.embeddings / 'mert_embeddings'}")
    print(f"Import index: {ds.paths.embeddings / 'archive_imported_mert_embeddings.csv'}")


if __name__ == "__main__":
    main()
