# Music Thumbnail Visualization for Theme & Variations

本文档解释本项目的代码与工程设计。重点不是逐行复述代码，而是说明每一步为什么存在、它接收什么输入、产出什么结果，以及它如何推动下一步研究。

## 1. 项目一句话概括

本项目把 Theme & Variations 音乐作品中的主题和变奏段落，从线性的音频对象转化为可计算、可比较、可解释、可浏览的视觉对象。

工程上，它完成了一条从标注数据到交互式可视化的 pipeline：

```text
CSV annotation
  -> raw WAV
  -> segmented WAV
  -> handcrafted audio features
  -> MERT audio embeddings
  -> similarity / reduction / clustering
  -> waveform thumbnail data
  -> React + Three.js explorer
```

研究上，它回答的是：一首变奏曲中的主题和各个 variation，如何在深度音频表示空间中靠近、分离、聚类和移动；这些空间关系又能否用可解释的 handcrafted features 来解释。

## 2. 为什么工程要分成后端 pipeline 和前端 explorer

这个项目有两个性质完全不同的工作：

1. 音频和模型计算很重。
   MERT embedding、handcrafted feature extraction、降维和聚类都需要 Python 科学计算环境。它们依赖 `librosa`、`torchaudio`、`transformers`、`scikit-learn`、`numpy`、`pandas` 等工具，并且运行时间较长。

2. 可视化交互需要轻量和即时。
   前端 explorer 需要快速加载、筛选、hover、播放、移动相机和绘制 3D 空间。它不应该在浏览器里重新跑 MERT 或聚类。

因此工程采用“离线计算 + 前端读取结果”的结构。Python 后端负责把所有重计算变成静态数据文件；React 前端只读取 `explorer_app/src/data/` 下的 CSV 和 JSON，然后负责交互式展示。这种设计的因果关系很清楚：模型计算越重，越应该提前离线完成；交互界面越需要流畅，越应该只消费已经整理好的轻量数据。

## 3. 数据入口：`TV_annotation_clean.csv`

项目的主数据文件是：

```text
data/TV_annotation_clean.csv
```

它是所有后续步骤的唯一正式入口。原始 `TV_annotation.csv` 只保留作参考，不再作为 pipeline 输入。

每一行代表一条录音记录，关键字段包括：

- `folder`：音频所在文件夹；
- `file_name (folderName_number)`：录音唯一 ID；
- `music_name`：作品名；
- `composer`：作曲家；
- `period`：时期；
- `instrument`：乐器；
- `boundary`：结构边界，格式为 `MM.SS`；
- `label`：结构标签，如 `T; V1; V2; ...`；
- `variation_num`：变奏数量。

这里一个容易出错的点是 `boundary` 的格式。`1.54` 不是 1.54 分钟，而是 1 分 54 秒。项目中多处都显式实现了 `mmss_to_sec`，把它转换为秒：

```text
1.54 -> 114 seconds
```

这个转换是整个切分流程的基础。如果这里理解错，后面的 segment WAV、feature extraction、embedding 和可视化都会整体错位。

## 4. 核心库：`tv_core.py`

`tv_core.py` 是项目的中枢。它把 notebooks 和脚本中会重复使用的逻辑集中起来，避免每个 notebook 自己写一套路径、筛选、特征提取和导出代码。

它的主要类如下：

```text
Paths
TVDataset
Handcrafted
MERTEmbedder
Similarity
FrontendExporter
```

### 4.1 `Paths`：统一路径管理

`Paths` 的作用是把项目路径集中定义：

```text
audio/
features/
embeddings/
data/
models/
```

它还提供两个关键方法：

```python
segment_wav(folder, fname, label)
raw_wav(folder, fname)
```

因果关系是：后续所有模块都需要稳定地找到音频文件。如果每个模块自己拼路径，很容易出现路径规则不一致。`Paths` 把路径规则变成单一来源，后续所有代码都引用它。

### 4.2 `TVDataset`：统一数据加载、筛选和 segment 迭代

`TVDataset` 负责读取 `TV_annotation_clean.csv`，并提供：

