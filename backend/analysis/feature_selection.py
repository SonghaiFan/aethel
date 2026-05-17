"""
Feature selection utilities for the Theme & Variations project.

Notebook usage
--------------
    from feature_selection import HandcraftedFeatureSelector

    selector = HandcraftedFeatureSelector(target_col="composer")
    selection, group_summary = selector.run(
        df_feat=df_feat,
        ds=ds,
        output_suffix=OUTPUT_SUFFIX,
    )
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
import pandas as pd


DEFAULT_LEAKAGE_COLS = {
    "file_name",
    "composer",
    "piece",
    "period",
    "instrument",
    "label",
    "embedding_path",
    "pooling",
    "status",
    "error",
    "source_embedding_row",
}


DEFAULT_FEATURE_GROUPS = {
    "mean_pitch": "pitch",
    "pitch_range": "pitch",
    "pitch_variance": "pitch",
    "contour_changes": "pitch",
    "upward_ratio": "pitch",
    "leap_ratio": "pitch",
    "onset_density": "rhythm",
    "note_density": "rhythm",
    "tempo_stability": "rhythm",
    "rhythmic_variance": "rhythm",
    "rms_mean": "dynamics",
    "rms_variance": "dynamics",
    "chroma_entropy": "harmony",
    "tonal_centroid": "harmony",
    "harmonic_stability": "harmony",
    "key_tonic_pc": "key",
    "key_mode_major": "key",
    "key_confidence": "key",
    "key_margin": "key",
    "key_score": "key",
    "key_second_tonic_pc": "key",
    "key_second_mode_major": "key",
    "key_tonic_sin": "key",
    "key_tonic_cos": "key",
    "key_fifths_sin": "key",
    "key_fifths_cos": "key",
    "spectral_centroid_mean": "timbre",
    "spectral_brightness": "timbre",
}


@dataclass
class HandcraftedFeatureSelector:
    """
    Rank handcrafted audio features for a supervised target.

    The selector deliberately excludes metadata/leakage columns such as
    file names, composer labels, piece titles, period, instrument, and segment
    labels. Only numeric audio-derived handcrafted feature columns are used.
    """

    target_col: str = "composer"
    random_state: int = 42
    leakage_cols: set[str] = field(default_factory=lambda: set(DEFAULT_LEAKAGE_COLS))
    feature_groups: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_FEATURE_GROUPS))
    verbose: bool = True

    def run(
        self,
        df_feat: pd.DataFrame,
        ds=None,
        output_suffix: str = "",
        out_prefix: str | None = None,
        save: bool = True,
        top_n: int = 20,
    ) -> tuple[pd.DataFrame, pd.DataFrame]:
        """
        Compute feature rankings and group summary.

        Parameters
        ----------
        df_feat
            Handcrafted feature table, e.g. ``features/handcrafted_features.csv``.
        ds
            Optional ``TVDataset`` instance. Required only when ``save=True``.
        output_suffix
            ``"_test"`` in notebook test mode, otherwise ``""``.
        out_prefix
            Output filename prefix. Defaults to
            ``handcrafted_feature_selection_<target_col>``.
        save
            Save ranking and group summary to ``ds.paths.features``.
        top_n
            Number of top rows to print as a progress/debug preview.
        """
        if out_prefix is None:
            out_prefix = f"handcrafted_feature_selection_{self.target_col}"

        self._log("[1/6] Preparing target and audio feature matrix")
        model_df, feature_cols = self._prepare_model_df(df_feat)
        X = model_df[feature_cols].to_numpy(dtype="float64")
        y_text = model_df[self.target_col].astype(str).to_numpy()

        from sklearn.preprocessing import LabelEncoder, StandardScaler

        encoder = LabelEncoder()
        y = encoder.fit_transform(y_text)
        if len(encoder.classes_) < 2:
            raise ValueError(f"Need at least two {self.target_col} classes.")

        self._log(f"      rows: {len(model_df)}")
        self._log(f"      target classes: {dict(zip(encoder.classes_, np.bincount(y)))}")
        self._log(f"      audio feature columns used: {len(feature_cols)}")
        self._log(f"      excluded leakage columns: {self._excluded_columns(df_feat)}")

        self._log("[2/6] Standardizing feature matrix")
        X_scaled = StandardScaler().fit_transform(X)

        self._log("[3/6] Running ANOVA F-test")
        from sklearn.feature_selection import f_classif, mutual_info_classif

        anova_f, anova_p = f_classif(X_scaled, y)
        anova_f = np.nan_to_num(anova_f, nan=0.0, posinf=0.0, neginf=0.0)
        anova_p = np.nan_to_num(anova_p, nan=1.0, posinf=1.0, neginf=1.0)

        self._log("[4/6] Running mutual information")
        mi = mutual_info_classif(X_scaled, y, random_state=self.random_state)
        mi = np.nan_to_num(mi, nan=0.0, posinf=0.0, neginf=0.0)

        self._log("[5/6] Fitting RandomForest and L1 Logistic models")
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.linear_model import LogisticRegression

        rf = RandomForestClassifier(
            n_estimators=500,
            random_state=self.random_state,
            class_weight="balanced",
            min_samples_leaf=2,
            n_jobs=-1,
        )
        rf.fit(X_scaled, y)

        l1 = LogisticRegression(
            penalty="l1",
            solver="saga",
            class_weight="balanced",
            max_iter=5000,
            random_state=self.random_state,
            n_jobs=-1,
        )
        l1.fit(X_scaled, y)

        self._log("[6/6] Building feature ranking and group summary")
        selection = self._build_selection(
            feature_cols=feature_cols,
            anova_f=anova_f,
            anova_p=anova_p,
            mutual_info=mi,
            rf_importance=rf.feature_importances_,
            l1_abs_coef=np.abs(l1.coef_).mean(axis=0),
        )
        group_summary = self._build_group_summary(selection)

        if save:
            if ds is None:
                raise ValueError("ds is required when save=True.")
            selection_name = f"{out_prefix}{output_suffix}.csv"
            group_name = f"{out_prefix}_groups{output_suffix}.csv"
            selection.to_csv(ds.paths.features / selection_name, index=False)
            group_summary.to_csv(ds.paths.features / group_name, index=False)
            self._log(f"      saved ranking -> {ds.paths.features / selection_name}")
            self._log(f"      saved groups  -> {ds.paths.features / group_name}")

        if top_n:
            preview_cols = [
                "overall_rank",
                "feature",
                "group",
                "mean_rank",
                "anova_f",
                "mutual_info",
                "rf_importance",
                "l1_abs_coef",
            ]
            self._log(f"\nTop {min(top_n, len(selection))} features:")
            self._log(selection[preview_cols].head(top_n).to_string(index=False))

        return selection, group_summary

    def _prepare_model_df(self, df_feat: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
        if self.target_col not in df_feat.columns:
            raise KeyError(f"Target column not found: {self.target_col}")

        feature_cols = self.feature_columns(df_feat)
        if not feature_cols:
            raise ValueError("No numeric handcrafted audio feature columns found.")

        model_df = df_feat[[self.target_col] + feature_cols].copy()
        model_df[feature_cols] = model_df[feature_cols].replace([np.inf, -np.inf], np.nan)
        model_df = model_df.dropna(subset=[self.target_col])
        model_df[feature_cols] = model_df[feature_cols].fillna(
            model_df[feature_cols].median(numeric_only=True)
        )
        return model_df, feature_cols

    def feature_columns(self, df_feat: pd.DataFrame) -> list[str]:
        return [
            col for col in df_feat.columns
            if col not in self.leakage_cols and pd.api.types.is_numeric_dtype(df_feat[col])
        ]

    def _build_selection(
        self,
        feature_cols: Iterable[str],
        anova_f: np.ndarray,
        anova_p: np.ndarray,
        mutual_info: np.ndarray,
        rf_importance: np.ndarray,
        l1_abs_coef: np.ndarray,
    ) -> pd.DataFrame:
        selection = pd.DataFrame({
            "feature": list(feature_cols),
            "group": [self.infer_group(col) for col in feature_cols],
            "anova_f": anova_f,
            "anova_p": anova_p,
            "mutual_info": mutual_info,
            "rf_importance": rf_importance,
            "l1_abs_coef": l1_abs_coef,
        })

        rank_metrics = ["anova_f", "mutual_info", "rf_importance", "l1_abs_coef"]
        for metric in rank_metrics:
            selection[f"rank_{metric}"] = selection[metric].rank(
                ascending=False,
                method="average",
            )
        selection["mean_rank"] = selection[[f"rank_{metric}" for metric in rank_metrics]].mean(axis=1)
        selection = selection.sort_values(["mean_rank", "anova_p"]).reset_index(drop=True)
        selection.insert(0, "overall_rank", np.arange(1, len(selection) + 1))
        return selection

    def _build_group_summary(self, selection: pd.DataFrame) -> pd.DataFrame:
        return (
            selection.assign(top10=selection["overall_rank"] <= 10)
            .groupby("group", as_index=False)
            .agg(
                n_features=("feature", "count"),
                top10_count=("top10", "sum"),
                best_rank=("overall_rank", "min"),
                mean_rank=("overall_rank", "mean"),
                mean_rf_importance=("rf_importance", "mean"),
                mean_mutual_info=("mutual_info", "mean"),
            )
            .sort_values(["top10_count", "best_rank"], ascending=[False, True])
            .reset_index(drop=True)
        )

    def infer_group(self, feature_name: str) -> str:
        if feature_name in self.feature_groups:
            return self.feature_groups[feature_name]
        if feature_name.startswith("mfcc_"):
            return "timbre_mfcc"
        return "other"

    def _excluded_columns(self, df_feat: pd.DataFrame) -> list[str]:
        return sorted(col for col in self.leakage_cols if col in df_feat.columns)

    def _log(self, message: str):
        if self.verbose:
            print(message)
