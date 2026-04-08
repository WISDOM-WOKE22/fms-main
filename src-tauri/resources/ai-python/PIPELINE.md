# Face Recognition Pipeline — Technical Reference

## Architecture

```
CCTV/Camera frame (JPEG base64)
        │
        ▼
  Rust API  (/api/v1/face/recognize)
        │  forwards to Python AI service
        ▼
  Python AI Service  (/recognize/json)
        │
        ├─► YOLO person detection (if ONNX model available)
        │     └─► crop each person ROI
        │           └─► InsightFace embedding + cosine match
        │
        └─► InsightFace-only fallback (if no YOLO)
              └─► detect faces directly on full frame
                    └─► cosine match against DB
        │
        ▼
  Per-person results  →  Rust layer logs events  →  UI overlay
```

## Model files

| File | Type | Purpose |
|------|------|---------|
| `models/yolo26s.pt` | Source weights | PyTorch YOLO model (not used at runtime) |
| `models/yolo26s.onnx` | Runtime artifact | Converted ONNX model for `onnxruntime` inference |

**`.pt` is the source of truth. `.onnx` is a derived artifact.**

### Conversion

One-time conversion (requires `ultralytics`):
```bash
cd src-tauri/resources/ai-python
python convert_yolo.py                    # auto-finds models/yolo26s.pt
python convert_yolo.py models/yolo26s.pt  # explicit path
python convert_yolo.py --force            # reconvert even if ONNX exists
```

The AI service also auto-converts on startup if `ultralytics` is installed and no ONNX exists.

### Search locations (in priority order)

1. `YOLO26_MODEL_PATH` env override
2. `models/` subdirectory next to `ai_service.py`
3. Same directory as `ai_service.py`
4. `FMS_AI_DATA_DIR` (set by Tauri host, e.g. `~/Library/Application Support/com.wisdom.fms-main/ai-data/`)

Candidate filenames: `yolo26s.onnx`, `yolo11s.onnx`, `yolov8s.onnx`

### Output format support

The detection code auto-detects two ONNX output formats:
- **End2end** `[1, N, 6]`: `(x1, y1, x2, y2, score, class_id)` — NMS built-in (yolo26s default)
- **Raw** `[1, 4+C, D]`: `(cx, cy, w, h, class_scores...)` — requires post-hoc NMS (yolov8/yolo11)

## Configuration

### GPU/CPU Provider Selection

| Env Variable | Default | Description |
|---|---|---|
| `FMS_AI_PROVIDER` | `auto` | `auto` / `cpu` / `cuda` / `coreml` / `dml`. Auto tries GPU first |

Auto priority: CUDA → CoreML → DirectML → CPU. Used for both InsightFace and YOLO ONNX sessions.

### YOLO Detection

| Env Variable | Default | Description |
|---|---|---|
| `USE_YOLO26` | `true` | Enable YOLO person detection before face recognition |
| `YOLO26_MODEL_PATH` | (auto-search) | Explicit path to ONNX model |
| `YOLO26_INPUT_SIZE` | `640` | Input resolution for YOLO. Lower = faster (try 416 or 320) |
| `YOLO26_CONF` | `0.35` | Confidence threshold for person detection |
| `YOLO26_IOU` | `0.45` | NMS IoU threshold (raw format only; end2end has NMS built in) |
| `MAX_PERSONS_PER_FRAME` | `5` | Max persons to process per frame (caps CPU load) |
| `RECOGNITION_THRESHOLD` | `0.5` | Cosine similarity threshold for face match |
| `EVENT_COOLDOWN_SECONDS` | `10` | Dedupe window: same person+zone+action won't log twice within this period |

### RTSP Capture Backend (GStreamer / OpenCV)