- `subset()`：按预设规则筛选数据；
- `mbh_piano()`：快速取 Mozart / Beethoven / Haydn 的 piano 子集；
- `labels()`：从一行标注里提取 `T`、`V1`、`V2` 等标签；
- `iter_segments()`：遍历实际存在的 segment WAV。

项目中把标签分为三类：

```text
core  -> T, V1, V2, ...
extra -> I, C, Inter, B
all   -> 所有标签
```

这个划分很重要。研究主体是主题和变奏，所以 handcrafted features 和 MERT embedding 的主要对象是 core segments；但 explorer 或听觉检查有时也需要保留 introduction、coda、interlude、bridge 等 extra segments。

`iter_segments()` 的设计有一个实际工程目的：它只 yield 已存在的 WAV 路径。这样后续特征提取和 embedding 不需要反复判断文件是否存在，错误会更少。

### 4.3 `Handcrafted`：可解释特征提取

`Handcrafted` 对每个 segment WAV 提取可解释的音频特征。它的输入是一个 WAV 文件，输出是一行 feature dict。

特征分组如下：

```text
Pitch:
  mean_pitch, pitch_range, pitch_variance,
  contour_changes, upward_ratio, leap_ratio

Rhythm:
  onset_density, tempo_stability,
  note_density, rhythmic_variance

Dynamics:
  rms_mean, rms_variance

Harmony:
  chroma_entropy, tonal_centroid, harmonic_stability

Timbre:
  spectral_centroid_mean, spectral_brightness,
  mfcc_mean_0..12, mfcc_var_0..12
```

这一步最早用于基础聚类尝试。原因是 handcrafted features 的每一维都比较容易解释：节奏密度高、音区更宽、音色更亮、力度变化更大，这些说法都可以和音乐感知对应起来。

但它也有局限：主题与变奏之间的相似性不一定能被单一低层特征完整表达。因此在后期设计中，handcrafted features 的角色发生了变化。它不再承担唯一表示空间，而是作为 explanation layer，帮助解释 MERT embedding 空间中的相似性和差异。

### 4.4 `MERTEmbedder`：深度音频表示

`MERTEmbedder` 使用 `m-a-p/MERT-v1-330M` 为每个 segment 生成 1024 维 embedding。

输入：

```text
audio/<folder>/<file_name>/<label>.wav
```

输出：

```text
embeddings/mert_embeddings/<folder>/<file_name>/<label>.npy
embeddings/embeddings.npy
embeddings/embedding_meta.csv
embeddings/mert_embedding_index.csv
```

它的关键工程设计有四个。

第一，懒加载模型。`MERTEmbedder` 初始化时不立刻加载 1.2GB 模型，只有第一次真正调用 `extract_one()` 时才加载。这避免了 notebook 只做配置或检查时就占用大量内存。

第二，优先使用本地模型。项目支持从：

```text
models/MERT-v1-330M/
```

加载 MERT。这样可以避免每次新 kernel 都访问 Hugging Face，也减少网络不稳定带来的失败。

第三，每个 segment 单独缓存为 `.npy`。这是非常关键的设计。MERT 运行慢，长片段尤其慢。如果只在最后保存一个大矩阵，中途失败就会损失所有结果。现在每跑完一个 segment 就保存：

```text
embeddings/mert_embeddings/.../<label>.npy
```

后续重跑时会自动跳过已存在的 embedding。

第四，矩阵文件从缓存重建。最终的 `embeddings.npy` 不是唯一真相；真正的断点续传依据是 per-segment `.npy` 缓存。`embeddings.npy` 和 `embedding_meta.csv` 可以随时从这些缓存重新组装。这让本地运行、Colab 补跑、archive import 都能汇合到同一个缓存结构。

在研究逻辑上，MERT 的作用是构建更综合的音乐相似性空间。handcrafted features 解释“哪些音乐属性可能变了”，MERT embedding 表达“整体听觉表示上哪些 segment 更接近”。

### 4.5 `Similarity`：从 embedding 到相似性

`Similarity` 接收：

```text
embeddings.npy
embedding_meta.csv
```

然后计算 cosine similarity matrix：

```text
embeddings/cosine_similarity.npy
```

它提供两个重要查询：

