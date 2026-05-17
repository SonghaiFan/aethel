"""
Music thumbnail visualization utilities.

The thumbnail is driven by selected handcrafted audio features. Each thumbnail
is a compact radial glyph:

- each spoke is one selected handcrafted feature
- spoke length is the normalized value for this segment
- color comes from the feature group, e.g. pitch, rhythm, timbre

Notebook usage
--------------
    from visualization import MusicThumbnailRenderer

    renderer = MusicThumbnailRenderer(top_n_features=8)
    thumbnail_df = renderer.prepare(df_feat, selection, ds=ds, output_suffix=OUTPUT_SUFFIX)
    renderer.render_gallery(thumbnail_df, file_name=thumbnail_df["file_name"].iloc[0])
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd


GROUP_COLORS = {
    "pitch": "#4C78A8",
    "rhythm": "#F58518",
    "dynamics": "#E45756",
    "harmony": "#72B7B2",
    "timbre": "#54A24B",
    "timbre_mfcc": "#B279A2",
    "other": "#8A8A8A",
}


@dataclass
class MusicThumbnailRenderer:
    """Prepare and draw selected-feature music thumbnails."""

    top_n_features: int = 8
    value_quantile_low: float = 0.05
    value_quantile_high: float = 0.95
    verbose: bool = True
    group_colors: dict[str, str] = field(default_factory=lambda: dict(GROUP_COLORS))

    def prepare(
        self,
        df_feat: pd.DataFrame,
        selection: pd.DataFrame,
        ds=None,
        output_suffix: str = "",
        save: bool = True,
        out_name: str | None = None,
    ) -> pd.DataFrame:
        """
        Build a normalized thumbnail feature table.

        ``selection`` should come from ``HandcraftedFeatureSelector.run`` and
        must contain ``feature`` plus preferably ``group`` and ``overall_rank``.
        """
        self._log("[1/4] Selecting top handcrafted features")
        selected = self.selected_features(selection, df_feat)
        selected_features = selected["feature"].tolist()
        self._log(f"      top features: {selected_features}")

        self._log("[2/4] Normalizing selected audio feature values")
        meta_cols = [c for c in ["file_name", "composer", "piece", "period", "instrument", "label"] if c in df_feat.columns]
        thumb = df_feat[meta_cols + selected_features].copy()

        for feature in selected_features:
            thumb[f"norm_{feature}"] = self._robust_minmax(df_feat[feature])

        feature_to_group = dict(zip(selected["feature"], selected["group"]))
        feature_to_rank = dict(zip(selected["feature"], selected["overall_rank"]))
        thumb.attrs["thumbnail_features"] = selected_features
        thumb.attrs["feature_to_group"] = feature_to_group
        thumb.attrs["feature_to_rank"] = feature_to_rank

        self._log(f"      rows: {len(thumb)}")
        self._log(f"      normalized columns: {len(selected_features)}")

        if save:
            if ds is None:
                raise ValueError("ds is required when save=True.")
            if out_name is None:
                out_name = f"thumbnail_features{output_suffix}.csv"
            out = ds.paths.features / out_name
            self._log("[3/4] Saving thumbnail feature table")
            thumb.to_csv(out, index=False)
            self._log(f"      saved -> {out}")
        else:
            self._log("[3/4] Skipping save")

        self._log("[4/4] Ready to render thumbnails")
        return thumb

    def selected_features(self, selection: pd.DataFrame, df_feat: pd.DataFrame) -> pd.DataFrame:
        required = {"feature"}
        if not required.issubset(selection.columns):
            raise ValueError(f"selection must contain columns: {sorted(required)}")

        selected = selection.copy()
        if "overall_rank" not in selected.columns:
            selected["overall_rank"] = np.arange(1, len(selected) + 1)
        if "group" not in selected.columns:
            selected["group"] = "other"

        selected = selected.sort_values("overall_rank")
        selected = selected[selected["feature"].isin(df_feat.columns)]
        selected = selected[
            selected["feature"].map(lambda col: pd.api.types.is_numeric_dtype(df_feat[col]))
        ]
        selected = selected.head(self.top_n_features).reset_index(drop=True)

        if selected.empty:
            raise ValueError("No selected numeric features are available in df_feat.")
        return selected

    def draw_thumbnail(
        self,
        row: pd.Series,
        selected_features: list[str],
        feature_to_group: dict[str, str],
        ax,
        title: str = "",
    ):
        """Draw one radial thumbnail into a matplotlib axis."""
        import matplotlib.pyplot as plt

        ax.set_xlim(-1.15, 1.15)
        ax.set_ylim(-1.15, 1.15)
        ax.set_aspect("equal")
        ax.axis("off")

        n = len(selected_features)
        angles = np.linspace(math.pi / 2, math.pi / 2 + 2 * math.pi, n, endpoint=False)
        values = np.array([float(row.get(f"norm_{feature}", 0.5)) for feature in selected_features])
        radii = 0.18 + 0.78 * np.clip(values, 0, 1)

        xs = radii * np.cos(angles)
        ys = radii * np.sin(angles)

        # Background reference rings make cross-thumbnail comparison easier.
        for radius in [0.25, 0.5, 0.75, 1.0]:
            circle = plt.Circle((0, 0), radius, fill=False, color="#D0D0D0", lw=0.5, alpha=0.6)
            ax.add_patch(circle)

        for angle, radius, feature in zip(angles, radii, selected_features):
            group = feature_to_group.get(feature, "other")
            color = self.group_colors.get(group, self.group_colors["other"])
            ax.plot([0, radius * np.cos(angle)], [0, radius * np.sin(angle)], color=color, lw=1.3, alpha=0.9)
            ax.scatter([radius * np.cos(angle)], [radius * np.sin(angle)], s=18, color=color, zorder=3)

        ax.fill(xs, ys, color="#111111", alpha=0.08, zorder=1)
        ax.plot(np.r_[xs, xs[0]], np.r_[ys, ys[0]], color="#222222", lw=1.0, alpha=0.6, zorder=2)

        if title:
            ax.set_title(title, fontsize=8, pad=2)

    def render_gallery(
        self,
        thumbnail_df: pd.DataFrame,
        file_name: str | None = None,
        file_prefix: str | None = None,
        selected_features: list[str] | None = None,
        feature_to_group: dict[str, str] | None = None,
        cols: int = 6,
        figsize_per_cell: tuple[float, float] = (1.8, 1.8),
        title: str | None = None,
        save_path: str | Path | None = None,
    ):
        """
        Render a thumbnail gallery for one recording or one file prefix.

        Returns ``(fig, axes, gallery_df)`` for notebook debugging.
        """
        import matplotlib.pyplot as plt

        gallery = self._select_gallery(thumbnail_df, file_name=file_name, file_prefix=file_prefix)
        if selected_features is None:
            selected_features = thumbnail_df.attrs.get("thumbnail_features")
        if feature_to_group is None:
            feature_to_group = thumbnail_df.attrs.get("feature_to_group", {})
        if not selected_features:
            selected_features = [c.replace("norm_", "") for c in thumbnail_df.columns if c.startswith("norm_")]
        if not selected_features:
            raise ValueError("No thumbnail features found. Run prepare() first.")

        gallery = gallery.sort_values("label", key=lambda labels: labels.map(label_sort_key)).reset_index(drop=True)
        n = len(gallery)
        cols = min(cols, max(1, n))
        rows = int(math.ceil(n / cols))
        fig, axes = plt.subplots(rows, cols, figsize=(cols * figsize_per_cell[0], rows * figsize_per_cell[1]))
        axes_arr = np.array(axes).reshape(-1)

        for idx, (_, row) in enumerate(gallery.iterrows()):
            self.draw_thumbnail(
                row,
                selected_features=selected_features,
                feature_to_group=feature_to_group,
                ax=axes_arr[idx],
                title=str(row.get("label", "")),
            )
        for ax in axes_arr[n:]:
            ax.axis("off")

        if title is None:
            title = file_name or file_prefix or "Thumbnail Gallery"
        fig.suptitle(title, fontsize=12)
        fig.tight_layout(rect=[0, 0, 1, 0.92])

        if save_path is not None:
            save_path = Path(save_path)
            save_path.parent.mkdir(parents=True, exist_ok=True)
            fig.savefig(save_path, dpi=180, bbox_inches="tight")
            self._log(f"Saved gallery -> {save_path}")

        return fig, axes_arr, gallery

    def feature_legend(self, selected_features: list[str], feature_to_group: dict[str, str], ax=None):
        """Draw a compact legend mapping selected features to groups/colors."""
        import matplotlib.pyplot as plt

        if ax is None:
            _, ax = plt.subplots(figsize=(8, 1.8))
        ax.axis("off")
        y = 0.9
        for idx, feature in enumerate(selected_features):
            group = feature_to_group.get(feature, "other")
            color = self.group_colors.get(group, self.group_colors["other"])
            ax.scatter([0.02], [y], s=28, color=color)
            ax.text(0.06, y, f"{idx + 1}. {feature} ({group})", va="center", fontsize=9)
            y -= 0.1
        return ax

    def render_waveform_ridgeline(
        self,
        df_records: pd.DataFrame,
        ds,
        file_name: str | None = None,
        file_prefix: str | None = None,
        which: str = "core",
        max_points: int = 1200,
        normalize_each: bool = True,
        fill: bool = True,
        title: str | None = None,
        save_path: str | Path | None = None,
    ):
        """
        Render segment waveforms as a ridgeline plot.

        Each row is one segment WAV from a single recording. The x-axis is
        normalized segment time from 0 to 1, which makes T/V1/V2... shapes easy
        to compare even when segment durations differ.

        Returns ``(fig, ax, ridge_df)`` for notebook debugging.
        """
        import matplotlib.pyplot as plt
        import soundfile as sf

        row = self._select_record(df_records, file_name=file_name, file_prefix=file_prefix)
        labels = ds.labels(row, which=which)
        if not labels:
            raise ValueError(f"No labels found for which={which!r}.")

        rows = []
        for label in sorted(labels, key=label_sort_key):
            wav_path = ds.segment_path(row, label)
            if not wav_path.exists():
                self._log(f"Skipping missing WAV: {wav_path}")
                continue

            y, sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
            if y.ndim > 1:
                y = y.mean(axis=1)
            if len(y) == 0:
                continue

            y_plot = self._downsample_waveform(y, max_points=max_points)
            if normalize_each:
                denom = np.max(np.abs(y_plot))
                if denom > 0:
                    y_plot = y_plot / denom

            x_plot = np.linspace(0, 1, len(y_plot))
            rows.append({
                "label": label,
                "wav_path": str(wav_path),
                "duration_sec": len(y) / sr,
                "x": x_plot,
                "y": y_plot,
            })

        if not rows:
            raise ValueError("No waveform rows could be loaded.")

        fig_height = max(3.0, 0.55 * len(rows) + 1.2)
        fig, ax = plt.subplots(figsize=(10, fig_height))
        palette = plt.cm.viridis(np.linspace(0.12, 0.9, len(rows)))

        ytick_pos = []
        ytick_labels = []
        for idx, item in enumerate(rows):
            baseline = len(rows) - idx
            amp = 0.38
            y_line = baseline + amp * item["y"]
            color = palette[idx]
            ax.plot(item["x"], y_line, color=color, lw=1.0)
            if fill:
                ax.fill_between(item["x"], baseline, y_line, color=color, alpha=0.35)
            ax.text(
                1.01,
                baseline,
                f"{item['label']}  {item['duration_sec']:.1f}s",
                va="center",
                ha="left",
                fontsize=8,
            )
            ytick_pos.append(baseline)
            ytick_labels.append(item["label"])

        selected_name = row["file_name (folderName_number)"]
        ax.set_xlim(0, 1.18)
        ax.set_ylim(0.4, len(rows) + 0.7)
        ax.set_yticks(ytick_pos)
        ax.set_yticklabels(ytick_labels)
        ax.set_xlabel("Normalized segment time")
        ax.set_title(title or f"Waveform Ridgeline — {selected_name}")
        ax.spines[["top", "right", "left"]].set_visible(False)
        ax.tick_params(axis="y", length=0)
        ax.grid(axis="x", color="#D8D8D8", lw=0.6, alpha=0.6)
        fig.tight_layout()

        if save_path is not None:
            save_path = Path(save_path)
            save_path.parent.mkdir(parents=True, exist_ok=True)
            fig.savefig(save_path, dpi=180, bbox_inches="tight")
            self._log(f"Saved ridgeline -> {save_path}")

        ridge_df = pd.DataFrame([
            {
                "file_name": selected_name,
                "label": item["label"],
                "duration_sec": item["duration_sec"],
                "wav_path": item["wav_path"],
            }
            for item in rows
        ])
        return fig, ax, ridge_df

    def draw_waveform_thumbnail(
        self,
        row: pd.Series,
        wav_path: str | Path,
        selected_features: list[str],
        feature_to_group: dict[str, str],
        ax,
        title: str = "",
        waveform_points: int = 360,
    ):
        """
        Draw one waveform thumbnail.

        The inner radial glyph shows selected handcrafted feature values. The
        outer circular line shows the segment waveform over normalized time.
        """
        import matplotlib.pyplot as plt
        import soundfile as sf

        ax.set_xlim(-1.25, 1.25)
        ax.set_ylim(-1.25, 1.25)
        ax.set_aspect("equal")
        ax.axis("off")

        # Outer waveform ring first, so the selected-feature glyph stays legible.
        wav_path = Path(wav_path)
        if wav_path.exists():
            y, _ = sf.read(str(wav_path), dtype="float32", always_2d=False)
            if y.ndim > 1:
                y = y.mean(axis=1)
            if len(y) > 0:
                y_plot = self._downsample_waveform(y, max_points=waveform_points)
                denom = np.max(np.abs(y_plot))
                if denom > 0:
                    y_plot = y_plot / denom
                theta = np.linspace(math.pi / 2, math.pi / 2 + 2 * math.pi, len(y_plot), endpoint=False)
                radius = 0.92 + 0.16 * y_plot
                x_wave = radius * np.cos(theta)
                y_wave = radius * np.sin(theta)
                ax.plot(x_wave, y_wave, color="#222222", lw=0.9, alpha=0.75, zorder=4)

        # Reference circle separates waveform contour from feature spokes.
        ax.add_patch(plt.Circle((0, 0), 0.92, fill=False, color="#CFCFCF", lw=0.7, alpha=0.8))

        # Inner selected-feature radial glyph.
        n = len(selected_features)
        angles = np.linspace(math.pi / 2, math.pi / 2 + 2 * math.pi, n, endpoint=False)
        values = np.array([float(row.get(f"norm_{feature}", 0.5)) for feature in selected_features])
        radii = 0.16 + 0.58 * np.clip(values, 0, 1)
        xs = radii * np.cos(angles)
        ys = radii * np.sin(angles)

        for radius in [0.25, 0.5, 0.75]:
            ax.add_patch(plt.Circle((0, 0), radius, fill=False, color="#E0E0E0", lw=0.5, alpha=0.7))

        for angle, radius, feature in zip(angles, radii, selected_features):
            group = feature_to_group.get(feature, "other")
            color = self.group_colors.get(group, self.group_colors["other"])
            ax.plot([0, radius * np.cos(angle)], [0, radius * np.sin(angle)], color=color, lw=1.2, alpha=0.9)
            ax.scatter([radius * np.cos(angle)], [radius * np.sin(angle)], s=16, color=color, zorder=5)

        ax.fill(xs, ys, color="#111111", alpha=0.07, zorder=1)
        ax.plot(np.r_[xs, xs[0]], np.r_[ys, ys[0]], color="#222222", lw=0.9, alpha=0.65, zorder=3)
        ax.scatter([0], [0], s=8, color="#222222", alpha=0.55, zorder=6)

        if title:
            ax.set_title(title, fontsize=8, pad=2)

    def render_waveform_thumbnail_gallery(
        self,
        thumbnail_df: pd.DataFrame,
        df_records: pd.DataFrame,
        ds,
        file_name: str | None = None,
        file_prefix: str | None = None,
        selected_features: list[str] | None = None,
        feature_to_group: dict[str, str] | None = None,
        cols: int = 6,
        figsize_per_cell: tuple[float, float] = (1.9, 1.9),
        title: str | None = None,
        save_path: str | Path | None = None,
    ):
        """
        Render waveform thumbnails for one recording or file prefix.

        Returns ``(fig, axes, gallery_df)`` for notebook debugging.
        """
        import matplotlib.pyplot as plt

        gallery = self._select_gallery(thumbnail_df, file_name=file_name, file_prefix=file_prefix)
        record = self._select_record(
            df_records,
            file_name=gallery["file_name"].iloc[0] if file_name is not None else None,
            file_prefix=file_prefix,
        )

        if selected_features is None:
            selected_features = thumbnail_df.attrs.get("thumbnail_features")
        if feature_to_group is None:
            feature_to_group = thumbnail_df.attrs.get("feature_to_group", {})
        if not selected_features:
            selected_features = [c.replace("norm_", "") for c in thumbnail_df.columns if c.startswith("norm_")]
        if not selected_features:
            raise ValueError("No thumbnail features found. Run prepare() first.")

        gallery = gallery.sort_values("label", key=lambda labels: labels.map(label_sort_key)).reset_index(drop=True)
        n = len(gallery)
        cols = min(cols, max(1, n))
        rows = int(math.ceil(n / cols))
        fig, axes = plt.subplots(rows, cols, figsize=(cols * figsize_per_cell[0], rows * figsize_per_cell[1]))
        axes_arr = np.array(axes).reshape(-1)

        for idx, (_, thumb_row) in enumerate(gallery.iterrows()):
            label = str(thumb_row["label"])
            wav_path = ds.segment_path(record, label)
            self.draw_waveform_thumbnail(
                row=thumb_row,
                wav_path=wav_path,
                selected_features=selected_features,
                feature_to_group=feature_to_group,
                ax=axes_arr[idx],
                title=label,
            )
        for ax in axes_arr[n:]:
            ax.axis("off")

        if title is None:
            title = file_name or file_prefix or "Waveform Thumbnail Gallery"
        fig.suptitle(title, fontsize=12)
        fig.tight_layout(rect=[0, 0, 1, 0.92])

        if save_path is not None:
            save_path = Path(save_path)
            save_path.parent.mkdir(parents=True, exist_ok=True)
            fig.savefig(save_path, dpi=180, bbox_inches="tight")
            self._log(f"Saved waveform thumbnail gallery -> {save_path}")

        return fig, axes_arr, gallery

    # Backward-compatible aliases for old notebook cells.
    def draw_combined_thumbnail(self, *args, **kwargs):
        return self.draw_waveform_thumbnail(*args, **kwargs)

    def render_combined_gallery(self, *args, **kwargs):
        return self.render_waveform_thumbnail_gallery(*args, **kwargs)

    def _robust_minmax(self, values: pd.Series) -> pd.Series:
        numeric = pd.to_numeric(values, errors="coerce").astype(float)
        filled = numeric.fillna(numeric.median())
        lo = filled.quantile(self.value_quantile_low)
        hi = filled.quantile(self.value_quantile_high)
        if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
            return pd.Series(np.full(len(filled), 0.5), index=filled.index)
        return ((filled - lo) / (hi - lo)).clip(0, 1)

    def _select_gallery(
        self,
        thumbnail_df: pd.DataFrame,
        file_name: str | None = None,
        file_prefix: str | None = None,
    ) -> pd.DataFrame:
        if file_name is not None:
            gallery = thumbnail_df[thumbnail_df["file_name"] == file_name].copy()
        elif file_prefix is not None:
            gallery = thumbnail_df[thumbnail_df["file_name"].str.startswith(file_prefix)].copy()
        else:
            first = thumbnail_df["file_name"].iloc[0]
            gallery = thumbnail_df[thumbnail_df["file_name"] == first].copy()
        if gallery.empty:
            raise ValueError("No rows found for requested gallery.")
        return gallery

    def _select_record(
        self,
        df_records: pd.DataFrame,
        file_name: str | None = None,
        file_prefix: str | None = None,
    ) -> pd.Series:
        file_col = "file_name (folderName_number)"
        if file_col not in df_records.columns:
            raise KeyError(f"df_records must contain {file_col!r}.")

        if file_name is not None:
            matches = df_records[df_records[file_col] == file_name]
        elif file_prefix is not None:
            matches = df_records[df_records[file_col].str.startswith(file_prefix)]
        else:
            matches = df_records.iloc[[0]]

        if matches.empty:
            raise ValueError("No matching record found for ridgeline plot.")
        return matches.iloc[0]

    @staticmethod
    def _downsample_waveform(y: np.ndarray, max_points: int) -> np.ndarray:
        if len(y) <= max_points:
            return y.astype("float32")
        idx = np.linspace(0, len(y) - 1, max_points).astype(int)
        return y[idx].astype("float32")

    def _log(self, message: str):
        if self.verbose:
            print(message)


def label_sort_key(label: str):
    if label == "T":
        return (0, 0)
    match = re.match(r"V([0-9]+)$", str(label))
    if match:
        return (1, int(match.group(1)))
    return (2, str(label))
