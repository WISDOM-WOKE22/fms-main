from __future__ import annotations

import base64
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
import insightface

try:
    import mediapipe as mp  # type: ignore
except Exception:
    mp = None  # type: ignore

# Optional YOLO person detector (graceful fallback if unavailable)
try:
    import onnxruntime as _ort  # type: ignore
except Exception:
    _ort = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("fms-local-ai")

app = FastAPI(title="FMS Local AI Service", version="1.0.0")

# ---------------------------------------------------------------------------
# Configuration (env-driven, CPU-tuned defaults)
# ---------------------------------------------------------------------------
USE_YOLO = os.environ.get("USE_YOLO26", "true").lower() in ("true", "1", "yes")
YOLO_MODEL_PATH = os.environ.get("YOLO26_MODEL_PATH", "")
YOLO_INPUT_SIZE = int(os.environ.get("YOLO26_INPUT_SIZE", "640"))
YOLO_CONF = float(os.environ.get("YOLO26_CONF", "0.35"))
YOLO_IOU = float(os.environ.get("YOLO26_IOU", "0.45"))
MAX_PERSONS_PER_FRAME = int(os.environ.get("MAX_PERSONS_PER_FRAME", "5"))
RECOGNITION_THRESHOLD = float(os.environ.get("RECOGNITION_THRESHOLD", "0.5"))
EVENT_COOLDOWN_SECONDS = int(os.environ.get("EVENT_COOLDOWN_SECONDS", "10"))

# ---------------------------------------------------------------------------
# Provider auto-detection: GPU if available, else CPU
# Priority: CUDA > CoreML > DirectML > CPU
# ---------------------------------------------------------------------------
FMS_AI_PROVIDER = os.environ.get("FMS_AI_PROVIDER", "auto").strip().lower()
_AVAILABLE_ORT_PROVIDERS: list[str] = []
if _ort is not None:
    try:
        _AVAILABLE_ORT_PROVIDERS = _ort.get_available_providers()
    except Exception:
        _AVAILABLE_ORT_PROVIDERS = ["CPUExecutionProvider"]

def _select_providers() -> list[str]:
    """Select ORT execution providers based on FMS_AI_PROVIDER env."""
    if FMS_AI_PROVIDER == "cpu":
        return ["CPUExecutionProvider"]
    if FMS_AI_PROVIDER == "cuda":
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if FMS_AI_PROVIDER == "coreml":
        return ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    if FMS_AI_PROVIDER == "dml":
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    # auto: try GPU providers in priority order, fall back to CPU
    priority = ["CUDAExecutionProvider", "CoreMLExecutionProvider", "DmlExecutionProvider"]
    selected = [p for p in priority if p in _AVAILABLE_ORT_PROVIDERS]
    selected.append("CPUExecutionProvider")
    return selected

_SELECTED_PROVIDERS = _select_providers()
_ACTIVE_PROVIDER = _SELECTED_PROVIDERS[0] if _SELECTED_PROVIDERS else "CPUExecutionProvider"
logger.info("AI providers: selected=%s, available=%s, config=%s", _SELECTED_PROVIDERS, _AVAILABLE_ORT_PROVIDERS, FMS_AI_PROVIDER)

# ---------------------------------------------------------------------------
# Models — use auto-selected providers (with CoreML fallback to CPU)
# ---------------------------------------------------------------------------
def _init_insightface(providers: list[str]) -> insightface.app.FaceAnalysis:
    """Initialize InsightFace with fallback: if the selected provider crashes
    (common with CoreML on macOS temp-dir permission issues), retry with CPU."""
    try:
        model = insightface.app.FaceAnalysis(providers=providers)
        model.prepare(ctx_id=0, det_size=(640, 640))
        return model
    except Exception as exc:
        if "CPUExecutionProvider" in providers and len(providers) == 1:
            raise  # already on CPU, nothing to fall back to
        logger.warning("InsightFace init failed with providers %s: %s — falling back to CPU", providers, exc)
        model = insightface.app.FaceAnalysis(providers=["CPUExecutionProvider"])
        model.prepare(ctx_id=0, det_size=(640, 640))
        return model

_MODEL = _init_insightface(_SELECTED_PROVIDERS)
# Update active provider label after potential fallback
_ACTIVE_PROVIDER = "CPUExecutionProvider"  # safe default after init
logger.info("InsightFace model ready")

_MP_FACE_MESH = None
if mp is not None and hasattr(mp, "solutions") and hasattr(mp.solutions, "face_mesh"):
    _MP_FACE_MESH = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
else:
    logger.warning("MediaPipe FaceMesh unavailable; falling back to InsightFace-only quality checks.")

# ---------------------------------------------------------------------------
# YOLO person detector (optional, CPU-only)
# ---------------------------------------------------------------------------
_YOLO_SESSION: Any = None
_YOLO_AVAILABLE = False
_YOLO_END2END = False  # True if model output is [batch, N, 6] (x1,y1,x2,y2,score,class) with built-in NMS


def _try_convert_pt_to_onnx() -> str | None:
    """If a .pt file exists without a corresponding .onnx, convert it once at startup.
    Returns the path to the ONNX file, or None if conversion is not needed/possible."""
    here = Path(__file__).resolve().parent
    data_dir = os.environ.get("FMS_AI_DATA_DIR", "")
    pt_candidates = [
        here / "models" / "yolo26s.pt",
        here / "yolo26s.pt",
    ]
    if data_dir:
        pt_candidates.append(Path(data_dir) / "yolo26s.pt")

    for pt_path in pt_candidates:
        if not pt_path.is_file():
            continue
        onnx_path = pt_path.with_suffix(".onnx")
        if onnx_path.is_file() and onnx_path.stat().st_mtime >= pt_path.stat().st_mtime:
            logger.info("ONNX already up-to-date: %s", onnx_path)
            return str(onnx_path)
        # Attempt conversion — ultralytics is optional (not needed for inference)
        try:
            from ultralytics import YOLO  # type: ignore
            logger.info("Converting %s -> ONNX (one-time) ...", pt_path)
            model = YOLO(str(pt_path))
            model.export(format="onnx", imgsz=640, simplify=True, opset=17)
            if onnx_path.is_file():
                logger.info("Conversion OK: %s (%.1f MB)", onnx_path, onnx_path.stat().st_size / 1048576)
                return str(onnx_path)
            # ultralytics sometimes writes to a different location
            for p in pt_path.parent.rglob("*.onnx"):
                if p.stem == pt_path.stem:
                    import shutil
                    shutil.move(str(p), str(onnx_path))
                    logger.info("Conversion OK (moved): %s", onnx_path)
                    return str(onnx_path)
            logger.warning("Conversion produced no ONNX file for %s", pt_path)
        except ImportError:
            logger.info("ultralytics not installed — cannot auto-convert %s. Run: python convert_yolo.py", pt_path)
        except Exception as exc:
            logger.warning("Auto-conversion of %s failed: %s", pt_path, exc)
    return None


def _try_load_yolo() -> None:
    """Load YOLO ONNX model for person detection. Non-fatal on failure."""
    global _YOLO_SESSION, _YOLO_AVAILABLE
    if not USE_YOLO or _ort is None:
        logger.info("YOLO person detection disabled (USE_YOLO26=%s, onnxruntime=%s)", USE_YOLO, _ort is not None)
        return

    # Try auto-converting .pt → .onnx first (one-time, non-blocking for future starts)
    converted_path = _try_convert_pt_to_onnx()

    # Build candidate list: explicit override → converted path → well-known locations
    candidates: list[str] = []
    if YOLO_MODEL_PATH:
        candidates.append(YOLO_MODEL_PATH)
    if converted_path:
        candidates.append(converted_path)

    here = Path(__file__).resolve().parent
    onnx_names = ("yolo26s.onnx", "yolo11s.onnx", "yolov8s.onnx")
    # Search: models/ subdirectory, script directory, FMS_AI_DATA_DIR
    for name in onnx_names:
        candidates.append(str(here / "models" / name))
        candidates.append(str(here / name))
    data_dir = os.environ.get("FMS_AI_DATA_DIR", "")
    if data_dir:
        for name in onnx_names:
            candidates.append(str(Path(data_dir) / name))

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            unique.append(c)

    for path in unique:
        if path and Path(path).is_file():
            try:
                try:
                    sess = _ort.InferenceSession(path, providers=_SELECTED_PROVIDERS)
                except Exception:
                    logger.warning("YOLO ONNX init failed with %s, retrying with CPU", _SELECTED_PROVIDERS)
                    sess = _ort.InferenceSession(path, providers=["CPUExecutionProvider"])
                _YOLO_SESSION = sess
                _YOLO_AVAILABLE = True
                # Detect output format: end2end [1,N,6] vs raw [1,84,8400]
                out_shape = sess.get_outputs()[0].shape
                # end2end: last dim is exactly 6 (x1,y1,x2,y2,score,class_id)
                global _YOLO_END2END
                _YOLO_END2END = (len(out_shape) == 3 and out_shape[-1] == 6)
                logger.info("YOLO person detector loaded: %s (end2end=%s, output=%s)", path, _YOLO_END2END, out_shape)
                return
            except Exception as exc:
                logger.warning("Failed to load YOLO model %s: %s", path, exc)

    logger.info("No YOLO ONNX model found; person detection disabled (InsightFace-only mode). "
                "Place yolo26s.onnx in models/ or run: python convert_yolo.py")


