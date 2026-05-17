"""
export_waveform_thumbnail_data.py
==================================
SUPERSEDED — this script is no longer needed.

The waveform thumbnail JSON is now generated as part of export_explorer_data.py
(which produces both segment_visualization.csv AND waveform_thumbnails.json in
one pass).  The underlying logic lives in FrontendExporter.build_waveform_json
in tv_core.py.

To regenerate frontend data, use either:
  1. Phase 5 cell in notebooks/pipeline.ipynb  (preferred — uses in-memory data)
  2. python backend/export/export_explorer_data.py [--suffix _test]
"""

raise SystemExit(
    "This script is superseded by export_explorer_data.py — see module docstring."
)
