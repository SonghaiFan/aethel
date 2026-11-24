# AGENTS.md — Project Context & Working Conventions

> 这份文档供 AI agent 在每次会话开始时阅读，快速理解项目背景、当前状态和工作规范。
> **每次对项目做出实质性推进后，必须同步更新 `PROJECT_PROGRESS.md` 并 git commit。**

---

## 1. 项目背景与目标

**项目名称：** Aethel（Music Theme & Variations）

**核心目标：**
构建一个基于 audio embedding 与 interpretable handcrafted feature 的音乐可视化系统，用"视觉缩略图（music thumbnails）"表达 Theme & Variations 的音乐结构与相似性。

**核心研究问题：**
1. 是否能仅通过可视化理解 variation 的音乐特征？
2. 听起来相似的 variation 是否也会视觉相似？
3. embedding similarity 能否通过可解释特征进行解释？
4. visualization 能否揭示仅靠听觉或乐谱阅读不容易发现的模式？

**潜在论文方向：**
- Option A：Music Visualization（视觉编码 + thumbnail 设计 + 解读）
- Option B：Explainable Music Embedding Visualization（embedding + 可解释性 + 相似性解读）
- Option C：Cross-Modal Music Understanding（乐谱 / 音频 / embedding / visualization / LLM 多模态融合）

---

## 2. 数据集

### 核心文件
| 文件 | 说明 |
|------|------|
| `data/TV_annotation_clean.csv` | **主数据文件**，692 条，所有后续步骤统一使用此文件 |
| `data/TV_annotation.csv` | 原始标注文件，仅留作参考，不再修改 |
| `audio/` | 音频目录（gitignore），含整首 WAV 和按结构段切分的片段 |
| `notebooks/data.ipynb` | Phase 1 数据清洗与异常排查 notebook（已完成，参考用） |

### 数据结构（`TV_annotation_clean.csv`）
| 字段 | 说明 |
|------|------|
| `folder` | 作曲家\_作品编号 |
| `file_name (folderName_number)` | 唯一标识符，格式如 `LBeethoven_WOO63_1` |
| `length` | 音频时长，MM.SS 格式（如 11.54 = 11分54秒） |
| `music_name` | 曲目名称 |
| `composer` | 作曲家 |
| `period` | 时期（Classical / Romantic / Modern） |
| `boundary` | 结构边界时间戳，分号分隔，MM.SS 格式 |
| `label` | 结构标签，分号分隔，如 `T; V1; V2; ...` |
| `link` | YouTube 链接 |
| `variation_num` | 变奏数量 |
| `instrument` | 演奏乐器 |
| `applause_begin` / `appluse_end` | 是否有掌声 |
| `note` | 备注 |

### 数据概况
- **总记录：** 692 条（删除 21 条 boundary 异常记录后）
- **时期分布：** Classical 377 / Romantic 279 / Modern 36
- **主要乐器：** piano 461 / piano-4hand 61 / Guitar 40
- **音频规格：** 22050 Hz，单声道，WAV 格式
- **音频路径规则：**
  - 整首：`audio/<folder>/<fname>.wav`
  - 片段：`audio/<folder>/<fname>/<label>.wav`
- **boundary 格式：** MM.SS float，`mmss_to_sec(1.54) = 114.0s`（非小数分钟）

### 标签规范
- **核心段落（core）：** `T`（主题）、`V1`、`V2` ... `Vn`（编号变奏）→ 特征提取与 embedding 的主要对象
- **附加结构（extra）：** `I`（Introduction）、`C`（Coda）、`Inter`（Interlude）、`B`（Bridge）→ 已全部切出 WAV，explorer 可播放
- **全部 7499 个唯一片段已验证存在（0 缺失）**

---

## 3. 代码架构

### 核心库：`tv_core.py`
所有复杂逻辑封装在此，notebook 只调用 API。

| 类 | 职责 |
|----|------|
| `Paths` | 项目路径常量（audio/features/embeddings/csv） |
| `TVDataset` | 加载 CSV、子集筛选（`mbh_piano()`/`filter()`）、标签解析、segment 迭代器 |
| `Handcrafted` | `extract_one(wav)` + `extract_batch(df, ds)` → 35维 handcrafted features |
| `MERTEmbedder` | 懒加载 MERT-v1-330M，`extract_one(wav)` + `extract_batch(df, ds)`，断点续传 |
| `Similarity` | 余弦相似度矩阵、`within_piece()`、`top_similar()` |