| Env Variable | Default | Description |
|---|---|---|
| `FMS_RTSP_BACKEND` | `gstreamer` | `gstreamer` / `opencv` / `auto` — capture library for RTSP frames |
| `FMS_GST_PROFILE` | `auto` | `auto` / `linux_nvidia` / `macos_vt` / `macos_cpu` / `windows_cpu` / `cpu_generic` |
| `FMS_GST_RTSP_PROTOCOL` | `tcp` | RTSP transport protocol (`tcp` recommended) |
| `FMS_GST_LATENCY_MS` | `120` | RTSP source latency buffer (ms) |
| `FMS_GST_AI_FPS` | `10` | Target capture FPS for AI ingestion |
| `FMS_GST_AI_WIDTH` | `960` | Capture resize width |
| `FMS_GST_AI_HEIGHT` | `540` | Capture resize height |
| `FMS_GST_APPSINK_DROP` | `true` | Drop old frames in appsink (latest-frame-only) |
| `FMS_GST_APPSINK_MAX_BUFFERS` | `1` | Max queued buffers in appsink |
| `FMS_GST_RETRY_MAX` | `8` | Max reconnect retries per capture |
| `FMS_GST_RETRY_BASE_MS` | `500` | Base retry backoff (ms) |
| `FMS_GST_RETRY_MAX_MS` | `10000` | Max retry backoff (ms) |
| `FMS_GST_DEGRADE_TO_CPU_AFTER` | `3` | After N GStreamer read failures, degrade to OpenCV |

**Per-OS pipeline profiles** (auto-detected):
- **linux_nvidia**: `nvv4l2decoder` + `nvvidconv` (NVIDIA GPU decode)
- **macos_vt**: `vtdec_hw` (Apple VideoToolbox hardware decode)
- **linux_cpu / macos_cpu / windows_cpu**: `avdec_h264` (software decode)
- **Fallback**: If GStreamer unavailable, automatically uses OpenCV + FFmpeg backend

### Always-On AI Camera Orchestration (Rust backend)

| Env Variable | Default | Description |
|---|---|---|
| `FMS_AI_MAX_INFLIGHT` | `3` | Max concurrent recognition requests across all cameras |
| `FMS_AI_SAMPLE_INTERVAL_MS` | `1000` | Frame sampling interval per camera (ms). Higher = less CPU |

### API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/ai/cameras/start-all` | Start AI workers for all configured cameras |
| POST | `/api/v1/ai/cameras/stop-all` | Stop all AI workers |
| GET | `/api/v1/ai/cameras/status` | Per-camera stats + global totals |
| POST | `/api/v1/ai/cameras/:id/toggle` | `{ "enabled": bool }` start/stop individual camera |

## Verification

### 1. Health check
```bash
curl http://127.0.0.1:<port>/health
```
Expected with GPU auto-detection:
```json
{
  "ok": true,
  "yoloAvailable": true,
  "yoloEnabled": true,
  "provider": "CPUExecutionProvider",
  "providerConfig": "auto",
  "selectedProviders": ["CPUExecutionProvider"],
  "availableProviders": ["CPUExecutionProvider"]
}
```

### 2. Recognition pipeline
```bash
curl -X POST http://127.0.0.1:<port>/recognize/json \
  -H "Content-Type: application/json" \
  -d '{"imageBase64":"<base64>","threshold":0.5}'
```
When YOLO is active, response includes:
- `"pipeline": "yolo+insightface"`
- `results[].personBbox` — person bounding box from YOLO
- `results[].bbox` — face bounding box from InsightFace

When YOLO unavailable:
- `"pipeline": "insightface-only"`
- `results[].personBbox` absent

## Response Fields (additive, backward-compatible)

- `results[].personBbox` — person bounding box from YOLO (null if InsightFace-only)
- `results[].shouldLog` — whether this event passed cooldown and should be logged
- `timing.detectMs` — YOLO detection time
- `timing.recognizeMs` — face embedding + matching time
- `pipeline` — `"yolo+insightface"` or `"insightface-only"`

## Troubleshooting

1. **YOLO not loading**: Check `/health` for `yoloAvailable: false`. Verify `.onnx` file exists. Run `python convert_yolo.py` if only `.pt` exists.
2. **Auto-conversion not working**: Install `ultralytics` (`pip install ultralytics`), or run `convert_yolo.py` manually.
3. **High latency**: Lower `YOLO26_INPUT_SIZE` to 416 or 320. Reduce `MAX_PERSONS_PER_FRAME`.
4. **Log spam**: Increase `EVENT_COOLDOWN_SECONDS`. Check `shouldLog` field in results.
5. **503 errors from Rust**: Check that `face_recognition_events` table has `zoneId`/`cameraId` columns (migration 12).
6. **Memory growth**: Embedding cache is bounded by DB size. YOLO session is loaded once at startup.
