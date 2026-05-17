"""
extract_handcrafted.py
======================
Phase 2.1 — Handcrafted Feature Extraction

Extracts 35 interpretable features from every core segment (T / V1..Vn)
in the MBH piano subset (277 recordings, ~2000 segments).

Output:
  features/handcrafted_features.csv

Run from project root:
  python3 extract_handcrafted.py

Options (edit the CONFIG block below):
  TARGET_ALL = False  →  MBH piano subset only (recommended first run)
  TARGET_ALL = True   →  all 692 records
  WHICH      = "core" →  T / V1..Vn only
  WHICH      = "all"  →  also include I / C / Inter / B
"""

import sys
import time
import traceback
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# ── CONFIG ───────────────────────────────────────────────────────────────────
TARGET_ALL = False   # True = all 692 records; False = MBH piano subset
WHICH      = "core"  # "core" | "all"
SR         = 22050   # our WAVs are already 22050 Hz mono
# ─────────────────────────────────────────────────────────────────────────────

ROOT      = Path(__file__).resolve().parents[2]  # backend/pipeline/ -> project root
CSV_PATH  = ROOT / "data" / "TV_annotation_clean.csv"
AUDIO_DIR = ROOT / "audio"
FEAT_DIR  = ROOT / "features"
FEAT_DIR.mkdir(exist_ok=True)
OUT_CSV   = FEAT_DIR / "handcrafted_features.csv"
LOG_DIR   = ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_PATH  = LOG_DIR / "extract_handcrafted.log"

import re
CORE_PAT  = re.compile(r"^(T|V[0-9]+)$")
EXTRA_PAT = re.compile(r"^(I|C|Inter|B)$")


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)
            stream.flush()

    def flush(self):
        for stream in self.streams:
            stream.flush()


# ── Helpers ──────────────────────────────────────────────────────────────────

def get_labels(row, which="core"):
    all_lbl = [s.strip() for s in str(row["label"]).split(";") if s.strip()]
    if which == "all":   return all_lbl
    if which == "core":  return [l for l in all_lbl if CORE_PAT.match(l)]
    if which == "extra": return [l for l in all_lbl if EXTRA_PAT.match(l)]

def get_wav(row, lbl):
    return AUDIO_DIR / row["folder"] / row["file_name (folderName_number)"] / f"{lbl}.wav"

def fmt_time(seconds):
    m, s = divmod(int(seconds), 60)
    return f"{m}m{s:02d}s"


# ── Feature extraction ────────────────────────────────────────────────────────