**典型调用（notebook 里）：**
```python
from tv_core import TVDataset, Handcrafted, MERTEmbedder, Similarity

ds            = TVDataset()
df_mbh        = ds.mbh_piano()                        # 277 条 MBH piano 子集
df_feat       = Handcrafted().extract_batch(df_mbh, ds)     # → features/handcrafted_features.csv
emb, meta     = MERTEmbedder().extract_batch(df_mbh, ds)    # → embeddings/embeddings.npy
sim           = Similarity(emb, meta)
```

### 项目结构（2026-05-13 重构后）

```
music_topic/
├── tv_core.py                  ← 核心库（保留在根目录，所有脚本 import 它）
├── data/                       ← 所有 CSV 标注文件
│   ├── TV_annotation_clean.csv     主数据文件（692 条）
│   ├── TV_annotation.csv           原始文件（参考用）
│   └── TV_annotation_clean_test.csv
├── backend/
│   ├── pipeline/               ← 顺序执行的数据处理脚本
│   │   ├── cut_segments.py
│   │   ├── extract_handcrafted.py
│   │   ├── run_phase2_2_mert.py
│   │   ├── fix_bad_wavs.py
│   │   └── import_archive_mert_embeddings.py
│   ├── analysis/               ← 可复用分析工具（被 notebook import）
│   │   ├── feature_selection.py
│   │   ├── reduction.py
│   │   ├── clustering.py
│   │   └── visualization.py
│   └── export/                 ← 生成 explorer_app 数据文件的脚本
│       ├── export_explorer_data.py
│       └── export_waveform_thumbnail_data.py
├── notebooks/                  ← Jupyter notebooks（必须从项目根目录运行）
│   ├── pipeline.ipynb              项目主 pipeline，Phase 0–4
│   └── data.ipynb                  Phase 1 数据清洗（参考用）
└── explorer_app/               ← React/Vite 前端
    └── src/data/                   由 export/ 脚本生成的前端数据
```

**重要：notebook 必须从项目根目录打开/运行**，每个 notebook 第一个 cell 会自动修正 cwd 和 sys.path。

### 主要模块说明
| 文件 | 说明 |
|------|------|
| `tv_core.py` | 项目核心库（见上） |
| `backend/analysis/feature_selection.py` | `HandcraftedFeatureSelector`：ANOVA / MI / RF / L1 多方法特征排名 |
| `backend/analysis/reduction.py` | `SegmentReducer`：feature matrix 构建 + PCA / UMAP / t-SNE 降维可视化 |
| `backend/analysis/clustering.py` | `SegmentClusterer`：PCA 预处理 → silhouette 自动选 K → KMeans + Ward 树状图 |
| `backend/analysis/visualization.py` | `MusicThumbnailRenderer`：radial waveform thumbnail 生成与渲染 |
| `backend/pipeline/cut_segments.py` | 从整首 WAV 切出所有片段（含 I/C/Inter/B），跳过 SKIP 列表 |
| `backend/pipeline/fix_bad_wavs.py` | 重新从 YouTube 下载并修复两条源 WAV 有误的记录 |
| `backend/export/export_explorer_data.py` | 独立脚本：从磁盘加载 pipeline 输出，调用 `FrontendExporter` 生成前端数据。需要重新生成但不想重跑 pipeline 时使用。 |
| `backend/export/export_waveform_thumbnail_data.py` | ⚠️ 已废弃，逻辑已并入 `FrontendExporter`。 |

### 前端数据生成流程（Phase 5）

**推荐方式：** 在 `notebooks/pipeline.ipynb` 末尾运行 Phase 5 cell（直接使用内存变量，无需重新读盘）。

**备用方式（单独重新生成）：**
```bash
cd /Users/songhaifan/Developer/frank/aethel
python backend/export/export_explorer_data.py             # 完整数据
python backend/export/export_explorer_data.py --suffix _test  # test 子集
```

两种方式产出相同的两个文件：
- `explorer_app/src/data/segment_visualization{suffix}.csv`
- `explorer_app/src/data/waveform_thumbnails{suffix}.json`

### 输出文件（gitignore，运行后生成）
| 文件 | 说明 |
|------|------|
| `features/handcrafted_features.csv` | Phase 2.1 输出 |
| `embeddings/embeddings.npy` | Phase 2.2 输出，(N, 1024) float32 |
| `embeddings/embedding_meta.csv` | Phase 2.2 元数据 |
| `embeddings/cosine_similarity.npy` | Phase 3 输出 |

