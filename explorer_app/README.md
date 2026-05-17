# Music Topic Explorer

Interactive 3D explorer for the Theme & Variations dataset in this repository.

The app currently visualizes record-level metadata from `src/data/TV_annotation_clean.csv`.
It does not require API keys or any backend service.

## Run Locally

Prerequisite: Node.js.

```bash
npm install
npm run dev
```

The dev server runs on port `3000` by default.

## Useful Commands

```bash
npm run lint
npm run build
npm run preview
npm run clean
```

## Project Notes

- Main app entry: `src/App.tsx`
- 3D scene: `src/components/ThreeSpace.tsx`
- Controls and detail panel: `src/components/UIOverlay.tsx`
- CSV parsing and spatial mapping: `src/utils/dataProcessor.ts`
- Current embedded data: `src/data/TV_annotation_clean.csv`

Next integration work should connect this app to the project pipeline outputs:
handcrafted features, MERT embeddings, similarity/reduction files, and waveform thumbnails.