def extract_one(wav_path: Path) -> dict:
    import librosa

    y, _ = librosa.load(str(wav_path), sr=SR, mono=True)
    feat = {}

    # ── Pitch ────────────────────────────────────────────────────────────────
    try:
        f0, voiced, _ = librosa.pyin(
            y, fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"), sr=SR,
        )
        f0v = f0[voiced] if voiced is not None else np.array([])
        if len(f0v) > 1:
            diff = np.diff(f0v)
            feat["mean_pitch"]      = float(np.mean(f0v))
            feat["pitch_range"]     = float(np.ptp(f0v))
            feat["pitch_variance"]  = float(np.var(f0v))
            feat["contour_changes"] = float(np.sum(np.diff(np.sign(diff)) != 0))
            feat["upward_ratio"]    = float(np.sum(diff > 0) / len(diff))
            feat["leap_ratio"]      = float(np.sum(np.abs(diff) > 100) / len(diff))
        else:
            for k in ["mean_pitch","pitch_range","pitch_variance",
                      "contour_changes","upward_ratio","leap_ratio"]:
                feat[k] = float("nan")
    except Exception:
        for k in ["mean_pitch","pitch_range","pitch_variance",
                  "contour_changes","upward_ratio","leap_ratio"]:
            feat[k] = float("nan")

    # ── Rhythm ───────────────────────────────────────────────────────────────
    try:
        onset_frames = librosa.onset.onset_detect(y=y, sr=SR)
        onset_times  = librosa.frames_to_time(onset_frames, sr=SR)
        duration     = librosa.get_duration(y=y, sr=SR)
        feat["onset_density"] = float(len(onset_times) / duration) if duration > 0 else float("nan")
        feat["note_density"]  = feat["onset_density"]
        if len(onset_times) > 1:
            ioi = np.diff(onset_times)
            feat["tempo_stability"]   = float(1.0 / (np.std(ioi) + 1e-6))
            feat["rhythmic_variance"] = float(np.var(ioi))
        else:
            feat["tempo_stability"]   = float("nan")
            feat["rhythmic_variance"] = float("nan")
    except Exception:
        for k in ["onset_density","note_density","tempo_stability","rhythmic_variance"]:
            feat[k] = float("nan")

    # ── Dynamics ─────────────────────────────────────────────────────────────
    try:
        rms = librosa.feature.rms(y=y)[0]
        feat["rms_mean"]     = float(np.mean(rms))
        feat["rms_variance"] = float(np.var(rms))
    except Exception:
        feat["rms_mean"] = feat["rms_variance"] = float("nan")

    # ── Harmony ──────────────────────────────────────────────────────────────
    try:
        chroma      = librosa.feature.chroma_cqt(y=y, sr=SR)
        chroma_mean = chroma.mean(axis=1)
        chroma_norm = chroma_mean / (chroma_mean.sum() + 1e-6)
        feat["chroma_entropy"]     = float(-np.sum(chroma_norm * np.log(chroma_norm + 1e-6)))
        feat["tonal_centroid"]     = float(np.dot(np.arange(12), chroma_norm))
        feat["harmonic_stability"] = float(np.max(chroma_norm))
    except Exception:
        for k in ["chroma_entropy","tonal_centroid","harmonic_stability"]:
            feat[k] = float("nan")

    # ── Timbre ───────────────────────────────────────────────────────────────
    try:
        spec_c = librosa.feature.spectral_centroid(y=y, sr=SR)[0]
        feat["spectral_centroid_mean"] = float(np.mean(spec_c))
        feat["spectral_brightness"]    = float(np.mean(spec_c) / (SR / 2))
        mfcc = librosa.feature.mfcc(y=y, sr=SR, n_mfcc=13)
        for i in range(13):
            feat[f"mfcc_mean_{i}"] = float(np.mean(mfcc[i]))
            feat[f"mfcc_var_{i}"]  = float(np.var(mfcc[i]))
    except Exception:
        feat["spectral_centroid_mean"] = feat["spectral_brightness"] = float("nan")
        for i in range(13):
            feat[f"mfcc_mean_{i}"] = feat[f"mfcc_var_{i}"] = float("nan")

    return feat


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    log_file = LOG_PATH.open("w", encoding="utf-8")
    sys.stdout = Tee(sys.stdout, log_file)
    sys.stderr = Tee(sys.stderr, log_file)

    print("=" * 60)
    print("Phase 2.1 — Handcrafted Feature Extraction")
    print("=" * 60)

    # Load data
    df = pd.read_csv(CSV_PATH)
    print(f"Loaded {len(df)} records from {CSV_PATH.name}")

    # Subset
    if TARGET_ALL:
        df_target = df
        print(f"Target: ALL records ({len(df_target)})")
    else:
        MBH = ["Wolfgang Amadeus Mozart", "Ludwig van Beethoven", "Joseph Haydn"]
        df_target = df[
            df["composer"].isin(MBH) &
            (df["instrument"].str.lower().str.strip() == "piano")
        ].copy().reset_index(drop=True)
        print(f"Target: MBH piano subset ({len(df_target)} records)")

    # Build work list
    work = []
    for _, row in df_target.iterrows():
        for lbl in get_labels(row, WHICH):
            wav = get_wav(row, lbl)
            if wav.exists():
                work.append((row, lbl, wav))
            else:
                print(f"  [MISSING] {row['file_name (folderName_number)']}/{lbl}.wav")

    total = len(work)
    print(f"Segments to process : {total}")
    print(f"Output              : {OUT_CSV}")
    print("-" * 60)

    # Check for partial save to resume
    records, errors = [], []
    done_keys = set()

    if OUT_CSV.exists():
        df_existing = pd.read_csv(OUT_CSV)
        for _, r in df_existing.iterrows():
            done_keys.add((r["file_name"], r["label"]))
        records = df_existing.to_dict("records")
        print(f"Resuming: {len(done_keys)} segments already done.\n")

    todo = [(row, lbl, wav) for row, lbl, wav in work
            if (row["file_name (folderName_number)"], lbl) not in done_keys]
    print(f"Remaining: {len(todo)} segments\n")

    t_start = time.time()

    for n, (row, lbl, wav) in enumerate(todo):
        fname = row["file_name (folderName_number)"]
        t0 = time.time()

        try:
            feat = extract_one(wav)
            feat.update({
                "file_name":  fname,
                "composer":   row["composer"],
                "piece":      row["music_name"],
                "period":     row["period"],
                "instrument": row["instrument"],
                "label":      lbl,
            })
            records.append(feat)

            elapsed   = time.time() - t_start
            seg_time  = time.time() - t0
            done_n    = len(records)
            remaining = total - done_n
            eta       = (elapsed / done_n * remaining) if done_n > 0 else 0

            # Print every segment, with ETA every 10
            if (n + 1) % 10 == 0 or n == 0:
                print(f"  [{done_n:4d}/{total}]  {fname}/{lbl}"
                      f"  ({seg_time:.1f}s)  elapsed={fmt_time(elapsed)}  ETA={fmt_time(eta)}")
            else:
                print(f"  [{done_n:4d}/{total}]  {fname}/{lbl}  ({seg_time:.1f}s)")

            # Save checkpoint every 100 segments
            if done_n % 100 == 0:
                _save(records, done_n, total)

        except Exception as e:
            errors.append({"file_name": fname, "label": lbl, "error": str(e)})
            print(f"  [ERROR]  {fname}/{lbl}: {e}")
            traceback.print_exc()

    # Final save
    _save(records, len(records), total, final=True)

    print("\n" + "=" * 60)
    print(f"Done.")
    print(f"  Segments extracted : {len(records)}")
    print(f"  Errors             : {len(errors)}")
    print(f"  Total time         : {fmt_time(time.time() - t_start)}")
    print(f"  Output             : {OUT_CSV}")
    if errors:
        print("\nErrors:")
        for e in errors:
            print(f"  {e['file_name']}/{e['label']}: {e['error']}")

    log_file.close()


def _save(records, done, total, final=False):
    meta_cols = ["file_name","composer","piece","period","instrument","label"]
    df_out = pd.DataFrame(records)
    feat_cols = [c for c in df_out.columns if c not in meta_cols]
    df_out = df_out[meta_cols + feat_cols]
    df_out.to_csv(OUT_CSV, index=False)
    tag = "FINAL" if final else "checkpoint"
    print(f"\n  [{tag}] Saved {done}/{total} rows → {OUT_CSV}\n")


if __name__ == "__main__":
    main()
