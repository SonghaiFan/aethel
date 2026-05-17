"""Run Phase 2.2 MERT embedding extraction for the MBH piano subset."""

import os
import sys
from pathlib import Path

# Ensure project root is on sys.path when script is run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tv_core import MERTEmbedder, TVDataset


def main() -> None:
    print("Phase 2.2 MERT embedding extraction starting...", flush=True)
    torch_threads = os.environ.get("TORCH_NUM_THREADS")
    if torch_threads:
        import torch

        torch.set_num_threads(int(torch_threads))
        print(f"Torch num_threads set to: {torch.get_num_threads()}", flush=True)

    ds = TVDataset()
    mbh = ds.mbh_piano()
    max_new = os.environ.get("MERT_MAX_NEW")
    max_new_segments = int(max_new) if max_new else None
    progress_every = int(os.environ.get("MERT_PROGRESS_EVERY", "10"))
    checkpoint_every = int(os.environ.get("MERT_CHECKPOINT_EVERY", "50"))
    device = os.environ.get("MERT_DEVICE") or None
    print(f"Target MBH piano records: {len(mbh)}", flush=True)
    print(f"Max new segments this run: {max_new_segments or 'all remaining'}", flush=True)
    print(f"Progress every: {progress_every}; checkpoint every: {checkpoint_every}", flush=True)
    print(f"Device override: {device or 'auto'}", flush=True)

    emb, meta = MERTEmbedder(device=device, pooling="all_layers_mean").extract_batch(
        mbh,
        ds,
        which="core",
        save=True,
        emb_name="embeddings.npy",
        meta_name="embedding_meta.csv",
        index_name="mert_embedding_index.csv",
        checkpoint_every=checkpoint_every,
        progress_every=progress_every,
        max_new_segments=max_new_segments,
    )

    print(f"Phase 2.2 complete: embeddings={emb.shape}, meta_rows={len(meta)}", flush=True)


if __name__ == "__main__":
    main()