_try_load_yolo()

# ---------------------------------------------------------------------------
# Ultralytics YOLO + ByteTrack stateful tracker (preferred over raw ONNX)
# ---------------------------------------------------------------------------
_ULTRA_MODEL: Any = None
_ULTRA_AVAILABLE = False

def _try_load_ultralytics() -> None:
    """Load ultralytics YOLO model with ByteTrack for persistent tracking."""
    global _ULTRA_MODEL, _ULTRA_AVAILABLE
    try:
        from ultralytics import YOLO as UltraYOLO  # type: ignore
    except ImportError:
        logger.info("ultralytics not installed — stateful tracking unavailable, using ONNX fallback")
        return

    # Verify tracker dependencies are available (lap, scipy, etc.)
    try:
        from ultralytics.trackers import BOTSORT, BYTETracker  # type: ignore  # noqa: F401
    except Exception as exc:
        logger.warning("ultralytics tracker dependencies missing (%s) — stateful tracking disabled. "
                        "Install with: pip install lap>=0.5.12", exc)
        return

    here = Path(__file__).resolve().parent
    data_dir = os.environ.get("FMS_AI_DATA_DIR", "")
    candidates = []
    if YOLO_MODEL_PATH:
        candidates.append(YOLO_MODEL_PATH)
    for name in ("yolo26s.pt", "yolo11s.pt", "yolov8s.pt"):
        candidates.append(str(here / "models" / name))
        candidates.append(str(here / name))
        if data_dir:
            candidates.append(str(Path(data_dir) / name))
    # Also accept ONNX models
    for name in ("yolo26s.onnx", "yolo11s.onnx", "yolov8s.onnx"):
        candidates.append(str(here / "models" / name))
        if data_dir:
            candidates.append(str(Path(data_dir) / name))

    seen: set[str] = set()
    for path in candidates:
        if path in seen or not Path(path).is_file():
            continue
        seen.add(path)
        try:
            model = UltraYOLO(path)
            _ULTRA_MODEL = model
            _ULTRA_AVAILABLE = True
            logger.info("Ultralytics YOLO loaded for stateful tracking: %s", path)
            return
        except Exception as exc:
            logger.warning("Failed to load ultralytics model %s: %s", path, exc)

    logger.info("No ultralytics-compatible model found — stateful tracking disabled")


_try_load_ultralytics()


# ---------------------------------------------------------------------------
# GlobalTrackManager — Singleton caching identity per ByteTrack track_id
# ---------------------------------------------------------------------------
TRACK_CONFIDENCE_THRESHOLD = float(os.environ.get("TRACK_CONFIDENCE_THRESHOLD", "0.8"))
TRACK_STALE_SECONDS = int(os.environ.get("TRACK_STALE_SECONDS", "30"))


class GlobalTrackManager:
    """Thread-safe singleton that caches {track_id: identity} so InsightFace
    only runs once per person (per track lifetime)."""

    _instance: "GlobalTrackManager | None" = None
    _lock = threading.Lock()

    def __new__(cls) -> "GlobalTrackManager":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    inst = super().__new__(cls)
                    inst._tracks: dict[int, dict[str, Any]] = {}
                    inst._track_lock = threading.Lock()
                    cls._instance = inst
        return cls._instance

    def get(self, track_id: int) -> dict[str, Any] | None:
        with self._track_lock:
            entry = self._tracks.get(track_id)
            if entry is not None:
                entry["last_seen"] = time.monotonic()
            return entry

    def put(self, track_id: int, identity: str, person_id: str, confidence: float) -> None:
        with self._track_lock:
            self._tracks[track_id] = {
                "identity": identity,
                "person_id": person_id,
                "confidence": confidence,
                "last_seen": time.monotonic(),
                "first_seen": time.monotonic(),
            }

    def update_seen(self, track_id: int) -> None:
        """Touch last_seen without changing identity."""
        with self._track_lock:
            if track_id in self._tracks:
                self._tracks[track_id]["last_seen"] = time.monotonic()

    def needs_recognition(self, track_id: int) -> bool:
        """Return True if this track needs InsightFace (unknown or low confidence)."""
        with self._track_lock:
            entry = self._tracks.get(track_id)
            if entry is None:
                return True
            return entry["confidence"] < TRACK_CONFIDENCE_THRESHOLD

    def cleanup(self, max_age: float | None = None) -> int:
        """Purge tracks not seen within max_age seconds. Returns count purged."""
        cutoff = max_age or TRACK_STALE_SECONDS
        now = time.monotonic()
        purged = 0
        with self._track_lock:
            stale = [tid for tid, e in self._tracks.items() if now - e["last_seen"] > cutoff]
            for tid in stale:
                del self._tracks[tid]
                purged += 1
        return purged

    def stats(self) -> dict[str, Any]:
        with self._track_lock:
            total = len(self._tracks)
            identified = sum(1 for e in self._tracks.values() if e["identity"] != "Unknown")
            return {"totalTracks": total, "identifiedTracks": identified, "unknownTracks": total - identified}

    def clear(self) -> None:
        with self._track_lock:
            self._tracks.clear()


_TRACK_MGR = GlobalTrackManager()


def _track_cleanup_loop() -> None:
    """Background thread that purges stale track IDs every 10s."""
    while True:
        try:
            purged = _TRACK_MGR.cleanup()
            if purged > 0:
                logger.debug("Track cleanup: purged %d stale tracks", purged)
        except Exception as exc:
            logger.warning("Track cleanup error: %s", exc)
        time.sleep(10)


_track_cleanup_thread = threading.Thread(target=_track_cleanup_loop, daemon=True, name="track-cleanup")
_track_cleanup_thread.start()


