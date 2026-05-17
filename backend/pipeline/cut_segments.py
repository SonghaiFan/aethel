"""
cut_segments.py
Cuts ALL segments (T, V1..Vn, I, C, Inter, B) from raw WAV files
based on boundary timestamps in TV_annotation_clean.csv.

Boundary format in CSV: MM.SS  (e.g. 1.54 = 1 min 54 sec)
Segment rule: segment[i] = raw_wav[ boundary[i] : boundary[i+1] ]

Skip list: WAV files known to have wrong duration.
Run from the project root:  python3 backend/pipeline/cut_segments.py
"""

import sys
from pathlib import Path

# Ensure project root is on sys.path when script is run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pandas as pd
import soundfile as sf

# ── Config ──────────────────────────────────────────────────
CSV_PATH  = Path("data/TV_annotation_clean.csv")
AUDIO_DIR = Path("audio")

# These raw WAVs have wrong duration — skip until manually fixed
SKIP = {
    "LBeethoven_OP34_1",   # CSV=11:54, actual WAV=39:35 (3x too long)
    "RSchumann_WOO24_1",   # CSV=11:11, actual WAV=22:27 (2x too long)
}

# ── Helper ───────────────────────────────────────────────────
def mmss_to_sec(val: float) -> float:
    """Convert MM.SS float to total seconds. e.g. 1.54 -> 114.0"""
    val  = float(val)
    mins = int(val)
    secs = round((val - mins) * 100, 6)
    return mins * 60 + secs

def occurrence_label(label: str, occurrence: int, total: int) -> str:
    """Use occurrence-aware filenames for repeated labels in one record."""
    return f"{label}__{occurrence + 1}" if total > 1 else label

# ── Main ─────────────────────────────────────────────────────
def main():
    df = pd.read_csv(CSV_PATH)
    print(f"Loaded {len(df)} records from {CSV_PATH}")

    cut     = 0
    skipped = []
    errors  = []

    for idx, row in df.iterrows():
        fname  = row["file_name (folderName_number)"]
        folder = row["folder"]

        if fname in SKIP:
            skipped.append(fname)
            continue

        raw_wav = AUDIO_DIR / folder / f"{fname}.wav"
        if not raw_wav.exists():
            errors.append(f"MISSING raw WAV: {raw_wav}")
            continue

        labels = [l.strip() for l in row["label"].split(";")]
        bounds = [mmss_to_sec(b) for b in row["boundary"].split(";")]

        if len(bounds) != len(labels) + 1:
            errors.append(
                f"BOUNDARY MISMATCH: {fname}  "
                f"labels={len(labels)}  bounds={len(bounds)}"
            )
            continue

        # Read full raw audio once per recording
        try:
            data, sr = sf.read(str(raw_wav), dtype="float32", always_2d=False)
        except Exception as e:
            errors.append(f"READ ERROR: {raw_wav}  {e}")
            continue

        total_samples = len(data)
        seg_dir = AUDIO_DIR / folder / fname
        seg_dir.mkdir(exist_ok=True)

        label_totals = pd.Series(labels).value_counts().to_dict()
        label_seen = {}

        for i, lbl in enumerate(labels):
            occurrence = label_seen.get(lbl, 0)
            label_seen[lbl] = occurrence + 1
            out_lbl = occurrence_label(lbl, occurrence, int(label_totals.get(lbl, 1)))

            start_s = bounds[i]
            end_s   = bounds[i + 1]

            start_samp = min(int(round(start_s * sr)), total_samples)
            end_samp   = min(int(round(end_s   * sr)), total_samples)

            if end_samp <= start_samp:
                errors.append(
                    f"EMPTY SEGMENT: {fname} {out_lbl} "
                    f"[{start_s:.2f}s → {end_s:.2f}s]"
                )
                continue

            segment  = data[start_samp:end_samp]
            out_path = seg_dir / f"{out_lbl}.wav"
            sf.write(str(out_path), segment, sr)
            cut += 1

        # Progress every 50 recordings
        if (idx + 1) % 50 == 0:
            print(f"  [{idx+1}/{len(df)}] segments cut so far: {cut}")

    print()
    print(f"Done.")
    print(f"  Segments cut   : {cut}")
    print(f"  Skipped (bad WAV): {skipped}")
    print(f"  Errors         : {len(errors)}")
    for e in errors:
        print(f"    {e}")


if __name__ == "__main__":
    main()