---

## 4. 研究计划（Phase 概览）

```
Phase 1  Dataset Construction      ✅ 完成
Phase 2  Feature Extraction        🔄 进行中（2.1 完成，2.2 后台运行）
Phase 3  Similarity Analysis       🔲 待做
Phase 4  Visualization Design      🔲 待做
Phase 5  Interpretation & Insight  🔲 待做
Phase 6  Comparative（score+LLM）  🔲 待做
Phase 7  Evaluation                🔲 待做
```

### Phase 2 — Feature Extraction（当前阶段）

**2.1 Handcrafted Features**（核心段落 T/V1..Vn，约 43 维）

状态：已完成，输出 `features/handcrafted_features.csv`（3187 行，覆盖 MBH piano core 全部 segment）。

| 维度 | 特征 |
|------|------|
| Pitch | mean_pitch, pitch_range, pitch_variance, contour_changes, upward_ratio, leap_ratio |
| Rhythm | onset_density, tempo_stability, note_density, rhythmic_variance |
| Dynamics | rms_mean, rms_variance |
| Harmony | chroma_entropy, tonal_centroid, harmonic_stability |
| Timbre | spectral_centroid_mean, spectral_brightness, mfcc_mean×13, mfcc_var×13 |

**2.2 Deep Audio Embedding**
- 模型：MERT-v1-330M（1024-D，archive-compatible `all_layers_mean` pooling）
- 输入 SR：24000 Hz（librosa 从 22050 Hz 自动重采样）
- 断点续传：每段保存到 `embeddings/mert_embeddings/<folder>/<file_name>/<label>.npy`，并周期性刷新 `embeddings/embeddings.npy` 与 `embeddings/embedding_meta.csv`
- 对象：MBH piano 子集（277 条，3187 个 core 段），可切换为全量
- 当前状态：后台 `screen` 会话 `mert_phase2_2` 运行中，使用 `MERT_DEVICE=cpu` 与 `TORCH_NUM_THREADS=8` 补齐长片段；查看日志：`tail -f logs/phase2_2_mert_cpu_remaining.log`

### Phase 3 — Similarity Analysis
- Pairwise cosine similarity → `Similarity` 类
- Dimensionality reduction（PCA / UMAP / t-SNE）
- Clustering（KMeans / hierarchical）

### Phase 4 — Visualization Design
- Music thumbnail：每个 variation 一张紧凑、可比较的视觉缩略图
- 视觉编码：loudness→size，rhythm→opacity，pitch contour→line，timbre→color，harmony→shape，similarity→spatial distance
- 多视图：Thumbnail Gallery / Similarity Map / Explanation Panel

---

## 5. 工作规范

### Agent 行为规范
- **每次会话开始**：先读 `AGENTS.md` 和 `PROJECT_PROGRESS.md` 最新几条，了解当前状态
- **每次实质性推进后**：更新 `PROJECT_PROGRESS.md` + git commit
- **数据操作前**：确认操作对象是 `TV_annotation_clean.csv`，不修改原始文件
- **复杂逻辑**：写入 `tv_core.py`，notebook 只调用 API
- **不确定的决策**：先列出选项，询问用户后再执行
- **matplotlib**：不在 title / axis label 中使用中文

### 多 Agent 协作规范（Codex 对齐）
本项目同时使用 **Cowork agent**（本 agent）和 **Codex** 协作开发。
两者通过 `PROJECT_PROGRESS.md` 和 git 共享状态，规则如下：

1. **`PROJECT_PROGRESS.md` 是唯一的进度同步源**
   - 每次任何 agent 或用户完成实质性工作，必须立即在末尾追加一条记录
   - 每次会话开始前，必须读取最新几条记录，了解另一方已做了什么，避免重复或冲突

2. **每次推进后立即 git commit**
   - commit message 清晰描述变更，格式：`feat/fix/chore: 简要描述`
   - 这是 Codex 感知进度的唯一方式，必须及时提交，不能积压
   - 如 sandbox 不可用，在回复末尾给出完整 git 命令供用户在终端执行

3. **分工边界**
   - **Cowork agent**：数据处理、脚本编写、音频切分、explorer.html、文档维护、进度记录
   - **Codex**：复杂算法实现、代码 review、notebook 代码优化
   - 修改对方负责的文件前，先在 `PROJECT_PROGRESS.md` 中说明意图

