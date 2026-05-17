"""
fix_bad_wavs.py
Downloads audio from YouTube for recordings whose source WAV has wrong duration,
converts to 22050 Hz mono WAV, replaces the bad file, then re-cuts all segments.

Requirements:  pip install yt-dlp soundfile pandas numpy
Also needs:    ffmpeg  (brew install ffmpeg  or  apt install ffmpeg)

Run from project root:  python3 backend/pipeline/fix_bad_wavs.py
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Ensure project root is on sys.path when script is run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pandas as pd
import soundfile as sf
import numpy as np

# ── Config ──────────────────────────────────────────────────
CSV_PATH  = Path("data/TV_annotation_clean.csv")
AUDIO_DIR = Path("audio")
TARGET_SR = 22050

# Records to fix: {file_name: youtube_url}
TO_FIX = {
    "LBeethoven_OP34_1": "https://www.youtube.com/watch?v=2P-9wBtSm8Y",
    "RSchumann_WOO24_1": "https://www.youtube.com/watch?v=KCmMYh6S5XA",
}

# ── Helper ───────────────────────────────────────────────────
def mmss_to_sec(val: float) -> float:
    """MM.SS → seconds.  e.g. 1.54 → 114.0"""
    val  = float(val)
    mins = int(val)
    secs = round((val - mins) * 100, 6)
    return mins * 60 + secs


def download_wav(url: str, out_path: Path) -> None:
    """Download best audio from YouTube, convert to 22050 Hz mono WAV."""
    print(f"  Downloading: {url}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_template = str(Path(tmp) / "audio.%(ext)s")

        # yt-dlp: download best audio, post-process to WAV via ffmpeg
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--no-playlist",
            "-f", "bestaudio",
            "-x",
            "--audio-format", "wav",
            "--audio-quality", "0",
            "--postprocessor-args", f"ffmpeg:-ar {TARGET_SR} -ac 1",
            "-o", tmp_template,
            url,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"yt-dlp failed:\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}"
            )

        # Find output file
        wavs = list(Path(tmp).glob("*.wav"))
        if not wavs:
            raise FileNotFoundError(f"No WAV produced in {tmp}. yt-dlp output:\n{result.stdout}")

        downloaded = wavs[0]
        print(f"  Downloaded → {downloaded.name}  ({downloaded.stat().st_size/1e6:.1f} MB)")

        # Copy to final destination
        data, sr = sf.read(str(downloaded), dtype="float32", always_2d=False)
        if sr != TARGET_SR:
            raise ValueError(f"Unexpected sample rate {sr} (wanted {TARGET_SR})")
        sf.write(str(out_path), data, sr)
        print(f"  Saved WAV  → {out_path}  ({out_path.stat().st_size/1e6:.1f} MB)")

    # Re-read from saved path so caller always has the canonical version
    data, sr = sf.read(str(out_path), dtype="float32", always_2d=False)
    return data, sr


def cut_segments(row, data, sr):
    """Cut all labelled segments from audio data array and write WAV files."""
    fname  = row["file_name (folderName_number)"]
    folder = row["folder"]
    labels = [l.strip() for l in row["label"].split(";")]
    bounds = [mmss_to_sec(b) for b in row["boundary"].split(";")]

    if len(bounds) != len(labels) + 1:
        print(f"  WARNING: boundary mismatch for {fname}, skipping segment cut")
        return 0

    N       = len(data)
    seg_dir = AUDIO_DIR / folder / fname
    seg_dir.mkdir(exist_ok=True)
    cut = 0

    for i, lbl in enumerate(labels):
        start_s = bounds[i]
        end_s   = bounds[i + 1]
        s = min(int(round(start_s * sr)), N)
        e = min(int(round(end_s   * sr)), N)
        if e <= s:
            print(f"  WARNING: empty segment {lbl} [{start_s:.2f}s→{end_s:.2f}s]")
            continue
        segment  = data[s:e]
        out_path = seg_dir / f"{lbl}.wav"
        sf.write(str(out_path), segment, sr)
        print(f"    {lbl}.wav  {(e-s)/sr:.1f}s")
        cut += 1

    return cut


# ── Main ─────────────────────────────────────────────────────
def main():
    df = pd.read_csv(CSV_PATH)

    for fname, url in TO_FIX.items():
        print(f"\n{'='*60}")
        print(f"Fixing: {fname}")

        row    = df[df["file_name (folderName_number)"] == fname]
        if row.empty:
            print(f"  ERROR: {fname} not found in CSV")
            continue
        row = row.iloc[0]

        folder  = row["folder"]
        raw_wav = AUDIO_DIR / folder / f"{fname}.wav"

        # Verify expected length
        csv_dur = mmss_to_sec(row["length"])
        print(f"  Expected duration : {csv_dur:.1f}s  ({row['length']} MM.SS)")
        if raw_wav.exists():
            info = sf.info(str(raw_wav))
            print(f"  Current WAV      : {info.duration:.1f}s  ← {'OK' if abs(info.duration-csv_dur)<5 else 'WRONG'}")

        # Download fresh WAV
        try:
            data, sr = download_wav(url, raw_wav)
        except Exception as e:
            print(f"  DOWNLOAD FAILED: {e}")
            continue

        # Verify downloaded length — YouTube may contain multiple performances concatenated.
        # If so, trim to CSV length (use last boundary + small buffer as the true end).
        info = sf.info(str(raw_wav))
        diff = info.duration - csv_dur
        print(f"  New WAV duration : {info.duration:.1f}s  (expected {csv_dur:.1f}s, diff={diff:+.1f}s)")

        if diff > 30:
            print(f"  WAV is much longer than CSV — trimming to CSV length...")
            labels = [l.strip() for l in row["label"].split(";")]
            bounds = [mmss_to_sec(b) for b in row["boundary"].split(";")]
            # Trim to last boundary point (end of final labelled segment) + 2s buffer
            trim_end = min(bounds[-1] + 2.0, info.duration)
            trim_samp = int(round(trim_end * sr))
            data = data[:trim_samp]
            sf.write(str(raw_wav), data, sr)
            print(f"  Trimmed WAV to  : {len(data)/sr:.1f}s → {raw_wav}")

        # Re-cut all segments
        print(f"  Cutting segments...")
        n = cut_segments(row, data, sr)
        print(f"  Done: {n} segments written")

    print(f"\n{'='*60}")
    print("All done. Run cut_segments.py again if other recordings also need re-cutting.")


if __name__ == "__main__":
    main()