- `within_piece()` / `within_recording()`：查看一首作品内部主题和变奏之间的相似性矩阵；
- `top_similar()`：查找和某个 segment 最相似的其他 segments。

这一步把“每个 segment 的独立向量”转化为“segments 之间的关系”。后续降维、聚类和可视化都依赖这种关系意识。

### 4.6 `FrontendExporter`：把研究结果转成前端可读数据

`FrontendExporter` 是后端和前端之间的桥。它接收 pipeline 产生的多个表：

```text
annotation dataframe
reduction dataframe
cluster dataframe
thumbnail feature dataframe
feature selection dataframe
```

然后生成前端需要的两个文件：

```text
explorer_app/src/data/segment_visualization.csv
explorer_app/src/data/waveform_thumbnails.json
```

`segment_visualization.csv` 是主表，一行对应一个 core segment。它包含：

- 作品和 segment metadata；
- segment start / end / duration；
- t-SNE 坐标；
- KMeans cluster label；
- selected handcrafted feature 的 raw value 和 normalized value。

`waveform_thumbnails.json` 则给每个 segment 存：

- 降采样 waveform；
- selected features；
- feature group；
- group colors。

这样前端不用读完整 WAV，也不用重新 normalize feature。它只需要渲染已经准备好的 lightweight payload。

## 5. Pipeline 脚本与 notebook 的关系

项目的复杂逻辑放在库和脚本里，notebook 负责组织运行顺序。这是一个很好的研究工程模式：notebook 保留实验叙事和结果观察，核心逻辑则保持可复用、可测试、可从命令行运行。

### 5.1 `backend/pipeline/cut_segments.py`

这个脚本根据 CSV 里的 `boundary` 和 `label` 把整首 WAV 切成结构段：

```text
raw WAV
  -> T.wav
  -> V1.wav
  -> V2.wav
  -> ...
```

因果关系是：后续所有 feature 和 embedding 都以 segment 为单位，而不是以整首作品为单位。所以必须先完成音频切分。

脚本使用 `soundfile` 读取整首 WAV，再按 sample index 切片。边界从 `MM.SS` 转成秒，再转成 sample index：

```text
boundary string -> seconds -> sample index -> segment audio
```

### 5.2 `backend/pipeline/extract_handcrafted.py`

这个脚本调用 `TVDataset` 和 `Handcrafted`，批量生成：

```text
features/handcrafted_features.csv
```

它的意义是把音频变成可解释数值表。后续 feature selection、thumbnail normalization 和 explanation panel 都依赖这张表。

### 5.3 `backend/pipeline/run_phase2_2_mert.py`

这个脚本负责批量提取 MERT embedding。它本质上调用：

```python
MERTEmbedder().extract_batch(...)
```

这个阶段最耗时，所以代码支持：

- per-segment cache；
- checkpoint；
- CPU thread limit；
- `max_new_segments` 分批；
- local model loading；
- Colab 补跑包对接。

这些不是装饰性优化，而是让项目能在真实硬件限制下继续推进的工程必要条件。

### 5.4 `backend/pipeline/import_archive_mert_embeddings.py`

这个脚本把早期 archive 中已经算好的 MERT embedding 复制到当前标准缓存结构中。

原因是 MERT 计算成本高。只要旧结果和当前切分规则兼容，就不应该重复计算。脚本会检查 `.npy` shape 是否为 `(1024,)`，再复制到：

```text
embeddings/mert_embeddings/<folder>/<file_name>/<label>.npy
```

这一步体现的是“计算结果资产化”：昂贵计算不轻易丢弃，而是转入可复用缓存。

### 5.5 `backend/pipeline/run_missing_mert_manifest.py`

这个脚本服务于 Colab 补跑。当前本地 CPU 处理长 segment 很慢，所以项目生成只包含缺失 WAV 的小包，上传到 Colab GPU 上运行。

它读取：

```text
missing_core_segments.csv
```

逐段生成 embedding，并写回同样的标准结构。这样 Colab 跑出的结果下载回来后，可以直接和本地缓存合并。

因果关系是：标准缓存结构统一以后，本地、archive、Colab 都变成同一种结果来源。

