"""
Dimensionality reduction utilities for the Theme & Variations project.

Notebook usage
--------------
    from reduction import SegmentReducer

    reducer = SegmentReducer(feature_space="embedding")
    X_model, plot_meta = reducer.prepare(
        emb_matrix=emb_matrix,
        df_emb_meta=df_emb_meta,
        df_feat=df_feat,        # only needed for feature_space="handcrafted"
    )
    df_reduction = reducer.run(
        X_model=X_model,
        plot_meta=plot_meta,
        ds=ds,
        output_suffix=OUTPUT_SUFFIX,
        save=True,
    )
    reducer.plot(df_reduction)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.preprocessing import StandardScaler

try:
    import umap as umap_lib
    _UMAP_AVAILABLE = True
except ImportError:
    _UMAP_AVAILABLE = False


META_COLS = {
    "file_name", "composer", "piece", "period",
    "instrument", "label", "embedding_path", "pooling",
}

COMPOSER_COLORS = {
    "Ludwig van Beethoven": "#4C78A8",
    "Wolfgang Amadeus Mozart": "#F58518",
    "Joseph Haydn": "#54A24B",
}


@dataclass
class SegmentReducer:
    """
    Prepare a feature matrix and run 2-D dimensionality reduction (PCA,
    UMAP, t-SNE) for visualisation of audio segments.

    Parameters
    ----------
    feature_space : {"embedding", "handcrafted"}
        Which feature source to use.
    umap_neighbors : int or None
        Number of neighbours for UMAP. None = auto (min(15, n-1)).
    tsne_perplexity : float or None
        t-SNE perplexity. None = auto (min(30, (n-1)//3)).
    random_state : int
        Passed to PCA, UMAP, and t-SNE.
    verbose : bool
        Print progress when True.
    """

    feature_space: str = "embedding"
    umap_neighbors: Optional[int] = None
    tsne_perplexity: Optional[float] = None
    random_state: int = 42
    verbose: bool = True

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def prepare(
        self,
        emb_matrix: np.ndarray,
        df_emb_meta: pd.DataFrame,
        df_feat: Optional[pd.DataFrame] = None,
    ) -> tuple[np.ndarray, pd.DataFrame]:
        """
        Build X_model and plot_meta from raw inputs.

        For feature_space="embedding": X_model is the raw MERT embedding matrix.
        For feature_space="handcrafted": X_model is the StandardScaler-normalized
        handcrafted feature matrix, aligned to df_emb_meta row order.

        Returns
        -------
        X_model : np.ndarray, shape (n_samples, n_features)
        plot_meta : pd.DataFrame, shape (n_samples, ...)
        """
        plot_meta = df_emb_meta.reset_index(drop=True).copy()

        if self.feature_space == "handcrafted":
            if df_feat is None:
                raise ValueError("df_feat is required for feature_space='handcrafted'")
            X_model = self._build_handcrafted_matrix(df_feat, plot_meta)
        else:
            X_model = emb_matrix.astype("float32")

        if self.verbose:
            print(f"Feature space : {self.feature_space}")
            print(f"Input matrix  : {X_model.shape}")

        return X_model, plot_meta

    def run(
        self,
        X_model: np.ndarray,
        plot_meta: pd.DataFrame,
        ds=None,
        output_suffix: str = "",
        save: bool = True,
    ) -> pd.DataFrame:
        """
        Run PCA, UMAP, and t-SNE; return a DataFrame with 2-D coordinates.

        Parameters
        ----------
        X_model : np.ndarray
            Feature matrix from prepare().
        plot_meta : pd.DataFrame
            Metadata aligned to X_model rows.
        ds : TVDataset, optional
            Used to resolve the save path. Ignored when save=False.
        output_suffix : str
            Appended to the output file name (e.g. "_test").
        save : bool
            Write the reduction CSV to ds.paths.embeddings.

        Returns
        -------
        df_reduction : pd.DataFrame
            plot_meta with added columns: pca_x, pca_y, umap_x, umap_y,
            tsne_x, tsne_y.
        """
        n_samples = len(X_model)
        if n_samples < 3:
            raise ValueError(f"Need at least 3 segments, got {n_samples}.")

        reductions: list[tuple[str, np.ndarray]] = []

        # PCA
        if self.verbose:
            print("[1/3] PCA")
        X_pca = PCA(n_components=2, random_state=self.random_state).fit_transform(X_model)
        reductions.append(("pca", X_pca))

        # UMAP
        if _UMAP_AVAILABLE:
            neighbors = self.umap_neighbors or min(15, n_samples - 1)
            if self.verbose:
                print(f"[2/3] UMAP  (n_neighbors={neighbors})")
            X_umap = umap_lib.UMAP(
                n_components=2,
                n_neighbors=neighbors,
                random_state=self.random_state,
            ).fit_transform(X_model)
            reductions.append(("umap", X_umap))
        else:
            if self.verbose:
                print("[2/3] UMAP  skipped (umap-learn not installed)")

        # t-SNE
        perplexity = self.tsne_perplexity or min(30.0, max(2.0, (n_samples - 1) / 3))
        if self.verbose:
            print(f"[3/3] t-SNE (perplexity={perplexity:.1f})")
        X_tsne = TSNE(
            n_components=2,
            perplexity=perplexity,
            random_state=self.random_state,
        ).fit_transform(X_model)
        reductions.append(("tsne", X_tsne))

        # Assemble
        df_reduction = plot_meta.copy()
        for name, X in reductions:
            df_reduction[f"{name}_x"] = X[:, 0]
            df_reduction[f"{name}_y"] = X[:, 1]

        if save and ds is not None:
            out = ds.paths.embeddings / f"reduction_{self.feature_space}{output_suffix}.csv"
            df_reduction.to_csv(out, index=False)
            if self.verbose:
                print(f"Saved reduction -> {out}")

        return df_reduction

    def plot(
        self,
        df_reduction: pd.DataFrame,
        color_col: str = "composer",
        color_map: Optional[dict[str, str]] = None,
        figsize: tuple[int, int] = (18, 5),
    ) -> plt.Figure:
        """
        Scatter plot of all available 2-D projections, coloured by color_col.

        Parameters
        ----------
        df_reduction : pd.DataFrame
            Output of run().
        color_col : str
            Column used to colour points.
        color_map : dict, optional
            Mapping from color_col values to hex colours.
            Defaults to COMPOSER_COLORS.
        figsize : tuple
            Figure size.
        """
        cmap = color_map or COMPOSER_COLORS
        colors = [cmap.get(v, "#8A8A8A") for v in df_reduction[color_col]]

        available = [p for p in ["pca", "umap", "tsne"] if f"{p}_x" in df_reduction.columns]
        fig, axes = plt.subplots(1, len(available), figsize=figsize)
        if len(available) == 1:
            axes = [axes]

        for ax, prefix in zip(axes, available):
            ax.scatter(
                df_reduction[f"{prefix}_x"],
                df_reduction[f"{prefix}_y"],
                c=colors, alpha=0.75, s=28,
            )
            ax.set_title(f"{prefix.upper()} — {self.feature_space}")
            ax.set_xlabel("dim 1")
            ax.set_ylabel("dim 2")

        present = set(df_reduction[color_col])
        handles = [
            plt.Line2D([0], [0], marker="o", color="w", label=k,
                       markerfacecolor=v, markersize=8)
            for k, v in cmap.items() if k in present
        ]
        if handles:
            fig.legend(handles=handles, loc="upper center",
                       ncol=len(handles), frameon=False)

        plt.tight_layout(rect=[0, 0, 1, 0.92])
        return fig

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_handcrafted_matrix(
        self, df_feat: pd.DataFrame, plot_meta: pd.DataFrame
    ) -> np.ndarray:
        meta_keys = plot_meta[["file_name", "label"]].copy()
        df_model = meta_keys.merge(df_feat, on=["file_name", "label"], how="left")

        if df_model.isna().any(axis=None):
            missing = df_model[df_model.isna().any(axis=1)][["file_name", "label"]]
            raise ValueError(
                f"Missing handcrafted rows for {len(missing)} segments:\n{missing}"
            )

        feat_cols = [
            c for c in df_model.columns
            if c not in META_COLS and pd.api.types.is_numeric_dtype(df_model[c])
        ]
        return StandardScaler().fit_transform(df_model[feat_cols])