def _yolo_detect_persons(image: np.ndarray) -> list[list[float]]:
    """Run YOLO on a frame, return list of [x1,y1,x2,y2] person bboxes (full-frame coords).
    Supports two ONNX output formats:
      - end2end [1, N, 6]: (x1, y1, x2, y2, score, class_id) — NMS already applied
      - raw [1, 4+C, D]:  (cx, cy, w, h, class_scores...) — needs NMS
    """
    if _YOLO_SESSION is None:
        return []

    h_orig, w_orig = image.shape[:2]
    inp_size = YOLO_INPUT_SIZE
    # Letterbox resize preserving aspect ratio
    scale = min(inp_size / w_orig, inp_size / h_orig)
    new_w, new_h = int(w_orig * scale), int(h_orig * scale)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    padded = np.full((inp_size, inp_size, 3), 114, dtype=np.uint8)
    padded[:new_h, :new_w] = resized

    blob = padded.astype(np.float32) / 255.0
    blob = blob.transpose(2, 0, 1)[np.newaxis]  # NCHW

    input_name = _YOLO_SESSION.get_inputs()[0].name
    outputs = _YOLO_SESSION.run(None, {input_name: blob})
    preds = outputs[0]

    boxes: list[list[float]] = []
    scores: list[float] = []

    if _YOLO_END2END:
        # End2end format: [1, N, 6] = (x1, y1, x2, y2, score, class_id)
        # Coordinates are in input-space (640x640 letterboxed). NMS is already done.
        dets = preds[0] if preds.ndim == 3 else preds
        for det in dets:
            x1, y1, x2, y2, conf, cls = det[:6]
            if int(cls) != 0 or float(conf) < YOLO_CONF:
                continue
            # Map from letterboxed input coords back to original image coords
            boxes.append([
                max(0.0, float(x1) / scale),
                max(0.0, float(y1) / scale),
                min(float(w_orig), float(x2) / scale),
                min(float(h_orig), float(y2) / scale),
            ])
            scores.append(float(conf))
    else:
        # Raw format: [1, 4+C, D] or [1, D, 4+C] — needs NMS
        if preds.ndim == 3:
            preds = preds[0]
            if preds.shape[0] < preds.shape[1]:
                preds = preds.T
        for det in preds:
            class_scores = det[4:]
            class_id = int(np.argmax(class_scores))
            conf = float(class_scores[class_id])
            if class_id != 0 or conf < YOLO_CONF:
                continue
            cx, cy, bw, bh = det[:4]
            boxes.append([
                max(0.0, (float(cx) - float(bw) / 2) / scale),
                max(0.0, (float(cy) - float(bh) / 2) / scale),
                min(float(w_orig), (float(cx) + float(bw) / 2) / scale),
                min(float(h_orig), (float(cy) + float(bh) / 2) / scale),
            ])
            scores.append(conf)

        if not boxes:
            return []
        # NMS only needed for raw format
        box_arr = np.array(boxes, dtype=np.float32)
        score_arr = np.array(scores, dtype=np.float32)
        indices = cv2.dnn.NMSBoxes(box_arr.tolist(), score_arr.tolist(), YOLO_CONF, YOLO_IOU)
        if indices is None or len(indices) == 0:
            return []
        if isinstance(indices, np.ndarray):
            indices = indices.flatten().tolist()
        elif isinstance(indices[0], (list, tuple)):
            indices = [i[0] for i in indices]
        boxes = [boxes[i] for i in indices]
        scores = [scores[i] for i in indices]

    if not boxes:
        return []

    # Sort by area descending, cap to MAX_PERSONS_PER_FRAME
    paired = sorted(zip(boxes, scores), key=lambda p: (p[0][2] - p[0][0]) * (p[0][3] - p[0][1]), reverse=True)
    return [b for b, _ in paired[:MAX_PERSONS_PER_FRAME]]


# ---------------------------------------------------------------------------
# Event cooldown tracker (thread-safe, per personId+zoneId+action)
# ---------------------------------------------------------------------------
_COOLDOWN_LOCK = threading.Lock()
_COOLDOWN_MAP: dict[str, float] = {}
_COOLDOWN_LAST_CLEANUP = time.monotonic()


def _should_log_event(person_id: str, zone_id: str, action: str) -> bool:
    """Return True if this event should be logged (cooldown elapsed)."""
    global _COOLDOWN_LAST_CLEANUP
    now = time.monotonic()
    key = f"{person_id}:{zone_id}:{action}"
    with _COOLDOWN_LOCK:
        # Periodic cleanup of stale entries (every 60s)
        if now - _COOLDOWN_LAST_CLEANUP > 60:
            stale = [k for k, v in _COOLDOWN_MAP.items() if now - v > EVENT_COOLDOWN_SECONDS * 3]
            for k in stale:
                del _COOLDOWN_MAP[k]
            _COOLDOWN_LAST_CLEANUP = now

        last = _COOLDOWN_MAP.get(key, 0.0)
        if now - last < EVENT_COOLDOWN_SECONDS:
            return False
        _COOLDOWN_MAP[key] = now
        return True


# ---------------------------------------------------------------------------
# Database (thread-safe)
# ---------------------------------------------------------------------------
_data_dir = os.environ.get("FMS_AI_DATA_DIR", "")
if _data_dir and Path(_data_dir).is_dir():
    DB_PATH = Path(_data_dir) / "faces.db"
else:
    DB_PATH = Path(__file__).resolve().parent / "faces.db"
logger.info("Face embeddings database: %s", DB_PATH)
_DB_LOCK = threading.Lock()


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH.as_posix(), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