## 6. Analysis 模块

`backend/analysis/` 存放可复用分析工具。它们不是一次性 notebook cell，而是围绕研究问题抽象出来的模块。

### 6.1 `feature_selection.py`

`HandcraftedFeatureSelector` 的任务是从 handcrafted features 中挑出更有解释价值的维度。

它支持以某个 target 为目标，例如：

```text
composer
period
```

然后用四种方法综合排序：

```text
ANOVA F-test
mutual information
RandomForest importance
L1 Logistic coefficient
```

代码刻意排除了 metadata 和 leakage columns，例如 `file_name`、`composer`、`piece`、`period`、`instrument`、`label`。这是为了避免模型“作弊”：如果把 composer 本身或作品名当作输入，feature selection 就不再是在评估音频特征，而是在读答案。

输出包括：

```text
features/handcrafted_feature_selection_<target>.csv
features/handcrafted_feature_selection_<target>_groups.csv
```

这些排序结果决定哪些 handcrafted features 会进入 thumbnail 和前端解释层。

### 6.2 `reduction.py`

`SegmentReducer` 负责把高维空间压缩成 2D 坐标，支持：

```text
PCA
UMAP
t-SNE
```

它可以使用两种 feature space：

```text
embedding    -> MERT 1024-D vectors
handcrafted  -> scaled handcrafted feature matrix
```

当前 explorer 主要使用 t-SNE 坐标作为前端空间布局。原因是浏览器里的 3D 空间需要二维或三维坐标，而 MERT embedding 是高维向量，不能直接显示。

需要注意：降维不是证明原始高维空间的真实形状，而是提供探索性视图。所以项目还保留 similarity matrix、cluster label 和 handcrafted explanation，避免只靠一张 t-SNE 图过度解释。

### 6.3 `clustering.py`

`SegmentClusterer` 负责无监督聚类。流程是：

```text
input feature matrix
  -> PCA retain 95% variance
  -> silhouette sweep for K
  -> KMeans clustering
  -> Ward hierarchical dendrogram
```

先 PCA 再聚类的原因是：MERT embedding 维度高，直接聚类容易受到噪声维度影响。PCA 先保留主要方差信息，再让 KMeans 在更稳定的空间中工作。

silhouette score 用来辅助选择 cluster 数量，减少完全主观指定 K 的问题。

聚类结果在本项目里不是“最终音乐学分类”，而是可视化导航和解释线索。用户可以观察：

- 同一首作品内的 variation 是否跨越多个 cluster；
- 同一作曲家的 variation 是否形成某些区域偏好；
- 某些 cluster 是否对应特定 handcrafted feature 的高值或低值；
- 主题到变奏的路径是否表现出风格转移。

### 6.4 `visualization.py`

`MusicThumbnailRenderer` 负责把 selected handcrafted features 转成 visual thumbnail。

它先对 selected features 做 robust min-max normalization。使用 5% 和 95% quantile，而不是简单 min / max，是为了减少极端值支配视觉编码的问题。

thumbnail 有两类核心视觉元素：

1. 内部 radial glyph：
   每一根 spoke 对应一个 selected handcrafted feature，长度对应 normalized feature value，颜色对应 feature group。

2. 外部 waveform ring：
   把 segment waveform 降采样后画成圆形轮廓，让用户直观看到 segment 的动态形状。

这一步的因果关系是：MERT embedding 决定空间位置，但它本身看不见；thumbnail 则让每个点变成有音乐特征的视觉对象。

## 7. 前端 explorer

前端位于：

```text
explorer_app/
```

它使用 React、Vite、Three.js、React Three Fiber、Tailwind、D3 shape 等工具。前端不重新计算模型，只读取：

```text
explorer_app/src/data/segment_visualization.csv
explorer_app/src/data/waveform_thumbnails.json
```

### 7.1 `App.tsx`

`App.tsx` 是前端状态中枢。

它负责：

- 读取 CSV 文本；
- 调用 `parseCSV()`；
- 调用 `processSpatialData()`；
- 保存 selected piece、hovered piece、search query、active period、playback state、camera command；
- 把数据传给 `ThreeSpace` 和 `UIOverlay`。

