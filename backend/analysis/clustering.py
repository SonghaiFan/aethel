"""
Clustering utilities for the Theme & Variations project.

Notebook usage
--------------
    from clustering import SegmentClusterer

    clusterer = SegmentClusterer(min_k=3, max_k=10, pca_variance=0.95)
    df_clusters, metrics = clusterer.run(
        X_model=X_model,
        plot_meta=plot_meta,
        ds=ds,
        feature_space=FEATURE_SPACE,
        output_suffix=OUTPUT_SUFFIX,
    )
    clusterer.plot_dendrogram()
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.cluster import AgglomerativeClustering, HDBSCAN, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
from sklearn.metrics import pairwise_distances
from scipy.cluster.hierarchy import dendrogram, linkage


@dataclass
class SegmentClusterer:
    """
    Unsupervised clustering of audio segments.

    Workflow
    --------
    1. PCA: reduce X_model to ``pca_variance`` fraction of explained variance.
    2. K selection: sweep k in [min_k, max_k] and pick the best silhouette
       score — or use a fixed ``clusters`` value to skip the sweep.
    3. KMeans: fit on the PCA-reduced space.
    4. K-Medoids: refine the KMeans partition around real segment medoids.
    5. Ward dendrogram: built on the same PCA space for diagnostic inspection.
    6. HDBSCAN: optional density-island/outlier labels in a compact PCA space.

    Parameters
    ----------
    clusters : int or None
        Fixed number of clusters. Set to None to auto-select via silhouette.
    min_k, max_k : int
        Search range for automatic K selection.
    pca_variance : float
        Fraction of variance to retain in the PCA step (0 < pca_variance <= 1).
    hdbscan_pca_components : int or None
        PCA dimensions used only for HDBSCAN. Density clustering is usually more
        useful in a compact space; set to None to reuse the main PCA matrix.
    kmedoids_max_iter : int
        Maximum assign/update iterations for the in-house K-Medoids refinement.
    random_state : int
        Passed to PCA and KMeans for reproducibility.
    verbose : bool
        Print progress and silhouette scores when True.
    """

    clusters: Optional[int] = None
    min_k: int = 3
    max_k: int = 10
    pca_variance: float = 0.95
    run_hdbscan: bool = True
    hdbscan_min_cluster_size: int = 10
    hdbscan_min_samples: Optional[int] = None
    hdbscan_method: str = "eom"
    hdbscan_pca_components: Optional[int] = 10
    run_hdbscan_subcluster: bool = False
    hdbscan_sub_min_cluster_size: int = 80
    hdbscan_sub_min_samples: Optional[int] = 5
    hdbscan_sub_method: str = "eom"
    kmedoids_max_iter: int = 20
    random_state: int = 42
    verbose: bool = True

    # set after run()
    _X_cluster: Optional[np.ndarray] = field(default=None, init=False, repr=False)
    _pca: Optional[PCA] = field(default=None, init=False, repr=False)
    _linkage_matrix: Optional[np.ndarray] = field(default=None, init=False, repr=False)
    _n_clusters: Optional[int] = field(default=None, init=False, repr=False)
    _feature_space: str = field(default="", init=False, repr=False)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(
        self,
        X_model: np.ndarray,
        plot_meta: pd.DataFrame,
        ds=None,
        feature_space: str = "embedding",
        output_suffix: str = "",
        hdbscan_X: Optional[np.ndarray] = None,
        hdbscan_space_label: Optional[str] = None,
        save: bool = True,
    ) -> tuple[pd.DataFrame, dict]:
        """
        Run the full clustering pipeline.

        Parameters
        ----------
        X_model : np.ndarray, shape (n_samples, n_features)
            Feature matrix — either MERT embeddings or scaled handcrafted features.
        plot_meta : pd.DataFrame
            Metadata rows aligned to X_model (file_name, composer, label, …).
        ds : TVDataset, optional
            Dataset object used to resolve the output path. If None, clusters
            are not saved to disk even when save=True.
        feature_space : str
            Label for the current feature space, used in file names and plot titles.
        output_suffix : str
            Appended to output file names (e.g. "_test").
        hdbscan_X : np.ndarray, optional
            Optional coordinate matrix used only for HDBSCAN. This is useful
            when density clusters should follow an existing 2D/low-D map such
            as UMAP instead of the main PCA clustering space.
        hdbscan_space_label : str, optional
            Human-readable label for hdbscan_X, stored in metrics.
        save : bool
            Whether to write the cluster CSV to ds.paths.embeddings.

        Returns
        -------
        df_clusters : pd.DataFrame
            plot_meta with an added "cluster_km" column.
        metrics : dict
            Silhouette scores, chosen K, PCA details, and file path if saved.
        """
        self._feature_space = feature_space
        n_samples = len(X_model)

        # Step 1 — PCA
        self._pca, X_cluster = self._fit_pca(X_model)
        self._X_cluster = X_cluster

        # Step 2 — K selection
        n_clusters, sil_scores = self._select_k(X_cluster, n_samples)
        self._n_clusters = n_clusters

        # Step 3 — KMeans baseline
        km = KMeans(n_clusters=n_clusters, random_state=self.random_state, n_init="auto")
        km_labels = km.fit_predict(X_cluster)

        # Step 4 — K-Medoids: centers are real segments.
        kmedoids_labels, kmedoid_indices, kmedoids_iter = self._fit_kmedoids(
            X_cluster,
            n_clusters=n_clusters,
            initial_labels=km_labels,
        )

        # Step 5 — Ward hierarchy:
        # - linkage matrix for dendrograms
        # - flat labels at the same K as KMeans for segment-level comparison
        self._linkage_matrix = linkage(X_cluster, method="ward")
        ward = AgglomerativeClustering(n_clusters=n_clusters, linkage="ward")
        ward_labels = ward.fit_predict(X_cluster)

        # Step 6 — HDBSCAN density clusters with outliers/noise.
        # Density clustering is fragile in high-dimensional embedding space, so
        # use a compact PCA view by default while keeping KMeans/Ward on the
        # variance-preserving PCA space.
        hdb_labels = np.full(n_samples, -1, dtype=int)
        hdb_strength = np.zeros(n_samples, dtype=float)
        hdb_sub_labels = np.full(n_samples, -99, dtype=int)
        hdb_sub_strength = np.zeros(n_samples, dtype=float)
        hdb_major_cluster = None
        X_hdbscan = X_cluster
        hdbscan_space_used = "disabled"
        if self.run_hdbscan:
            X_hdbscan, hdbscan_space_used = self._hdbscan_space(
                X_model,
                X_cluster,
                hdbscan_X=hdbscan_X,
                hdbscan_space_label=hdbscan_space_label,
            )
            hdb = HDBSCAN(
                min_cluster_size=self.hdbscan_min_cluster_size,
                min_samples=self.hdbscan_min_samples,
                cluster_selection_method=self.hdbscan_method,
                copy=False,
            )
            hdb_labels = hdb.fit_predict(X_hdbscan)
            hdb_strength = np.asarray(getattr(hdb, "probabilities_", np.zeros(n_samples)), dtype=float)
            if self.run_hdbscan_subcluster:
                hdb_sub_labels, hdb_sub_strength, hdb_major_cluster = self._fit_hdbscan_subcluster(
                    X_hdbscan,
                    hdb_labels,
                )

        # Assemble output dataframe
        df_clusters = plot_meta.reset_index(drop=True).copy()
        df_clusters["cluster_km"] = km_labels
        df_clusters["cluster_kmedoids"] = kmedoids_labels
        df_clusters["cluster_ward"] = ward_labels
        df_clusters["cluster_hdbscan"] = hdb_labels
        df_clusters["hdbscan_is_outlier"] = hdb_labels == -1
        df_clusters["hdbscan_strength"] = np.round(hdb_strength, 6)
        df_clusters["cluster_hdbscan_sub"] = hdb_sub_labels
        df_clusters["hdbscan_sub_is_outlier"] = hdb_sub_labels == -1
        df_clusters["hdbscan_sub_strength"] = np.round(hdb_sub_strength, 6)
        df_clusters["hdbscan_major_cluster"] = (
            "" if hdb_major_cluster is None else int(hdb_major_cluster)
        )
        df_clusters["cluster_hdbscan_nested"] = [
            self._nested_hdbscan_label(parent, sub, hdb_major_cluster)
            for parent, sub in zip(hdb_labels, hdb_sub_labels)
        ]

        segment_ids = self._segment_ids(df_clusters)
        self._add_cluster_context(df_clusters, X_cluster, km_labels, "km", segment_ids)
        self._add_cluster_context(
            df_clusters,
            X_cluster,
            kmedoids_labels,
            "kmedoids",
            segment_ids,
            medoid_indices=kmedoid_indices,
        )
        self._add_cluster_context(df_clusters, X_cluster, ward_labels, "ward", segment_ids)
        self._add_cluster_context(df_clusters, X_hdbscan, hdb_labels, "hdbscan", segment_ids, noise_label=-1)
        self._add_cluster_context(
            df_clusters,
            X_hdbscan,
            hdb_sub_labels,
            "hdbscan_sub",
            segment_ids,
            noise_label=-1,
            ignore_labels={-99},
            zero_size_labels={-99},
        )
        df_clusters["is_outlier"] = df_clusters["hdbscan_is_outlier"]
        df_clusters["cluster_representative"] = df_clusters["cluster_kmedoids_representative_id"]
        df_clusters["cluster_representative_distance"] = df_clusters[
            "cluster_kmedoids_distance_to_representative"
        ]

        # Save
        out_path = None
        if save and ds is not None:
            cluster_name = f"clusters_{feature_space}{output_suffix}.csv"
            out_path = ds.paths.embeddings / cluster_name
            df_clusters.to_csv(out_path, index=False)
            if self.verbose:
                print(f"Saved clusters -> {out_path}")

        metrics = {
            "n_clusters": n_clusters,
            "pca_components": X_cluster.shape[1],
            "pca_explained_variance": float(self._pca.explained_variance_ratio_.sum()),
            "silhouette_scores": sil_scores,
            "cluster_distribution": pd.Series(km_labels).value_counts().sort_index().to_dict(),
            "kmedoids_distribution": pd.Series(kmedoids_labels).value_counts().sort_index().to_dict(),
            "kmedoids_iterations": kmedoids_iter,
            "ward_distribution": pd.Series(ward_labels).value_counts().sort_index().to_dict(),
            "hdbscan_distribution": pd.Series(hdb_labels).value_counts().sort_index().to_dict(),
            "hdbscan_n_clusters": int(len(set(hdb_labels)) - (1 if -1 in hdb_labels else 0)),
            "hdbscan_outliers": int(np.sum(hdb_labels == -1)),
            "hdbscan_min_cluster_size": self.hdbscan_min_cluster_size,
            "hdbscan_min_samples": self.hdbscan_min_samples,
            "hdbscan_pca_components": self.hdbscan_pca_components,
            "hdbscan_space": hdbscan_space_used,
            "hdbscan_sub_enabled": self.run_hdbscan_subcluster,
            "hdbscan_sub_parent_cluster": hdb_major_cluster,
            "hdbscan_sub_distribution": pd.Series(hdb_sub_labels)
            .value_counts()
            .sort_index()
            .to_dict(),
            "hdbscan_sub_min_cluster_size": self.hdbscan_sub_min_cluster_size,
            "hdbscan_sub_min_samples": self.hdbscan_sub_min_samples,
            "out_path": str(out_path) if out_path else None,
        }

        if self.verbose:
            dist = pd.Series(km_labels).value_counts().sort_index()
            print(f"\nKMeans cluster distribution (K={n_clusters}):")
            print(dist.to_string())
            ward_dist = pd.Series(ward_labels).value_counts().sort_index()
            kmedoids_dist = pd.Series(kmedoids_labels).value_counts().sort_index()
            print(f"\nK-Medoids cluster distribution (K={n_clusters}):")
            print(kmedoids_dist.to_string())
            print(f"\nWard flat cluster distribution (K={n_clusters}):")
            print(ward_dist.to_string())
            hdb_dist = pd.Series(hdb_labels).value_counts().sort_index()
            print("\nHDBSCAN cluster distribution (-1 = outlier):")
            print(hdb_dist.to_string())
            if self.run_hdbscan_subcluster:
                hdb_sub_dist = pd.Series(hdb_sub_labels).value_counts().sort_index()
                print(
                    f"\nNested HDBSCAN subclusters inside parent {hdb_major_cluster} "
                    "(-99 = not parent, -1 = sub-outlier):"
                )
                print(hdb_sub_dist.to_string())

        return df_clusters, metrics

    def plot_dendrogram(
        self,
        figsize: tuple[int, int] = (12, 4),
        ax: Optional[plt.Axes] = None,
    ) -> plt.Figure:
        """
        Draw the Ward dendrogram built during the last run() call.

        Parameters
        ----------
        figsize : tuple
            Figure size, used only when ax is None.
        ax : matplotlib Axes, optional
            Draw into this axes instead of creating a new figure.

        Returns
        -------
        fig : matplotlib Figure
        """
        if self._linkage_matrix is None:
            raise RuntimeError("Call run() before plot_dendrogram().")

        if ax is None:
            fig, ax = plt.subplots(figsize=figsize)
        else:
            fig = ax.get_figure()

        n_samples = self._X_cluster.shape[0]
        dendrogram(
            self._linkage_matrix,
            ax=ax,
            no_labels=True,
            truncate_mode="lastp",
            p=min(30, n_samples),
        )
        ax.set_title(
            f"Hierarchical Clustering (Ward) — {self._feature_space}"
            f"  [K={self._n_clusters} selected]"
        )
        plt.tight_layout()
        return fig

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _fit_pca(self, X_model: np.ndarray) -> tuple[PCA, np.ndarray]:
        pca = PCA(n_components=self.pca_variance, random_state=self.random_state)
        X_cluster = pca.fit_transform(X_model)
        if self.verbose:
            print(
                f"[1/3] PCA: {X_model.shape[1]}D -> {X_cluster.shape[1]}D "
                f"(explained variance: {pca.explained_variance_ratio_.sum():.3f})"
            )
        return pca, X_cluster

    def _hdbscan_space(
        self,
        X_model: np.ndarray,
        X_cluster: np.ndarray,
        hdbscan_X: Optional[np.ndarray] = None,
        hdbscan_space_label: Optional[str] = None,
    ) -> tuple[np.ndarray, str]:
        if hdbscan_X is not None:
            X_density = np.asarray(hdbscan_X)
            if len(X_density) != len(X_model):
                raise ValueError(
                    "hdbscan_X must have the same number of rows as X_model "
                    f"({len(X_density)} != {len(X_model)})."
                )
            label = hdbscan_space_label or f"custom_{X_density.shape[1]}d"
            if self.verbose:
                print(f"[3/3] HDBSCAN density space: {label} ({X_density.shape[1]}D)")
            return X_density, label

        if self.hdbscan_pca_components is None:
            return X_cluster, "main_pca"

        n_components = min(self.hdbscan_pca_components, X_model.shape[0] - 1, X_model.shape[1])
        if n_components <= 0:
            return X_cluster, "main_pca"

        pca = PCA(n_components=n_components, random_state=self.random_state)
        X_density = pca.fit_transform(X_model)
        if self.verbose:
            print(
                f"[3/3] HDBSCAN density space: {X_model.shape[1]}D -> "
                f"{X_density.shape[1]}D PCA"
            )
        return X_density, f"pca{X_density.shape[1]}"

    def _select_k(
        self, X_cluster: np.ndarray, n_samples: int
    ) -> tuple[int, dict[int, float]]:
        max_k = min(self.max_k, n_samples - 1)
        min_k = min(self.min_k, max_k)

        if self.clusters is not None:
            if self.verbose:
                print(f"[2/3] K fixed by user: {self.clusters}")
            return self.clusters, {}

        if self.verbose:
            print(f"[2/3] Silhouette sweep k={min_k}..{max_k}")

        scores: dict[int, float] = {}
        for k in range(min_k, max_k + 1):
            km_tmp = KMeans(n_clusters=k, random_state=self.random_state, n_init="auto")
            lbl_tmp = km_tmp.fit_predict(X_cluster)
            scores[k] = silhouette_score(X_cluster, lbl_tmp)

        best_k = max(scores, key=scores.get)

        if self.verbose:
            for k, s in scores.items():
                marker = " <-- best" if k == best_k else ""
                print(f"      k={k}: {s:.4f}{marker}")

        return best_k, scores

    def _fit_kmedoids(
        self,
        X_cluster: np.ndarray,
        n_clusters: int,
        initial_labels: np.ndarray,
    ) -> tuple[np.ndarray, dict[int, int], int]:
        labels = np.asarray(initial_labels, dtype=int).copy()
        medoid_indices = self._medoids_from_labels(X_cluster, labels, n_clusters)

        for iteration in range(1, self.kmedoids_max_iter + 1):
            previous = labels.copy()
            medoid_matrix = np.vstack([X_cluster[medoid_indices[k]] for k in range(n_clusters)])
            labels = pairwise_distances(X_cluster, medoid_matrix).argmin(axis=1).astype(int)
            medoid_indices = self._medoids_from_labels(X_cluster, labels, n_clusters)

            if np.array_equal(labels, previous):
                return labels, medoid_indices, iteration

        return labels, medoid_indices, self.kmedoids_max_iter

    def _fit_hdbscan_subcluster(
        self,
        X_hdbscan: np.ndarray,
        hdb_labels: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, Optional[int]]:
        cluster_counts = (
            pd.Series(hdb_labels)
            .loc[lambda s: s != -1]
            .value_counts()
            .sort_values(ascending=False)
        )
        if cluster_counts.empty:
            return (
                np.full(len(hdb_labels), -99, dtype=int),
                np.zeros(len(hdb_labels), dtype=float),
                None,
            )

        parent_label = int(cluster_counts.index[0])
        parent_idx = np.flatnonzero(hdb_labels == parent_label)
        sub = HDBSCAN(
            min_cluster_size=self.hdbscan_sub_min_cluster_size,
            min_samples=self.hdbscan_sub_min_samples,
            cluster_selection_method=self.hdbscan_sub_method,
            copy=False,
        )
        sub_labels_local = sub.fit_predict(X_hdbscan[parent_idx])
        sub_strength_local = np.asarray(
            getattr(sub, "probabilities_", np.zeros(len(parent_idx))),
            dtype=float,
        )

        sub_labels = np.full(len(hdb_labels), -99, dtype=int)
        sub_strength = np.zeros(len(hdb_labels), dtype=float)
        sub_labels[parent_idx] = sub_labels_local
        sub_strength[parent_idx] = sub_strength_local
        return sub_labels, sub_strength, parent_label

    @staticmethod
    def _nested_hdbscan_label(parent_label: int, sub_label: int, major_cluster: Optional[int]) -> str:
        parent_label = int(parent_label)
        sub_label = int(sub_label)
        if parent_label == -1:
            return "noise"
        if major_cluster is None or parent_label != int(major_cluster):
            return f"{parent_label}"
        if sub_label == -1:
            return f"{parent_label}.noise"
        return f"{parent_label}.{sub_label}"

    def _medoids_from_labels(
        self,
        X_cluster: np.ndarray,
        labels: np.ndarray,
        n_clusters: int,
    ) -> dict[int, int]:
        medoid_indices: dict[int, int] = {}
        for label in range(n_clusters):
            idx = np.flatnonzero(labels == label)
            if len(idx) == 0:
                medoid_indices[label] = self._fallback_medoid_index(X_cluster, medoid_indices)
                continue

            distances = pairwise_distances(X_cluster[idx], X_cluster[idx])
            costs = distances.sum(axis=1)
            medoid_indices[label] = int(idx[int(np.argmin(costs))])
        return medoid_indices

    def _fallback_medoid_index(
        self,
        X_cluster: np.ndarray,
        existing_medoids: dict[int, int],
    ) -> int:
        if not existing_medoids:
            rng = np.random.default_rng(self.random_state)
            return int(rng.integers(0, X_cluster.shape[0]))

        medoid_matrix = X_cluster[list(existing_medoids.values())]
        nearest_existing = pairwise_distances(X_cluster, medoid_matrix).min(axis=1)
        return int(np.argmax(nearest_existing))

    @staticmethod
    def _segment_ids(df: pd.DataFrame) -> pd.Series:
        if {"file_name", "label"}.issubset(df.columns):
            return df["file_name"].astype(str) + "__" + df["label"].astype(str)
        return pd.Series([f"segment_{i}" for i in range(len(df))], index=df.index)

    @staticmethod
    def _cluster_counts(labels: np.ndarray) -> dict[int, int]:
        return pd.Series(labels).value_counts().sort_index().astype(int).to_dict()

    def _add_cluster_context(
        self,
        df_clusters: pd.DataFrame,
        X_cluster: np.ndarray,
        labels: np.ndarray,
        prefix: str,
        segment_ids: pd.Series,
        noise_label: int | None = None,
        medoid_indices: dict[int, int] | None = None,
        ignore_labels: set[int] | None = None,
        zero_size_labels: set[int] | None = None,
    ) -> None:
        """Add representative real segment and distance columns for one method."""
        labels = np.asarray(labels)
        counts = self._cluster_counts(labels)
        rep_ids: dict[int, str] = {}
        rep_indices: dict[int, int] = {}
        ignore_labels = ignore_labels or set()
        zero_size_labels = zero_size_labels or set()

        for label in sorted(counts):
            if noise_label is not None and label == noise_label:
                continue
            if int(label) in ignore_labels:
                continue
            idx = np.flatnonzero(labels == label)
            if len(idx) == 0:
                continue
            if medoid_indices is not None and int(label) in medoid_indices:
                rep_index = int(medoid_indices[int(label)])
            else:
                centroid = X_cluster[idx].mean(axis=0, keepdims=True)
                distances = pairwise_distances(X_cluster[idx], centroid).ravel()
                local_rep = int(np.argmin(distances))
                rep_index = int(idx[local_rep])
            rep_indices[int(label)] = rep_index
            rep_ids[int(label)] = str(segment_ids.iloc[rep_index])

        size_col = f"cluster_{prefix}_size"
        rep_col = f"cluster_{prefix}_representative_id"
        dist_col = f"cluster_{prefix}_distance_to_representative"

        df_clusters[size_col] = [
            0 if int(label) in zero_size_labels else counts.get(int(label), 0)
            for label in labels
        ]
        df_clusters[rep_col] = [
            "" if (noise_label is not None and int(label) == noise_label) or int(label) in ignore_labels
            else rep_ids.get(int(label), "")
            for label in labels
        ]

        distances_to_rep = []
        for i, label in enumerate(labels):
            label = int(label)
            rep_index = rep_indices.get(label)
            if rep_index is None:
                distances_to_rep.append(np.nan)
                continue
            dist = np.linalg.norm(X_cluster[i] - X_cluster[rep_index])
            distances_to_rep.append(round(float(dist), 6))
        df_clusters[dist_col] = distances_to_rep