with _get_conn() as _init_conn:
    _init_conn.execute(
        """
        CREATE TABLE IF NOT EXISTS face_embeddings (
            person_id TEXT PRIMARY KEY,
            person_name TEXT NOT NULL,
            embedding BLOB NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

LEFT_EYE = 33
RIGHT_EYE = 263


class RegisterJsonRequest(BaseModel):
    person_id: str = Field(alias="personId")
    name: str
    image_base64: str = Field(alias="imageBase64")


class RecognizeJsonRequest(BaseModel):
    image_base64: str = Field(alias="imageBase64")
    threshold: float = 0.5
    max_faces: int = Field(default=20, alias="maxFaces")
    # Optional zone-aware metadata (additive, backward-compatible)
    zone_id: str | None = Field(default=None, alias="zoneId")
    camera_id: str | None = Field(default=None, alias="cameraId")
    action: str | None = Field(default=None, alias="action")
    request_id: str | None = Field(default=None, alias="requestId")


def _decode_image(image_base64: str) -> np.ndarray | None:
    payload = image_base64.strip()
    if not payload:
        return None
    if "," in payload:
        payload = payload.split(",", 1)[1]
    try:
        binary = base64.b64decode(payload)
    except Exception:
        logger.warning("Failed to decode base64 image payload")
        return None
    image = cv2.imdecode(np.frombuffer(binary, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        logger.warning("cv2.imdecode returned None – invalid image bytes")
    return image


def _is_face_centered(landmarks: Any, w: int, h: int) -> bool:
    xs = [lm.x * w for lm in landmarks.landmark]
    ys = [lm.y * h for lm in landmarks.landmark]
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    return (w * 0.3 < cx < w * 0.7) and (h * 0.25 < cy < h * 0.75)


def _is_face_big_enough(landmarks: Any, w: int) -> bool:
    xs = [lm.x * w for lm in landmarks.landmark]
    return (max(xs) - min(xs)) > w * 0.18


def _is_head_straight(landmarks: Any, h: int) -> bool:
    left = landmarks.landmark[LEFT_EYE]
    right = landmarks.landmark[RIGHT_EYE]
    return abs((left.y - right.y) * h) < 20


def _is_not_blurry(image: np.ndarray) -> bool:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var() > 60


def _quality_gate(image: np.ndarray) -> tuple[bool, str | None]:
    if _MP_FACE_MESH is None:
        faces = _MODEL.get(image)
        if len(faces) == 0:
            return False, "no_face"
        if not _is_not_blurry(image):
            return False, "frame_blurry"
        return True, None

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    results = _MP_FACE_MESH.process(rgb)
    if not results.multi_face_landmarks:
        return False, "no_face"
    landmarks = results.multi_face_landmarks[0]
    h, w, _ = image.shape
    checks = [
        (_is_face_centered(landmarks, w, h), "face_not_centered"),
        (_is_face_big_enough(landmarks, w), "face_too_small"),
        (_is_head_straight(landmarks, h), "head_not_straight"),
        (_is_not_blurry(image), "frame_blurry"),
    ]
    for ok, err in checks:
        if not ok:
            logger.info("Quality gate failed: %s", err)
            return False, err
    return True, None


def _get_embedding(image: np.ndarray) -> np.ndarray | None:
    faces = _MODEL.get(image)
    if len(faces) == 0:
        return None
    best = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    emb = best.embedding.astype(np.float32)
    norm = np.linalg.norm(emb)
    if norm <= 0:
        return emb
    return emb / norm


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom <= 0:
        return 0.0
    return float(np.dot(a, b) / denom)


_EMBEDDING_CACHE_LOCK = threading.Lock()
_EMBEDDING_CACHE_SIGNATURE: tuple[int, str] | None = None
_EMBEDDING_CACHE_IDS: list[str] = []
_EMBEDDING_CACHE_NAMES: list[str] = []
_EMBEDDING_CACHE_MATRIX: np.ndarray = np.empty((0, 0), dtype=np.float32)


def _load_embedding_cache() -> tuple[list[str], list[str], np.ndarray]:
    global _EMBEDDING_CACHE_SIGNATURE, _EMBEDDING_CACHE_IDS, _EMBEDDING_CACHE_NAMES, _EMBEDDING_CACHE_MATRIX

    with _EMBEDDING_CACHE_LOCK:
        with _DB_LOCK:
            conn = _get_conn()
            try:
                sig_row = conn.execute(
                    "SELECT COUNT(*), COALESCE(MAX(updated_at), '') FROM face_embeddings"
                ).fetchone()
                signature = (int(sig_row[0] if sig_row else 0), str(sig_row[1] if sig_row else ""))
                if signature == _EMBEDDING_CACHE_SIGNATURE:
                    return _EMBEDDING_CACHE_IDS, _EMBEDDING_CACHE_NAMES, _EMBEDDING_CACHE_MATRIX
                rows = conn.execute(
                    "SELECT person_id, person_name, embedding FROM face_embeddings"
                ).fetchall()
            finally:
                conn.close()

        ids: list[str] = []
        names: list[str] = []
        vectors: list[np.ndarray] = []
        for person_id, person_name, emb_blob in rows:
            emb = np.frombuffer(emb_blob, dtype=np.float32)
            if emb.size == 0:
                continue
            norm = np.linalg.norm(emb)
            if norm > 0:
                emb = emb / norm
            ids.append(str(person_id))
            names.append(str(person_name))
            vectors.append(emb.astype(np.float32, copy=False))

        if vectors:
            matrix = np.stack(vectors, axis=0)
        else:
            matrix = np.empty((0, 512), dtype=np.float32)

        _EMBEDDING_CACHE_SIGNATURE = signature
        _EMBEDDING_CACHE_IDS = ids
        _EMBEDDING_CACHE_NAMES = names
        _EMBEDDING_CACHE_MATRIX = matrix
        return ids, names, matrix


def _normalized_embedding(face: Any) -> np.ndarray | None:
    emb = getattr(face, "embedding", None)
    if emb is None:
        return None
    arr = np.asarray(emb, dtype=np.float32)
    if arr.size == 0:
        return None
    norm = np.linalg.norm(arr)
    if norm > 0:
        arr = arr / norm
    return arr


def _run_recognition_on_crop(
    image: np.ndarray,
    person_bbox: list[float] | None,
    threshold: float,
    ids: list[str],
    names: list[str],
    db_matrix: np.ndarray,
) -> dict[str, Any] | None:
    """Run InsightFace on a crop (or full image if person_bbox is None).
    Returns a single result dict or None if no face found."""
    if person_bbox is not None:
        h_img, w_img = image.shape[:2]
        x1, y1, x2, y2 = [int(v) for v in person_bbox]
        # Expand crop by 20% for better face detection
        bw, bh = x2 - x1, y2 - y1
        pad_x, pad_y = int(bw * 0.1), int(bh * 0.1)
        x1 = max(0, x1 - pad_x)
        y1 = max(0, y1 - pad_y)
        x2 = min(w_img, x2 + pad_x)
        y2 = min(h_img, y2 + pad_y)
        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            return None
    else:
        crop = image
        x1, y1 = 0, 0

    faces = _MODEL.get(crop)
    if not faces:
        return None

    best = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    emb = _normalized_embedding(best)
    if emb is None:
        return None

    # Face bbox in full-frame coordinates
    fx1 = float(best.bbox[0]) + x1
    fy1 = float(best.bbox[1]) + y1
    fx2 = float(best.bbox[2]) + x1
    fy2 = float(best.bbox[3]) + y1
    face_bbox = [fx1, fy1, fx2, fy2]

    if db_matrix.shape[0] == 0:
        return {"bbox": face_bbox, "personBbox": person_bbox, "status": "unknown", "score": 0.0}

    sim = np.dot(db_matrix, emb)
    best_idx = int(np.argmax(sim))
    best_score = float(sim[best_idx])

    if best_score >= threshold:
        return {
            "bbox": face_bbox,
            "personBbox": person_bbox,
            "status": "recognized",
            "personId": ids[best_idx],
            "name": names[best_idx],
            "score": best_score,
        }
    return {"bbox": face_bbox, "personBbox": person_bbox, "status": "unknown", "score": best_score}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
# RTSP Capture Backend — GStreamer (preferred) with OpenCV fallback.
# Per-OS pipeline selection: Linux+NVIDIA, macOS+VideoToolbox, Windows CPU.
# Env: FMS_RTSP_BACKEND, FMS_GST_PROFILE, FMS_GST_* tuning knobs.
# ---------------------------------------------------------------------------
import platform as _platform
import subprocess as _subprocess
import sys as _sys

# Capture config from env
_RTSP_BACKEND = os.environ.get("FMS_RTSP_BACKEND", "gstreamer").strip().lower()
_GST_PROFILE = os.environ.get("FMS_GST_PROFILE", "auto").strip().lower()
_GST_PROTOCOL = os.environ.get("FMS_GST_RTSP_PROTOCOL", "tcp").strip()
_GST_LATENCY_MS = int(os.environ.get("FMS_GST_LATENCY_MS", "120"))
_GST_AI_FPS = int(os.environ.get("FMS_GST_AI_FPS", "10"))
_GST_AI_WIDTH = int(os.environ.get("FMS_GST_AI_WIDTH", "960"))
_GST_AI_HEIGHT = int(os.environ.get("FMS_GST_AI_HEIGHT", "540"))
_GST_DROP = os.environ.get("FMS_GST_APPSINK_DROP", "true").lower() in ("true", "1")
_GST_MAX_BUFFERS = int(os.environ.get("FMS_GST_APPSINK_MAX_BUFFERS", "1"))
_GST_RETRY_MAX = int(os.environ.get("FMS_GST_RETRY_MAX", "8"))
_GST_RETRY_BASE_MS = int(os.environ.get("FMS_GST_RETRY_BASE_MS", "500"))
_GST_RETRY_MAX_MS = int(os.environ.get("FMS_GST_RETRY_MAX_MS", "10000"))
_GST_DEGRADE_AFTER = int(os.environ.get("FMS_GST_DEGRADE_TO_CPU_AFTER", "3"))
_CAP_MAX_AGE = 60.0


def _detect_os() -> str:
    s = _sys.platform
    if s.startswith("linux"): return "linux"
    if s == "darwin": return "macos"
    if s.startswith("win"): return "windows"
    return "unknown"


def _gst_element_exists(name: str) -> bool:
    try:
        r = _subprocess.run(["gst-inspect-1.0", name], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def _gstreamer_available() -> bool:
    """Check if GStreamer + Python bindings are usable."""
    if not hasattr(cv2, "CAP_GSTREAMER"):
        return False
    # Quick probe: can we build a trivial pipeline?
    try:
        test = cv2.VideoCapture("videotestsrc num-buffers=1 ! videoconvert ! appsink", cv2.CAP_GSTREAMER)
        ok = test.isOpened()
        test.release()
        return ok
    except Exception:
        return False


_GST_AVAILABLE = False
_GST_ACTIVE_PROFILE = "none"

if _RTSP_BACKEND in ("gstreamer", "gst", "auto"):
    _GST_AVAILABLE = _gstreamer_available()
    if _GST_AVAILABLE:
        logger.info("GStreamer backend: available")
    else:
        logger.info("GStreamer backend: not available, will use OpenCV")
elif _RTSP_BACKEND == "opencv":
    logger.info("RTSP backend forced to OpenCV by FMS_RTSP_BACKEND=opencv")
else:
    logger.info("Unknown FMS_RTSP_BACKEND=%s, defaulting to OpenCV", _RTSP_BACKEND)


def _select_gst_profile() -> str:
    """Select the best GStreamer decode profile for this OS."""
    if _GST_PROFILE != "auto":
        return _GST_PROFILE
    osname = _detect_os()
    if osname == "linux":
        # Check for NVIDIA decoder
        if _gst_element_exists("nvv4l2decoder"):
            return "linux_nvidia"
        return "linux_cpu"
    if osname == "macos":
        if _gst_element_exists("vtdec_hw"):
            return "macos_vt"
        return "macos_cpu"
    if osname == "windows":
        return "windows_cpu"
    return "cpu_generic"


def _build_gst_pipeline(rtsp_url: str, profile: str) -> str:
    """Build a GStreamer pipeline string for the given profile."""
    src = (
        f"rtspsrc location={rtsp_url} protocols={_GST_PROTOCOL} latency={_GST_LATENCY_MS} ! "
        f"rtpjitterbuffer drop-on-latency=true"
    )
    sink = (
        f"videorate ! video/x-raw,framerate={_GST_AI_FPS}/1 ! "
        f"appsink name=ai_sink drop={'true' if _GST_DROP else 'false'} "
        f"max-buffers={_GST_MAX_BUFFERS} sync=false"
    )
    resize = f"video/x-raw,format=BGR,width={_GST_AI_WIDTH},height={_GST_AI_HEIGHT}"

    if profile == "linux_nvidia":
        return (
            f"{src} ! rtph264depay ! h264parse ! nvv4l2decoder ! nvvidconv ! "
            f"video/x-raw,format=BGRx,width={_GST_AI_WIDTH},height={_GST_AI_HEIGHT} ! "
            f"videoconvert ! video/x-raw,format=BGR ! {sink}"
        )
    if profile == "macos_vt":
        return (
            f"{src} ! rtph264depay ! h264parse ! vtdec_hw ! videoconvert ! {resize} ! {sink}"
        )
    if profile in ("macos_cpu", "linux_cpu", "windows_cpu", "cpu_generic"):
        return (
            f"{src} ! rtph264depay ! h264parse ! avdec_h264 ! videoconvert ! {resize} ! {sink}"
        )
    # Fallback: generic CPU
    return f"{src} ! rtph264depay ! h264parse ! avdec_h264 ! videoconvert ! {resize} ! {sink}"


if _GST_AVAILABLE:
    _GST_ACTIVE_PROFILE = _select_gst_profile()
    logger.info("GStreamer profile: %s (os=%s)", _GST_ACTIVE_PROFILE, _detect_os())


# ── Capture pool entry ──────────────────────────────────────────────

_OPEN_TIMEOUT = 6  # seconds — max time to wait for RTSP connect


class _CaptureEntry:
    __slots__ = ("cap", "url", "backend", "last_used", "error_count")

    def __init__(self, cap: cv2.VideoCapture, url: str, backend: str):
        self.cap = cap
        self.url = url
        self.backend = backend
        self.last_used = time.monotonic()
        self.error_count = 0

    def release(self) -> None:
        try:
            self.cap.release()
        except Exception:
            pass


_CAP_LOCK = threading.Lock()
_CAP_POOL: dict[str, _CaptureEntry] = {}


def _add_rtsp_timeout(url: str, timeout_ms: int) -> str:
    """Append FFmpeg timeout option to RTSP URL so OpenCV's internal FFmpeg respects it."""
    # FFmpeg uses ?timeout=<microseconds> for RTSP TCP
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}timeout={timeout_ms * 1000}"  # ms -> microseconds