因果关系是：`App.tsx` 不关心具体 3D 怎么画，也不关心 waveform 怎么画；它负责把全局状态整理好，让 3D 场景和 UI panel 可以同步响应同一份数据。

### 7.2 `dataProcessor.ts`

`dataProcessor.ts` 把 CSV 字符串变成 TypeScript 对象。

关键步骤包括：

1. 用 `Papa.parse` 解析 CSV；
2. 将 boundary 字符串转成 seconds；
3. 读取 `norm_` 开头的 columns，形成 `selectedFeatureValues`；
4. 读取 `value_` 开头的 columns，形成 `selectedFeatureRawValues`；
5. 读取 `tsne_x`、`tsne_y` 和 `cluster_km`；
6. 给每个 segment 分配颜色。

前端点的位置初始来自：

```text
[tsneX, tsneY, selectedFeatureNorm]
```

也就是说，平面位置来自 MERT embedding 的 t-SNE 投影，高度轴可以来自当前选择的 handcrafted feature。

这正好对应本项目的研究设计：

```text
MERT = spatial substrate
handcrafted feature = interpretable vertical/explanation dimension
```

### 7.3 `ThreeSpace.tsx`

`ThreeSpace` 负责 3D 场景。

它做了几件核心事：

1. 坐标归一化。
   原始 t-SNE 坐标范围不固定。代码把每个 axis 的值缩放到 `[-8, 8]`，保证不同数据范围都能进入稳定的 3D 视野。

2. 坐标重排。
   前端数据里 position 是 `[x, y, z]`，Three.js 场景中为了让 t-SNE 平面躺在地面上，使用：

   ```text
   [x, z, y]
   ```

   这样 handcrafted feature 可以成为垂直高度，t-SNE X/Y 成为地面平面。

3. 按 recording 连接 trajectory。
   同一个 `fileName` 下的 `T, V1, V2, ...` 会按 label 顺序排序，并用 CatmullRom curve 连成轨迹。这让用户看到一首变奏曲内部的“运动路径”，而不是一堆孤立点。

4. 按 cluster 着色。
   每个 node 的颜色来自 `cluster_km`，所以用户可以观察 variation path 是否穿过不同 cluster。

5. 播放状态联动。
   当前播放时间会驱动 active trajectory 的高亮进度。音乐播放到哪个 segment，3D 路径就推进到哪里。

这个组件是“沉浸式观察”的核心。它把 embedding、cluster、variation order 和 playback time 绑定在同一个空间里。

### 7.4 `UIOverlay.tsx`

`UIOverlay` 负责界面层，包括：

- 搜索；
- period filter；
- selected segment detail；
- playback controls；
- camera controls；
- feature axis selection；
- waveform display；
- thumbnail panel；
- hover tooltip。

它还用 Web Audio / HTML audio 处理播放，并把播放时间通过 `onPlaybackUpdate` 传回 `App.tsx`，再传给 `ThreeSpace`。这就是为什么音频播放时 3D 空间能同步高亮当前 segment。

换句话说：

```text
UIOverlay controls audio time
  -> App stores playback state
  -> ThreeSpace reads playback state
  -> active trajectory updates
```

### 7.5 `WaveformThumbnail.tsx`

`WaveformThumbnail` 渲染前端版 thumbnail。它读取 `waveform_thumbnails.json` 中的：

```text
waveform
features
featureGroups
groupColors
```

然后画出：

- 外圈 waveform；
- 内部 feature radar；
- 当前 active feature；
- hover legend；
- feature 切换交互。

用户可以通过点击或滚轮切换 active feature。这个交互对应研究上的“teachable / explanation option”：同一个 segment 在 MERT 空间中的位置不变，但用户可以切换解释维度，观察它在不同 handcrafted features 上的强弱。

## 8. 整体数据流

从数据到界面的完整因果链如下：