4. **冲突避免**
   - 开始工作前先确认已是最新 git 状态
   - 不同时编辑同一文件；如有冲突以 git history 为准，手动 merge 后重新 commit

### Git 规范
- 每次推进后立即 commit，message 格式：`feat/fix/chore: 简要描述`
- 如 sandbox 不可用，在回复末尾给出完整 git 命令供用户在终端运行

### Git / Deploy 大文件防护
- 当前约定只保留两个分支概念：
  - **local:** `main` — 本地研究/数据处理工作区，可包含本地 `audio/`、`features/`、`embeddings/` 文件，但不要直接 push 到 deploy remote。
  - **remote:** `github_cloud/deploy` — GitHub/Vercel 轻量发布分支，不含 `audio/`、`features/`、`embeddings/` tracked files。
- **绝对不要从含 `audio/` 历史的本地分支直接 push 到 GitHub。**
  - 历史事故：旧本地 `codex/frontend-youtube-deploy` 分支曾包含 8423 个 `audio/` WAV tracked files；该本地分支已删除，但本地 `main` 的历史 pack 仍很大。
  - 症状：`git push` 显示 `Writing objects` 几百 MB / 数 GB，或对象数上万，例如 `Writing objects: 3% ... 559 MiB`。
  - 原因：`.gitignore` 只能阻止新文件进入 git，不能移除已经在 branch history 里的大文件；即使当前 diff 只改前端文件，push 新分支也会上传该分支独有历史中的 audio blobs。
- **部署/推送前必须检查：**
  ```bash
  git ls-files audio | wc -l          # 必须为 0
  git count-objects -vH               # pack 不应异常巨大
  git status --short --branch
  ```
- **正确发布方式：从远端干净分支创建 worktree，再 cherry-pick 小提交。**
  ```bash
  cd /Users/songhaifan/Developer/frank/aethel
  git fetch github_cloud
  git worktree add /tmp/music-topic-deploy-clean github_cloud/deploy
  cd /tmp/music-topic-deploy-clean
  git cherry-pick <needed-small-commit>
  git push github_cloud HEAD:deploy
  ```
- **不要用 `git checkout` 在当前含本地 audio 数据的工作树里切 deploy clean branch。**
  - 使用 `git worktree` 是为了避免本地 `audio/` 数据与干净分支互相干扰。
- `audio/`、`features/`、`embeddings/` 只允许作为本地/生成数据存在，不应被 commit；如发现已 tracked，先停下并向用户说明，不能继续 push。

### 数据使用原则
- **永远使用 `TV_annotation_clean.csv`**，不修改原始文件
- `chord` 只保留在原始 `TV_annotation.csv` 中作为 legacy 参考，不进入 clean 主表；key-related features 统一由音频计算得到
- 删除策略：有问题的样本直接删除，不强行修补
- `audio/`、`features/`、`embeddings/` 均在 `.gitignore` 中，不进入 git

### 进度记录格式
```md
### YYYY-MM-DD HH:MM

- 本步目标：
- 实际操作：
- 结果产出：
- 遇到的问题：
- 下一步：
```

---

## 6. 当前状态（最后更新：2026-05-13）

| 阶段 | 状态 |
|------|------|
| Phase 1 Dataset Construction | ✅ 完成 |
| Phase 1.1 MBH piano 子集确认 | ✅ 完成（277 条） |
| Phase 1.5 音频片段切分（含 I/C/Inter/B） | ✅ 完成（7499 段，0 缺失） |
| Phase 2.1 Handcrafted Feature Extraction | ✅ 完成（3187 行） |
| Phase 2.2 MERT Embedding Extraction | 🔄 后台运行中（screen: `mert_phase2_2`） |
| Phase 3.1 Cosine Similarity Matrix | ✅ 完成（`Similarity` 类） |
| Phase 3.1.5 Feature Selection | ✅ 完成（`HandcraftedFeatureSelector`，`feature_selection.py`） |
| Phase 3.2 Dimensionality Reduction | ✅ 完成（`SegmentReducer`，`reduction.py`） |
| Phase 3.3 Clustering | ✅ 完成（`SegmentClusterer`，`clustering.py`，silhouette 自动选 K + PCA 预处理） |
| Phase 4 Visualization | 🔄 进行中（waveform thumbnail 已实现，explorer_app 集成中） |
| Phase 5–7 | 🔲 待做 |

**当前主数据文件：** `TV_annotation_clean.csv`（692 条）