def _open_with_timeout(url: str, api: int, timeout: float) -> cv2.VideoCapture | None:
    """Open a VideoCapture in a daemon thread with a hard timeout."""
    result: list[cv2.VideoCapture | None] = [None]
    timeout_ms = int(timeout * 1000)

    def _worker():
        try:
            # For FFmpeg backend: inject timeout into URL so FFmpeg's avformat_open_input
            # respects it instead of using its 30-second default
            open_url = url
            if api == cv2.CAP_FFMPEG and url.startswith("rtsp://"):
                open_url = _add_rtsp_timeout(url, timeout_ms)

            # Set env var as additional safety net for FFmpeg
            os.environ["OPENCV_FFMPEG_READ_ATTEMPTS"] = "3"

            cap = cv2.VideoCapture(open_url, api)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if cap.isOpened():
                # Verify we can actually read a frame (catches cases where open succeeds but stream is dead)
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, timeout_ms)
                result[0] = cap
            else:
                try:
                    cap.release()
                except Exception:
                    pass
        except Exception:
            pass

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout=timeout + 2)
    if t.is_alive():
        logger.warning("VideoCapture.open timed out (%ds) for %s", int(timeout), url[:60])
        # Thread is daemon — it will die when process exits. We abandon it.
        return None
    return result[0]


def _open_capture(rtsp_url: str) -> _CaptureEntry | None:
    """Open a capture with timeout. Tries GStreamer then OpenCV."""
    if _GST_AVAILABLE:
        pipeline = _build_gst_pipeline(rtsp_url, _GST_ACTIVE_PROFILE)
        cap = _open_with_timeout(pipeline, cv2.CAP_GSTREAMER, _OPEN_TIMEOUT)
        if cap is not None:
            return _CaptureEntry(cap, rtsp_url, f"gstreamer:{_GST_ACTIVE_PROFILE}")

    cap = _open_with_timeout(rtsp_url, cv2.CAP_FFMPEG, _OPEN_TIMEOUT)
    if cap is not None:
        return _CaptureEntry(cap, rtsp_url, "opencv")
    logger.warning("All capture backends failed for %s", rtsp_url[:60])
    return None


def _get_rtsp_frame(rtsp_url: str) -> np.ndarray | None:
    """Grab one frame. Non-blocking: uses timeout on open and read."""
    now = time.monotonic()

    with _CAP_LOCK:
        stale = [k for k, e in _CAP_POOL.items() if now - e.last_used > _CAP_MAX_AGE]
        for k in stale:
            _CAP_POOL[k].release()
            del _CAP_POOL[k]

        entry = _CAP_POOL.get(rtsp_url)
        if entry is not None:
            entry.last_used = now
        else:
            entry = _open_capture(rtsp_url)
            if entry is None:
                return None
            _CAP_POOL[rtsp_url] = entry

    try:
        ret, frame = entry.cap.read()
        if not ret or frame is None:
            entry.error_count += 1
            if entry.error_count >= 3:
                with _CAP_LOCK:
                    _CAP_POOL.pop(rtsp_url, None)
                    entry.release()
            return None
        entry.error_count = 0
        return frame
    except Exception:
        with _CAP_LOCK:
            _CAP_POOL.pop(rtsp_url, None)
            entry.release()
        return None


class GrabFrameRequest(BaseModel):
    rtsp_url: str = Field(alias="rtspUrl")
    as_base64: bool = Field(default=True, alias="asBase64")


@app.post("/grab-frame")
def grab_frame(body: GrabFrameRequest) -> dict[str, Any]:
    """Grab a single JPEG frame from an RTSP stream."""
    frame = _get_rtsp_frame(body.rtsp_url)
    if frame is None:
        return {"ok": False, "error": "Failed to grab frame — camera may be unreachable"}
    if body.as_base64:
        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return {"ok": True, "imageBase64": base64.b64encode(buf).decode()}
    return {"ok": True}


@app.post("/test-camera")
def test_camera(body: GrabFrameRequest) -> dict[str, Any]:
    """Test if an RTSP camera is reachable and can produce a frame."""
    started = time.perf_counter()
    frame = _get_rtsp_frame(body.rtsp_url)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if frame is None:
        return {"ok": False, "reachable": False, "latencyMs": elapsed_ms, "error": "Cannot connect or read frame"}
    h, w = frame.shape[:2]
    return {"ok": True, "reachable": True, "latencyMs": elapsed_ms, "width": w, "height": h}


@app.post("/release-rtsp")
def release_rtsp(body: dict[str, Any]) -> dict[str, Any]:
    """Release pooled RTSP captures."""
    url = (body.get("rtspUrl") or "").strip()
    with _CAP_LOCK:
        if url and url in _CAP_POOL:
            _CAP_POOL[url].release()
            del _CAP_POOL[url]
        elif not url:
            for entry in _CAP_POOL.values():
                entry.release()
            _CAP_POOL.clear()
    return {"ok": True}


_PREV_CPU_SAMPLE: dict[str, float] = {"idle": 0, "total": 0, "time": 0}