```text
1. TV_annotation_clean.csv
   提供作品、边界、标签和 metadata

2. cut_segments.py
   根据 boundary 把 raw WAV 切成 T / Vn segment WAV

3. Handcrafted.extract_batch()
   从 segment WAV 提取可解释音频特征

4. MERTEmbedder.extract_batch()
   从 segment WAV 提取 1024-D deep audio embedding

5. Similarity
   用 cosine similarity 建立 segment 之间的相似性关系

6. SegmentReducer
   把高维 embedding 降到 2D，用于空间可视化

7. SegmentClusterer
   给 segment 添加 cluster label，作为结构和风格线索

8. HandcraftedFeatureSelector
   挑出更有解释价值的 handcrafted features

9. MusicThumbnailRenderer
   normalize selected features，生成 thumbnail feature table

10. FrontendExporter
    合并 annotation、reduction、cluster、thumbnail、feature selection
    输出前端 CSV 和 JSON

11. explorer_app
    读取静态数据，显示 3D trajectory、thumbnail、audio playback 和 explanation UI
```

这个链条的核心思想是：先把音乐切成结构单元，再为每个结构单元建立两种表示。MERT 表示负责整体相似性，handcrafted 表示负责解释性。最后通过可视化把“相似性空间”和“可解释音乐特征”放在同一个交互界面里。

## 9. 为什么 MERT 是基座，handcrafted 是解释层

这是项目最重要的方法论选择。

如果只用 handcrafted features 做空间布局，优点是清晰，缺点是表达能力有限。它可能只能解释节奏、音高、响度或音色中的某些局部属性，却难以捕捉整体听觉相似性。

如果只用 MERT embedding，优点是表示能力强，缺点是难解释。用户能看到两个 variation 很近，却不知道为什么近。

所以当前设计采用混合结构：

```text
MERT embedding:
  作为空间基座，决定整体相似性布局。

Handcrafted features:
  作为解释层，帮助用户理解空间关系可能对应哪些音乐属性。

Music thumbnails:
  把每个 segment 从抽象点变成可读的视觉对象。

3D trajectory:
  把一首作品中的 T -> V1 -> V2 -> ... 变成可观察的运动路径。
```

这也是项目从“特征提取实验”走向“可解释音乐可视化系统”的关键转折。

## 10. 当前工程状态

截至当前进度，项目已经完成或基本完成：

- 数据清洗和主 CSV 确认；
- 音频结构段切分；
- handcrafted feature extraction；
- MERT embedding extraction 的本地缓存、断点续跑和 Colab 补跑机制；
- cosine similarity 工具；
- feature selection；
- PCA / UMAP / t-SNE 降维；
- KMeans + Ward clustering；
- waveform thumbnail 设计；
- exporter 到前端数据；
- React / Three.js explorer 的主要交互框架。

还需要继续推进的部分包括：

- 补齐和合并剩余 MERT embedding；
- 对具体 case study 做音乐学解释；
- 系统化比较不同作曲家、时期和作品内部 variation trajectory；
- 设计 evaluation，验证 thumbnail 和 explorer 是否真的帮助理解音乐结构；
- 整理论文中的 results、discussion 和 limitation。

## 11. 论文中可以如何解释工程贡献

可以把工程贡献写成三层：

第一层是数据 pipeline。项目构建了一条面向 Theme & Variations 的音频段落处理流程，从 cleaned annotation 到 segment WAV，再到 feature、embedding、similarity、cluster 和 frontend export。

第二层是 hybrid representation。项目没有在 handcrafted features 和 deep embedding 之间二选一，而是让它们承担不同职责：MERT embedding 负责整体相似性，handcrafted features 负责解释性。

第三层是 visual analytics system。项目把每个 theme / variation segment 映射为空间中的节点、作品内部 trajectory 和 waveform thumbnail，使用户可以沉浸式观察一首变奏曲内部的结构运动。

一句话总结：

```text
This project turns theme-and-variation recordings into an explainable visual analytics space, where deep audio embeddings provide the spatial substrate and handcrafted features provide interpretable musical explanations.
```

中文可以写成：

```text
本项目将主题与变奏录音转化为一个可解释的音乐视觉分析空间：深度音频 embedding 构成空间基座，handcrafted features 提供可解释的音乐特征层，交互式 explorer 则支持研究者观察一首变奏曲内部主题与变奏之间的结构运动和风格变化。
```