def _sample_cpu_percent() -> float | None:
    """Sample actual CPU usage (user+sys vs idle) — not load average."""
    system = _platform.system()
    try:
        if system == "Darwin":
            # top -l 1 gives one sample of real CPU usage
            r = _subprocess.run(
                ["top", "-l", "1", "-n", "0", "-s", "0"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                for line in r.stdout.splitlines():
                    if "CPU usage" in line:
                        # "CPU usage: 11.69% user, 23.99% sys, 64.31% idle"
                        parts = line.split(",")
                        idle = 0.0
                        for p in parts:
                            if "idle" in p:
                                idle = float(p.strip().split("%")[0].split()[-1])
                        return round(100.0 - idle, 1)
        elif system == "Linux":
            # Read /proc/stat for accurate CPU usage delta
            with open("/proc/stat") as f:
                line = f.readline()
            vals = [float(v) for v in line.split()[1:]]
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
            total = sum(vals)
            prev = _PREV_CPU_SAMPLE
            d_idle = idle - prev.get("idle", 0)
            d_total = total - prev.get("total", 0)
            _PREV_CPU_SAMPLE["idle"] = idle
            _PREV_CPU_SAMPLE["total"] = total
            if d_total > 0 and prev.get("total", 0) > 0:
                return round((1 - d_idle / d_total) * 100, 1)
            return None  # First sample, no delta yet
        elif system == "Windows":
            r = _subprocess.run(
                ["wmic", "cpu", "get", "loadpercentage", "/format:csv"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                for line in r.stdout.strip().splitlines():
                    parts = line.split(",")
                    if len(parts) >= 2 and parts[-1].strip().isdigit():
                        return float(parts[-1].strip())
    except Exception:
        pass
    # Fallback: load average (less accurate but better than nothing)
    try:
        load1 = os.getloadavg()[0]
        cores = os.cpu_count() or 1
        return min(100.0, round(load1 / cores * 100, 1))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Background stats collector — samples every 3s, stores in DB + memory.
# The /system-stats endpoint reads the cached snapshot instantly.
# ---------------------------------------------------------------------------
_STATS_SNAPSHOT: dict[str, Any] = {}
_STATS_LOCK = threading.Lock()
_STATS_INTERVAL = 3  # seconds


def _collect_stats_once() -> dict[str, Any]:
    """Sample system stats (called by background thread)."""
    import resource
    usage = resource.getrusage(resource.RUSAGE_SELF)
    proc_cpu_s = usage.ru_utime + usage.ru_stime
    proc_mem_mb = usage.ru_maxrss / (1024 * 1024) if _sys.platform == "darwin" else usage.ru_maxrss / 1024

    cpu_percent = _sample_cpu_percent()
    mem = _detect_memory()
    mem_percent: float | None = None
    if mem["totalGB"] > 0:
        used = mem["totalGB"] - mem["availableGB"]
        mem_percent = round(max(0, min(100, used / mem["totalGB"] * 100)), 1)

    with _CAP_LOCK:
        active_captures = len(_CAP_POOL)

    return {
        "cpuPercent": cpu_percent,
        "memoryPercent": mem_percent,
        "memoryTotalGB": mem["totalGB"],
        "memoryAvailableGB": mem["availableGB"],
        "memoryUsedGB": round(mem["totalGB"] - mem["availableGB"], 1) if mem["totalGB"] > 0 else 0,
        "processMemoryMB": round(proc_mem_mb, 1),
        "processCpuSeconds": round(proc_cpu_s, 1),
        "activeCaptures": active_captures,
        "collectedAt": time.time(),
    }


def _persist_stats(stats: dict[str, Any]) -> None:
    """Write stats snapshot to DB so it survives restarts and is available instantly."""
    try:
        with _DB_LOCK:
            conn = _get_conn()
            try:
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS system_stats_cache (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        data TEXT NOT NULL,
                        updated_at REAL NOT NULL
                    )"""
                )
                import json
                conn.execute(
                    "INSERT INTO system_stats_cache (id, data, updated_at) VALUES (1, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                    (json.dumps(stats), time.time()),
                )
                conn.commit()
            finally:
                conn.close()
    except Exception:
        pass  # Non-fatal — cached snapshot in memory is enough


def _load_cached_stats() -> dict[str, Any] | None:
    """Load last persisted stats from DB (instant, no sampling)."""
    try:
        with _DB_LOCK:
            conn = _get_conn()
            try:
                row = conn.execute("SELECT data FROM system_stats_cache WHERE id = 1").fetchone()
                if row:
                    import json
                    return json.loads(row[0])
            finally:
                conn.close()
    except Exception:
        pass
    return None


def _stats_collector_loop() -> None:
    """Background thread: samples stats every few seconds."""
    global _STATS_SNAPSHOT
    while True:
        try:
            snapshot = _collect_stats_once()
            with _STATS_LOCK:
                _STATS_SNAPSHOT = snapshot
            _persist_stats(snapshot)
        except Exception as exc:
            logger.warning("Stats collector error: %s", exc)
        time.sleep(_STATS_INTERVAL)


# Load cached stats from DB on startup (so first request is instant)
_cached = _load_cached_stats()
if _cached:
    _STATS_SNAPSHOT = _cached
    logger.info("Loaded cached system stats from DB (age: %.0fs)", time.time() - _cached.get("collectedAt", 0))

# Start background collector thread
_stats_thread = threading.Thread(target=_stats_collector_loop, daemon=True, name="stats-collector")
_stats_thread.start()


@app.get("/system-stats")
def system_stats() -> dict[str, Any]:
    """Return latest system stats snapshot (pre-collected, instant response)."""
    with _STATS_LOCK:
        if _STATS_SNAPSHOT:
            return _STATS_SNAPSHOT
    # Fallback: collect once synchronously if background thread hasn't run yet
    return _collect_stats_once()


# ---------------------------------------------------------------------------
# System hardware detection — real specs from native Python process
# ---------------------------------------------------------------------------

def _detect_cpu() -> dict[str, Any]:
    """Detect CPU model, cores, and architecture."""
    import platform as plat
    info: dict[str, Any] = {
        "model": "Unknown",
        "cores": os.cpu_count() or 0,
        "arch": plat.machine(),  # arm64, x86_64, AMD64, aarch64
        "platform": plat.system(),  # Darwin, Linux, Windows
    }
    system = plat.system()
    try:
        if system == "Darwin":
            # macOS: sysctl gives exact chip name
            r = _subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=3)
            if r.returncode == 0 and r.stdout.strip():
                info["model"] = r.stdout.strip()
            else:
                # Apple Silicon doesn't have brand_string, use chip info
                r2 = _subprocess.run(["sysctl", "-n", "hw.chip"], capture_output=True, text=True, timeout=3)
                if r2.returncode == 0 and r2.stdout.strip():
                    info["model"] = r2.stdout.strip()
                elif plat.machine() == "arm64":
                    info["model"] = "Apple Silicon"
        elif system == "Linux":
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.startswith("model name"):
                        info["model"] = line.split(":", 1)[1].strip()
                        break
        elif system == "Windows":
            import winreg  # type: ignore
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            info["model"] = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
            winreg.CloseKey(key)
    except Exception:
        pass
    return info


def _detect_memory() -> dict[str, Any]:
    """Detect total and available RAM in GB."""
    info: dict[str, Any] = {"totalGB": 0, "availableGB": 0}
    system = _platform.system()
    try:
        if system == "Darwin":
            r = _subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3)
            if r.returncode == 0:
                info["totalGB"] = round(int(r.stdout.strip()) / (1024 ** 3), 1)
            # Get actual page size (16384 on Apple Silicon, 4096 on Intel)
            page_size = 4096
            rp = _subprocess.run(["sysctl", "-n", "hw.pagesize"], capture_output=True, text=True, timeout=3)
            if rp.returncode == 0 and rp.stdout.strip().isdigit():
                page_size = int(rp.stdout.strip())
            # Available = free + inactive (purgeable/speculative also reclaimable but conservative)
            r2 = _subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=3)
            if r2.returncode == 0:
                free_pages = 0
                for line in r2.stdout.splitlines():
                    if "Pages free" in line or "Pages inactive" in line or "Pages speculative" in line:
                        parts = line.split(":")
                        if len(parts) == 2:
                            val = parts[1].strip().rstrip(".")
                            if val.isdigit():
                                free_pages += int(val)
                info["availableGB"] = round(free_pages * page_size / (1024 ** 3), 1)
        elif system == "Linux":
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        info["totalGB"] = round(int(line.split()[1]) / (1024 ** 2), 1)
                    elif line.startswith("MemAvailable:"):
                        info["availableGB"] = round(int(line.split()[1]) / (1024 ** 2), 1)
        elif system == "Windows":
            r = _subprocess.run(["wmic", "OS", "get", "TotalVisibleMemorySize,FreePhysicalMemory", "/format:csv"],
                                capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                for line in r.stdout.strip().splitlines():
                    parts = line.split(",")
                    if len(parts) >= 3 and parts[1].isdigit():
                        info["availableGB"] = round(int(parts[1]) / (1024 ** 2), 1)
                        info["totalGB"] = round(int(parts[2]) / (1024 ** 2), 1)
    except Exception:
        pass
    return info


def _detect_gpu() -> list[dict[str, Any]]:
    """Detect GPUs available on the system."""
    gpus: list[dict[str, Any]] = []
    system = _platform.system()
    try:
        if system == "Darwin":
            r = _subprocess.run(["system_profiler", "SPDisplaysDataType", "-detailLevel", "mini"],
                                capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                current_name = ""
                current_vram = ""
                current_vendor = ""
                for line in r.stdout.splitlines():
                    stripped = line.strip()
                    if stripped.startswith("Chipset Model:"):
                        current_name = stripped.split(":", 1)[1].strip()
                    elif stripped.startswith("VRAM") or stripped.startswith("Total Number of Cores"):
                        current_vram = stripped.split(":", 1)[1].strip()
                    elif stripped.startswith("Vendor:"):
                        current_vendor = stripped.split(":", 1)[1].strip()
                    elif stripped.startswith("Metal") or stripped.startswith("Display Type"):
                        if current_name:
                            gpus.append({"name": current_name, "vram": current_vram, "vendor": current_vendor})
                            current_name = ""
                            current_vram = ""
                            current_vendor = ""
                if current_name:
                    gpus.append({"name": current_name, "vram": current_vram, "vendor": current_vendor})
        elif system == "Linux":
            # Try nvidia-smi first
            r = _subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                                capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                for line in r.stdout.strip().splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if parts:
                        gpus.append({"name": parts[0], "vram": parts[1] if len(parts) > 1 else "", "vendor": "NVIDIA"})
            # Also check lspci for non-NVIDIA
            if not gpus:
                r2 = _subprocess.run(["lspci"], capture_output=True, text=True, timeout=5)
                if r2.returncode == 0:
                    for line in r2.stdout.splitlines():
                        if "VGA" in line or "3D controller" in line:
                            gpus.append({"name": line.split(":", 2)[-1].strip(), "vram": "", "vendor": ""})
        elif system == "Windows":
            r = _subprocess.run(["wmic", "path", "win32_videocontroller", "get", "name,adapterram", "/format:csv"],
                                capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                for line in r.stdout.strip().splitlines():
                    parts = line.split(",")
                    if len(parts) >= 3 and parts[1]:
                        vram_bytes = int(parts[1]) if parts[1].isdigit() else 0
                        vram_str = f"{round(vram_bytes / (1024**3), 1)} GB" if vram_bytes > 0 else ""
                        gpus.append({"name": parts[2].strip(), "vram": vram_str, "vendor": ""})
    except Exception:
        pass
    return gpus


# Cache system info (won't change during process lifetime) — also persisted to DB
_SYSTEM_INFO_CACHE: dict[str, Any] | None = None


def _persist_system_info(info: dict[str, Any]) -> None:
    try:
        import json as _json
        with _DB_LOCK:
            conn = _get_conn()
            try:
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS system_info_cache (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        data TEXT NOT NULL
                    )"""
                )
                conn.execute(
                    "INSERT INTO system_info_cache (id, data) VALUES (1, ?) "
                    "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                    (_json.dumps(info),),
                )
                conn.commit()
            finally:
                conn.close()
    except Exception:
        pass


def _load_cached_system_info() -> dict[str, Any] | None:
    try:
        import json as _json
        with _DB_LOCK:
            conn = _get_conn()
            try:
                row = conn.execute("SELECT data FROM system_info_cache WHERE id = 1").fetchone()
                if row:
                    return _json.loads(row[0])
            finally:
                conn.close()
    except Exception:
        pass
    return None


# Try loading from DB on startup (instant)
_SYSTEM_INFO_CACHE = _load_cached_system_info()
if _SYSTEM_INFO_CACHE:
    logger.info("Loaded cached system-info from DB")


@app.get("/system-info")
def system_info() -> dict[str, Any]:
    """Return real hardware specs detected from the native OS."""
    global _SYSTEM_INFO_CACHE
    if _SYSTEM_INFO_CACHE is not None:
        return _SYSTEM_INFO_CACHE

    cpu = _detect_cpu()
    mem = _detect_memory()
    gpus = _detect_gpu()

    _SYSTEM_INFO_CACHE = {
        "cpu": cpu,
        "memory": mem,
        "gpus": gpus,
        "os": {
            "system": _platform.system(),
            "release": _platform.release(),
            "version": _platform.version(),
            "machine": _platform.machine(),
        },
    }
    _persist_system_info(_SYSTEM_INFO_CACHE)
    return _SYSTEM_INFO_CACHE


@app.get("/health")
def health() -> dict[str, Any]:
    # Per-capture stats
    with _CAP_LOCK:
        active_captures = len(_CAP_POOL)
        capture_backends = list({e.backend for e in _CAP_POOL.values()})

    # Count registered faces so the frontend/user can verify DB state
    registered_faces = 0
    try:
        with _DB_LOCK:
            conn = _get_conn()
            try:
                row = conn.execute("SELECT COUNT(*) FROM face_embeddings").fetchone()
                registered_faces = int(row[0]) if row else 0
            finally:
                conn.close()
    except Exception:
        pass

    return {
        "ok": True,
        "service": "fms-local-ai",
        "model": "insightface+mediapipe",
        "mediapipeFaceMeshAvailable": _MP_FACE_MESH is not None,
        "yoloAvailable": _YOLO_AVAILABLE,
        "yoloEnabled": USE_YOLO and _YOLO_AVAILABLE,
        "ultralyticsAvailable": _ULTRA_AVAILABLE,
        "statefulTracking": _ULTRA_AVAILABLE,
        "trackStats": _TRACK_MGR.stats(),
        "trackConfidenceThreshold": TRACK_CONFIDENCE_THRESHOLD,
        "trackStaleSeconds": TRACK_STALE_SECONDS,
        "provider": _ACTIVE_PROVIDER,
        "providerConfig": FMS_AI_PROVIDER,
        "selectedProviders": _SELECTED_PROVIDERS,
        "availableProviders": _AVAILABLE_ORT_PROVIDERS,
        "maxPersonsPerFrame": MAX_PERSONS_PER_FRAME,
        "eventCooldownSeconds": EVENT_COOLDOWN_SECONDS,
        "recognitionThreshold": RECOGNITION_THRESHOLD,
        "registeredFaces": registered_faces,
        "captureBackend": _RTSP_BACKEND,
        "gstreamerAvailable": _GST_AVAILABLE,
        "gstreamerProfile": _GST_ACTIVE_PROFILE,
        "captureOs": _detect_os(),
        "activeCaptures": active_captures,
        "activeCaptureBackends": capture_backends,
        "captureConfig": {
            "protocol": _GST_PROTOCOL,
            "latencyMs": _GST_LATENCY_MS,
            "aiFps": _GST_AI_FPS,
            "aiWidth": _GST_AI_WIDTH,
            "aiHeight": _GST_AI_HEIGHT,
        },
    }


@app.post("/register/json")
def register_json(body: RegisterJsonRequest) -> dict[str, Any]:
    logger.info("Register request for person_id=%s name=%s", body.person_id, body.name)
    image = _decode_image(body.image_base64)
    if image is None:
        return {"status": "invalid_image"}

    passed, err = _quality_gate(image)
    if not passed:
        logger.info("Registration quality gate failed: %s", err)
        return {"status": err or "bad_frame"}

    embedding = _get_embedding(image)
    if embedding is None:
        logger.warning("No embedding extracted for person_id=%s", body.person_id)
        return {"status": "no_face_embedding"}

    with _DB_LOCK:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO face_embeddings (person_id, person_name, embedding, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(person_id) DO UPDATE SET
                    person_name = excluded.person_name,
                    embedding = excluded.embedding,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (body.person_id, body.name.strip(), embedding.tobytes()),
            )
            conn.commit()
        finally:
            conn.close()

    logger.info("Registered person_id=%s successfully", body.person_id)
    return {"status": "registered", "personId": body.person_id, "name": body.name}


def _run_stateful_tracking(
    image: np.ndarray,
    threshold: float,
    max_faces: int,
    zone_id: str,
    camera_id: str,
    action: str,
) -> tuple[list[dict[str, Any]], dict[str, int], str]:
    """Run ultralytics model.track() with ByteTrack for persistent track IDs.
    Only calls InsightFace when a track_id is new or has low confidence."""

    here = Path(__file__).resolve().parent
    tracker_cfg = str(here / "bytetrack.yaml")
    if not Path(tracker_cfg).is_file():
        tracker_cfg = "bytetrack.yaml"

    t_detect = time.perf_counter()

    track_results = _ULTRA_MODEL.track(
        image,
        persist=True,
        tracker=tracker_cfg,
        conf=YOLO_CONF,
        iou=YOLO_IOU,
        imgsz=YOLO_INPUT_SIZE,
        classes=[0],
        verbose=False,
    )

    t_detect_done = time.perf_counter()

    results: list[dict[str, Any]] = []
    ids, names, db_matrix = _load_embedding_cache()

    if track_results and len(track_results) > 0:
        det = track_results[0]
        boxes = det.boxes
        if boxes is not None and len(boxes) > 0:
            for i, box in enumerate(boxes):
                if i >= max_faces:
                    break

                xyxy = box.xyxy[0].cpu().numpy()
                x1, y1, x2, y2 = float(xyxy[0]), float(xyxy[1]), float(xyxy[2]), float(xyxy[3])
                person_bbox = [x1, y1, x2, y2]
                conf = float(box.conf[0]) if box.conf is not None else 0.0
                track_id = int(box.id[0]) if box.id is not None else -1

                entry: dict[str, Any] = {
                    "faceIndex": len(results),
                    "trackId": track_id,
                    "personBbox": person_bbox,
                    "detectionConf": round(conf, 3),
                }

                if track_id >= 0 and not _TRACK_MGR.needs_recognition(track_id):
                    cached = _TRACK_MGR.get(track_id)
                    if cached is not None:
                        entry.update({
                            "bbox": person_bbox,
                            "status": "recognized",
                            "personId": cached["person_id"],
                            "name": cached["identity"],
                            "score": cached["confidence"],
                            "trackCached": True,
                        })
                        results.append(entry)
                        continue

                res = _run_recognition_on_crop(image, person_bbox, threshold, ids, names, db_matrix)
                if res is not None:
                    entry.update(res)
                    entry["trackCached"] = False
                    if track_id >= 0:
                        if res.get("status") == "recognized" and res.get("personId"):
                            _TRACK_MGR.put(track_id, identity=res["name"],
                                           person_id=res["personId"], confidence=res["score"])
                        else:
                            _TRACK_MGR.put(track_id, identity="Unknown",
                                           person_id="", confidence=res.get("score", 0.0))
                else:
                    entry.update({"bbox": person_bbox, "status": "unknown",
                                  "score": 0.0, "trackCached": False})
                    if track_id >= 0:
                        _TRACK_MGR.put(track_id, identity="Unknown", person_id="", confidence=0.0)

                results.append(entry)

    t_recognize_done = time.perf_counter()
    timing = {
        "detectMs": int((t_detect_done - t_detect) * 1000),
        "recognizeMs": int((t_recognize_done - t_detect_done) * 1000),
    }
    return results, timing, "ultralytics+bytetrack+insightface"


@app.post("/recognize/json")
def recognize_json(body: RecognizeJsonRequest) -> dict[str, Any]:
    started_at = time.perf_counter()
    image = _decode_image(body.image_base64)
    if image is None:
        return {"status": "invalid_image"}

    threshold = float(max(0.1, min(0.95, body.threshold)))
    max_faces = int(max(1, min(20, body.max_faces)))
    zone_id = (body.zone_id or "").strip()
    camera_id = (body.camera_id or "").strip()
    action = (body.action or "").strip()

    # ── Stateful tracking path (preferred) ──
    _use_stateful = _ULTRA_AVAILABLE
    if _use_stateful:
        try:
            results, timing, pipeline = _run_stateful_tracking(
                image, threshold, max_faces, zone_id, camera_id, action,
            )
        except Exception as exc:
            logger.warning("Stateful tracking failed, falling back to legacy: %s", exc)
            _use_stateful = False

    if not _use_stateful:
        # ── Legacy stateless fallback ──
        ids, names, db_matrix = _load_embedding_cache()
        t_detect = time.perf_counter()
        person_bboxes = _yolo_detect_persons(image) if _YOLO_AVAILABLE else []
        t_detect_done = time.perf_counter()

        results = []

        if person_bboxes:
            for pbbox in person_bboxes[:max_faces]:
                res = _run_recognition_on_crop(image, pbbox, threshold, ids, names, db_matrix)
                if res is not None:
                    res["faceIndex"] = len(results)
                    res["trackId"] = -1
                    res["trackCached"] = False
                    results.append(res)
        else:
            faces = _MODEL.get(image)
            sorted_faces = sorted(
                faces,
                key=lambda f: float((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])),
                reverse=True,
            )[:max_faces]

            for face in sorted_faces:
                emb = _normalized_embedding(face)
                if emb is None:
                    continue
                fx1, fy1, fx2, fy2 = [float(v) for v in face.bbox]
                face_bbox = [fx1, fy1, fx2, fy2]

                if db_matrix.shape[0] == 0:
                    results.append({"faceIndex": len(results), "bbox": face_bbox, "status": "unknown",
                                    "score": 0.0, "trackId": -1, "trackCached": False})
                    continue

                sim = np.dot(db_matrix, emb)
                best_idx = int(np.argmax(sim))
                best_score = float(sim[best_idx])
                if best_score >= threshold:
                    results.append({
                        "faceIndex": len(results), "bbox": face_bbox, "status": "recognized",
                        "personId": ids[best_idx], "name": names[best_idx], "score": best_score,
                        "trackId": -1, "trackCached": False,
                    })
                else:
                    results.append({"faceIndex": len(results), "bbox": face_bbox, "status": "unknown",
                                    "score": best_score, "trackId": -1, "trackCached": False})

        t_recognize_done = time.perf_counter()
        timing = {
            "detectMs": int((t_detect_done - t_detect) * 1000),
            "recognizeMs": int((t_recognize_done - t_detect_done) * 1000),
        }
        pipeline = "yolo+insightface" if person_bboxes else "insightface-only"

    if not results:
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        return {"status": "no_face_detected", "results": [], "countDetected": 0, "countRecognized": 0,
                "pipeline": pipeline, "timingMs": elapsed_ms, "latencyMs": elapsed_ms,
                "trackStats": _TRACK_MGR.stats()}

    # Cooldown / shouldLog
    for item in results:
        if item.get("status") == "recognized" and item.get("personId") and zone_id:
            item["shouldLog"] = _should_log_event(item["personId"], zone_id, action or "recognition")
        else:
            item["shouldLog"] = False

    top = max(results, key=lambda r: float(r.get("score") or 0.0), default=None)
    recognized_count = sum(1 for r in results if r.get("status") == "recognized")
    cached_count = sum(1 for r in results if r.get("trackCached"))
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)

    response: dict[str, Any] = {
        "status": "unknown",
        "score": float(top.get("score", 0.0)) if top else 0.0,
        "results": results,
        "countDetected": len(results),
        "countRecognized": recognized_count,
        "countCached": cached_count,
        "timingMs": elapsed_ms,
        "latencyMs": elapsed_ms,
        "timing": {**timing, "totalMs": elapsed_ms},
        "pipeline": pipeline,
        "trackStats": _TRACK_MGR.stats(),
    }
    if zone_id:
        response["zoneId"] = zone_id
    if camera_id:
        response["cameraId"] = camera_id

    if top and top.get("status") == "recognized":
        response.update({
            "status": "recognized",
            "personId": top.get("personId"),
            "name": top.get("name"),
            "score": float(top.get("score", 0.0)),
        })
    return response
