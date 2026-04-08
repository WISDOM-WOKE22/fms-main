"""
FMS Vision Pipeline — StreamProcessor (Python Push Model)

Replaces the pull-based REST/Base64 architecture with an async push model:
  - Each RTSP stream runs its own asyncio capture loop
  - Detections are pushed to the Rust orchestrator via gRPC server-streaming
  - InsightFace only runs for new/low-confidence tracks (stateful caching)
  - Re-ID buffer preserves identity across occlusions (cosine ≥ 0.85)

Usage:
    processor = StreamProcessor()
    async for frame_detections in processor.run(stream_config):
        # yields FrameDetections proto messages
        pass
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

import cv2
import numpy as np

logger = logging.getLogger("fms.stream_processor")

# ────────────────────────────────────────────────────────────────────
# Configuration
# ────────────────────────────────────────────────────────────────────

TRACK_CONFIDENCE_THRESHOLD = float(os.environ.get("TRACK_CONFIDENCE_THRESHOLD", "0.8"))
TRACK_STALE_SECONDS = int(os.environ.get("TRACK_STALE_SECONDS", "30"))
REID_BUFFER_SECONDS = float(os.environ.get("REID_BUFFER_SECONDS", "30"))
REID_SIMILARITY_THRESHOLD = float(os.environ.get("REID_SIMILARITY_THRESHOLD", "0.85"))
REID_MAX_EMBEDDINGS = int(os.environ.get("REID_MAX_EMBEDDINGS", "5"))
EVENT_COOLDOWN_SECONDS = float(os.environ.get("EVENT_COOLDOWN_SECONDS", "10"))
MAX_PERSONS_PER_FRAME = int(os.environ.get("MAX_PERSONS_PER_FRAME", "5"))
RECOGNITION_THRESHOLD = float(os.environ.get("RECOGNITION_THRESHOLD", "0.5"))


@dataclass
class StreamConfig:
    """Configuration for a single RTSP stream processing loop."""
    stream_id: str
    rtsp_url: str
    zone_id: str
    zone_polygon: list[tuple[float, float]] | None = None
    target_fps: float = 1.0
    input_width: int = 960
    input_height: int = 540
    recognition_threshold: float = RECOGNITION_THRESHOLD
    max_persons: int = MAX_PERSONS_PER_FRAME


# ────────────────────────────────────────────────────────────────────
# Re-Identification Buffer
# ────────────────────────────────────────────────────────────────────

@dataclass
class _LostTrack:
    """Buffered state for a recently lost track."""
    track_id: int
    person_id: str
    person_name: str
    embeddings: deque  # deque[np.ndarray], max REID_MAX_EMBEDDINGS
    lost_at: float     # time.monotonic()


class ReIDBuffer:
    """Stores last N embeddings of recently lost tracks for re-identification.

    When a track disappears (e.g. occlusion), we buffer its embeddings for
    REID_BUFFER_SECONDS. If a "new" track appears with cosine similarity ≥ 0.85
    to a buffered track, we merge the IDs — the new track inherits the old
    identity, ensuring persistence across occlusions.
    """

    def __init__(
        self,
        max_embeddings: int = REID_MAX_EMBEDDINGS,
        buffer_seconds: float = REID_BUFFER_SECONDS,
        similarity_threshold: float = REID_SIMILARITY_THRESHOLD,
    ):
        self._max_embeddings = max_embeddings
        self._buffer_seconds = buffer_seconds
        self._similarity_threshold = similarity_threshold
        self._lost_tracks: dict[int, _LostTrack] = {}
        self._lock = threading.Lock()

    def on_track_lost(
        self, track_id: int, person_id: str, person_name: str, embeddings: list[np.ndarray]
    ) -> None:
        """Buffer a lost track's identity and recent embeddings."""
        if not person_id or not embeddings:
            return
        with self._lock:
            self._lost_tracks[track_id] = _LostTrack(
                track_id=track_id,
                person_id=person_id,
                person_name=person_name,
                embeddings=deque(embeddings[-self._max_embeddings:], maxlen=self._max_embeddings),
                lost_at=time.monotonic(),
            )

    def try_reidentify(self, embedding: np.ndarray) -> tuple[str, str, int] | None:
        """Try to match a new track's embedding against buffered lost tracks.

        Returns (person_id, person_name, original_track_id) if match found, else None.
        """
        if embedding is None or len(embedding) == 0:
            return None

        self._cleanup()
        best_score = 0.0
        best_match: _LostTrack | None = None

        with self._lock:
            for lost in self._lost_tracks.values():
                for cached_emb in lost.embeddings:
                    score = float(np.dot(embedding, cached_emb) / (
                        np.linalg.norm(embedding) * np.linalg.norm(cached_emb) + 1e-8
                    ))
                    if score > best_score:
                        best_score = score
                        best_match = lost

        if best_match is not None and best_score >= self._similarity_threshold:
            logger.info(
                "Re-ID match: new track → lost track %d (person=%s, score=%.3f)",
                best_match.track_id, best_match.person_id, best_score,
            )
            # Remove from buffer once re-identified
            with self._lock:
                self._lost_tracks.pop(best_match.track_id, None)
            return (best_match.person_id, best_match.person_name, best_match.track_id)

        return None

    def _cleanup(self) -> None:
        """Remove expired entries from the buffer."""
        now = time.monotonic()
        with self._lock:
            expired = [
                tid for tid, lt in self._lost_tracks.items()
                if now - lt.lost_at > self._buffer_seconds
            ]
            for tid in expired:
                del self._lost_tracks[tid]

    @property
    def buffered_count(self) -> int:
        with self._lock:
            return len(self._lost_tracks)


# ────────────────────────────────────────────────────────────────────
# TrackManager — Enhanced with Re-ID and embedding cache
# ────────────────────────────────────────────────────────────────────

@dataclass
class _TrackEntry:
    identity: str
    person_id: str
    confidence: float
    last_seen: float
    first_seen: float
    embeddings: deque = field(default_factory=lambda: deque(maxlen=REID_MAX_EMBEDDINGS))
    zone_entered: bool = False


class TrackManager:
    """Per-stream stateful track manager with Re-ID support.

    Maps track_id → identity cache. If a person is detected but the track_id
    is new, runs InsightFace; otherwise skips recognition and returns cached
    identity. When a track is lost, its embeddings are buffered in the ReIDBuffer
    for cross-occlusion re-identification.
    """

    def __init__(self) -> None:
        self._tracks: dict[int, _TrackEntry] = {}
        self._reid_buffer = ReIDBuffer()
        self._lock = threading.Lock()
        self._last_cleanup = time.monotonic()

    def get(self, track_id: int) -> _TrackEntry | None:
        with self._lock:
            entry = self._tracks.get(track_id)
            if entry is not None:
                entry.last_seen = time.monotonic()
            return entry

    def put(
        self,
        track_id: int,
        identity: str,
        person_id: str,
        confidence: float,
        embedding: np.ndarray | None = None,
    ) -> None:
        with self._lock:
            now = time.monotonic()
            if track_id in self._tracks:
                entry = self._tracks[track_id]
                entry.identity = identity
                entry.person_id = person_id
                entry.confidence = confidence
                entry.last_seen = now
                if embedding is not None:
                    entry.embeddings.append(embedding)
            else:
                entry = _TrackEntry(
                    identity=identity,
                    person_id=person_id,
                    confidence=confidence,
                    last_seen=now,
                    first_seen=now,
                )
                if embedding is not None:
                    entry.embeddings.append(embedding)
                self._tracks[track_id] = entry

    def needs_recognition(self, track_id: int) -> bool:
        """Return True if InsightFace should run for this track."""
        with self._lock:
            entry = self._tracks.get(track_id)
            if entry is None:
                return True
            return entry.confidence < TRACK_CONFIDENCE_THRESHOLD

    def try_reidentify(self, track_id: int, embedding: np.ndarray) -> tuple[str, str] | None:
        """Attempt to re-identify a new track using the Re-ID buffer.

        Returns (person_id, person_name) if a match is found, else None.
        """
        result = self._reid_buffer.try_reidentify(embedding)
        if result is not None:
            person_id, person_name, _orig_track_id = result
            self.put(track_id, person_name, person_id, 0.90, embedding)
            return (person_id, person_name)
        return None

    def set_zone_entered(self, track_id: int, entered: bool) -> None:
        with self._lock:
            if track_id in self._tracks:
                self._tracks[track_id].zone_entered = entered

    def is_zone_entered(self, track_id: int) -> bool:
        with self._lock:
            entry = self._tracks.get(track_id)
            return entry.zone_entered if entry else False

    def cleanup(self) -> int:
        """Purge stale tracks and buffer their embeddings for Re-ID."""
        now = time.monotonic()
        if now - self._last_cleanup < 5.0:
            return 0
        self._last_cleanup = now

        purged = 0
        with self._lock:
            stale = [
                tid for tid, e in self._tracks.items()
                if now - e.last_seen > TRACK_STALE_SECONDS
            ]
            for tid in stale:
                entry = self._tracks.pop(tid)
                # Buffer for Re-ID if the track had a known identity
                if entry.person_id and entry.embeddings:
                    self._reid_buffer.on_track_lost(
                        tid, entry.person_id, entry.identity, list(entry.embeddings)
                    )
                purged += 1
        return purged

    def stats(self) -> dict[str, Any]:
        with self._lock:
            total = len(self._tracks)
            identified = sum(1 for e in self._tracks.values() if e.person_id)
            return {
                "totalTracks": total,
                "identifiedTracks": identified,
                "unknownTracks": total - identified,
                "reidBuffered": self._reid_buffer.buffered_count,
            }

    def clear(self) -> None:
        with self._lock:
            self._tracks.clear()


# ────────────────────────────────────────────────────────────────────
# Frame Grabber — Async RTSP capture with GStreamer/OpenCV
# ────────────────────────────────────────────────────────────────────

class _AsyncFrameGrabber:
    """Async wrapper around OpenCV VideoCapture for non-blocking frame reads."""

    def __init__(self, rtsp_url: str, width: int = 960, height: int = 540):
        self._url = rtsp_url
        self._width = width
        self._height = height
        self._cap: cv2.VideoCapture | None = None
        self._consecutive_failures = 0
        self._max_failures = 10

    async def open(self) -> bool:
        """Open the RTSP capture in a thread pool."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._open_sync)

    def _open_sync(self) -> bool:
        self.release_sync()
        try:
            # Try GStreamer pipeline first for hardware acceleration
            gst_pipeline = self._build_gstreamer_pipeline()
            if gst_pipeline:
                self._cap = cv2.VideoCapture(gst_pipeline, cv2.CAP_GSTREAMER)
                if self._cap.isOpened():
                    logger.info("RTSP opened via GStreamer: %s", self._mask_url())
                    return True
                self._cap.release()

            # Fallback to FFmpeg/OpenCV
            self._cap = cv2.VideoCapture(self._url)
            if self._cap and self._cap.isOpened():
                self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                logger.info("RTSP opened via OpenCV: %s", self._mask_url())
                return True

            logger.error("Failed to open RTSP: %s", self._mask_url())
            return False
        except Exception as exc:
            logger.error("RTSP open error: %s — %s", self._mask_url(), exc)
            return False

    def _build_gstreamer_pipeline(self) -> str | None:
        """Build GStreamer pipeline matching the existing ai_service.py logic."""
        backend = os.environ.get("FMS_RTSP_BACKEND", "auto").lower()
        if backend == "opencv":
            return None

        protocol = os.environ.get("FMS_GST_RTSP_PROTOCOL", "tcp")
        latency = os.environ.get("FMS_GST_LATENCY_MS", "120")
        fps = os.environ.get("FMS_GST_AI_FPS", "10")
        drop = os.environ.get("FMS_GST_APPSINK_DROP", "true").lower() == "true"
        max_buf = os.environ.get("FMS_GST_APPSINK_MAX_BUFFERS", "1")

        src = (
            f'rtspsrc location="{self._url}" protocols={protocol} '
            f'latency={latency} drop-on-latency=true ! '
            f'rtph264depay ! h264parse ! avdec_h264 ! '
            f'videorate ! video/x-raw,framerate={fps}/1 ! '
            f'videoscale ! video/x-raw,width={self._width},height={self._height} ! '
            f'videoconvert ! video/x-raw,format=BGR ! '
            f'appsink drop={"true" if drop else "false"} max-buffers={max_buf} sync=false'
        )
        return src

    async def grab(self) -> np.ndarray | None:
        """Grab a single frame, resize for inference. Returns BGR ndarray or None."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._grab_sync)

    def _grab_sync(self) -> np.ndarray | None:
        if self._cap is None or not self._cap.isOpened():
            return None
        ret, frame = self._cap.read()
        if not ret or frame is None:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._max_failures:
                logger.warning("Too many grab failures, releasing capture: %s", self._mask_url())
                self.release_sync()
            return None

        self._consecutive_failures = 0

        # Efficient resize for inference — minimize GPU memory spikes
        h, w = frame.shape[:2]
        if w != self._width or h != self._height:
            frame = cv2.resize(
                frame,
                (self._width, self._height),
                interpolation=cv2.INTER_LINEAR,
            )
        return frame

    def release_sync(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None

    async def release(self) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.release_sync)

    def _mask_url(self) -> str:
        """Mask credentials in RTSP URL for logging."""
        import re
        return re.sub(r'://[^@]+@', '://****:****@', self._url)


# ────────────────────────────────────────────────────────────────────
# Detection result (internal, before proto serialization)
# ────────────────────────────────────────────────────────────────────

@dataclass
class DetectionResult:
    track_id: int
    person_id: str
    person_name: str
    confidence: float
    person_bbox: tuple[float, float, float, float]
    face_bbox: tuple[float, float, float, float] | None = None
    track_cached: bool = False
    is_reidentified: bool = False
    zone_status: str = "unknown"  # "inside", "outside", "entered", "exited"


# ────────────────────────────────────────────────────────────────────
# StreamProcessor — The main async processing loop
# ────────────────────────────────────────────────────────────────────

class StreamProcessor:
    """Async RTSP stream processor with stateful tracking and Re-ID.

    Runs a capture loop per stream, performing:
      1. Frame grab (async, GStreamer/OpenCV)
      2. YOLO person detection + ByteTrack association
      3. InsightFace recognition (only for new/low-confidence tracks)
      4. Re-ID matching for newly appeared tracks
      5. Zone containment check (point-in-polygon)
      6. Yields FrameDetections for each processed frame

    Usage:
        processor = StreamProcessor(models)
        async for detections in processor.run(config, cancel_event):
            send_to_rust(detections)
    """

    def __init__(
        self,
        yolo_model: Any = None,
        insightface_app: Any = None,
        embedding_cache: Any = None,
        bytetrack_config: str | None = None,
    ):
        self._yolo = yolo_model
        self._insightface = insightface_app
        self._embedding_cache = embedding_cache  # (ids, names, matrix) for cosine matching
        self._bytetrack_cfg = bytetrack_config or str(
            Path(__file__).resolve().parent / "bytetrack.yaml"
        )
        self._track_manager = TrackManager()
        self._frame_count: int = 0

    async def run(
        self,
        config: StreamConfig,
        cancel: asyncio.Event | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Main processing loop — yields detection dicts per frame.

        Each yielded dict matches the FrameDetections proto structure.
        """
        grabber = _AsyncFrameGrabber(config.rtsp_url, config.input_width, config.input_height)
        interval = 1.0 / max(0.1, config.target_fps)
        cancel = cancel or asyncio.Event()

        if not await grabber.open():
            logger.error("Cannot open stream %s", config.stream_id)
            return

        logger.info("StreamProcessor started: %s (%.1f FPS)", config.stream_id, config.target_fps)

        try:
            while not cancel.is_set():
                loop_start = time.monotonic()

                frame = await grabber.grab()
                if frame is None:
                    # Attempt reconnect
                    await asyncio.sleep(2.0)
                    if not await grabber.open():
                        await asyncio.sleep(5.0)
                    continue

                self._frame_count += 1

                # Run detection + tracking + recognition in thread pool
                detections = await asyncio.get_event_loop().run_in_executor(
                    None,
                    self._process_frame,
                    frame,
                    config,
                )

                # Build frame result
                identified = sum(1 for d in detections if d.person_id)
                result = {
                    "stream_id": config.stream_id,
                    "zone_id": config.zone_id,
                    "frame_number": self._frame_count,
                    "timestamp_epoch": time.time(),
                    "detections": [self._detection_to_dict(d) for d in detections],
                    "persons_detected": len(detections),
                    "persons_identified": identified,
                    "pipeline": self._pipeline_name(),
                    "inference_ms": (time.monotonic() - loop_start) * 1000,
                }

                yield result

                # Periodic cleanup
                self._track_manager.cleanup()

                # Maintain target FPS
                elapsed = time.monotonic() - loop_start
                sleep_time = interval - elapsed
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            logger.info("StreamProcessor cancelled: %s", config.stream_id)
        except Exception as exc:
            logger.exception("StreamProcessor error on %s: %s", config.stream_id, exc)
        finally:
            await grabber.release()
            self._track_manager.clear()
            logger.info("StreamProcessor stopped: %s", config.stream_id)

    # ── Internal processing ──────────────────────────────────────────

    def _process_frame(
        self, frame: np.ndarray, config: StreamConfig,
    ) -> list[DetectionResult]:
        """Synchronous frame processing — runs in thread pool.

        Pipeline:
          1. YOLO detection + ByteTrack tracking
          2. For each track:
             - If cached with high confidence → skip InsightFace
             - If new → try Re-ID buffer first
             - If still unknown → run InsightFace
          3. Zone containment check
        """
        results: list[DetectionResult] = []

        # Step 1: YOLO + ByteTrack
        tracked_persons = self._detect_and_track(frame, config.max_persons)

        for tp in tracked_persons:
            track_id = tp["track_id"]
            bbox = tp["bbox"]  # (x1, y1, x2, y2)

            # Step 2: Identity resolution
            cached = self._track_manager.get(track_id)
            track_cached = False
            is_reidentified = False
            person_id = ""
            person_name = "Unknown"
            confidence = 0.0
            embedding = None

            if cached and not self._track_manager.needs_recognition(track_id):
                # High-confidence cached identity — skip InsightFace
                person_id = cached.person_id
                person_name = cached.identity
                confidence = cached.confidence
                track_cached = True
            else:
                # Extract face embedding for this person crop
                embedding = self._extract_embedding(frame, bbox)

                if embedding is not None:
                    # Try Re-ID buffer first for new tracks
                    if cached is None:
                        reid_result = self._track_manager.try_reidentify(track_id, embedding)
                        if reid_result:
                            person_id, person_name = reid_result
                            confidence = 0.90
                            is_reidentified = True

                    # If still unknown, run full InsightFace matching
                    if not person_id and self._embedding_cache is not None:
                        match = self._match_embedding(embedding, config.recognition_threshold)
                        if match:
                            person_id, person_name, confidence = match

                    # Update track manager
                    self._track_manager.put(
                        track_id,
                        person_name if person_id else "Unknown",
                        person_id,
                        confidence,
                        embedding,
                    )

            # Step 3: Zone containment
            zone_status = "unknown"
            if config.zone_polygon:
                cx = (bbox[0] + bbox[2]) / 2.0
                by = bbox[3]  # bottom center
                inside = _point_in_polygon(cx, by, config.zone_polygon)
                was_entered = self._track_manager.is_zone_entered(track_id)

                if inside and not was_entered:
                    zone_status = "entered"
                    self._track_manager.set_zone_entered(track_id, True)
                elif inside:
                    zone_status = "inside"
                elif not inside and was_entered:
                    zone_status = "exited"
                    self._track_manager.set_zone_entered(track_id, False)
                else:
                    zone_status = "outside"

            results.append(DetectionResult(
                track_id=track_id,
                person_id=person_id,
                person_name=person_name,
                confidence=confidence,
                person_bbox=bbox,
                track_cached=track_cached,
                is_reidentified=is_reidentified,
                zone_status=zone_status,
            ))

        return results

    def _detect_and_track(
        self, frame: np.ndarray, max_persons: int,
    ) -> list[dict[str, Any]]:
        """Run YOLO detection + ByteTrack tracking.

        Returns list of {"track_id": int, "bbox": (x1,y1,x2,y2), "conf": float}
        """
        if self._yolo is None:
            return []

        try:
            results = self._yolo.track(
                frame,
                persist=True,
                tracker=self._bytetrack_cfg,
                classes=[0],  # person class only
                conf=0.35,
                iou=0.45,
                verbose=False,
            )
        except Exception as exc:
            logger.warning("YOLO track failed: %s", exc)
            return []

        tracked = []
        if results and len(results) > 0:
            r = results[0]
            if r.boxes is not None and r.boxes.id is not None:
                boxes = r.boxes.xyxy.cpu().numpy()
                ids = r.boxes.id.cpu().numpy().astype(int)
                confs = r.boxes.conf.cpu().numpy()

                for i in range(min(len(ids), max_persons)):
                    tracked.append({
                        "track_id": int(ids[i]),
                        "bbox": tuple(float(v) for v in boxes[i]),
                        "conf": float(confs[i]),
                    })

        return tracked

    def _extract_embedding(
        self, frame: np.ndarray, bbox: tuple[float, float, float, float],
    ) -> np.ndarray | None:
        """Extract face embedding from a person's bounding box region.

        Crops the upper portion of the person bbox (head region),
        runs InsightFace to detect the face and extract the 512-dim embedding.
        """
        if self._insightface is None:
            return None

        x1, y1, x2, y2 = [int(v) for v in bbox]
        h, w = frame.shape[:2]
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w, x2)
        y2 = min(h, y2)

        # Crop upper 40% of person bbox for head region
        head_y2 = y1 + int((y2 - y1) * 0.4)
        head_crop = frame[y1:head_y2, x1:x2]

        if head_crop.size == 0:
            return None

        try:
            faces = self._insightface.get(head_crop)
            if not faces:
                # Try full person crop as fallback
                person_crop = frame[y1:y2, x1:x2]
                faces = self._insightface.get(person_crop)

            if faces:
                emb = faces[0].embedding
                norm = np.linalg.norm(emb)
                if norm > 0:
                    return emb / norm
        except Exception as exc:
            logger.debug("Embedding extraction failed: %s", exc)

        return None

    def _match_embedding(
        self, embedding: np.ndarray, threshold: float,
    ) -> tuple[str, str, float] | None:
        """Match embedding against the registered face database.

        Returns (person_id, person_name, score) or None.
        """
        if self._embedding_cache is None:
            return None

        ids, names, matrix = self._embedding_cache
        if matrix is None or len(ids) == 0:
            return None

        # Cosine similarity via matrix multiplication (all faces at once)
        scores = matrix @ embedding
        best_idx = int(np.argmax(scores))
        best_score = float(scores[best_idx])

        if best_score >= threshold:
            return (ids[best_idx], names[best_idx], best_score)

        return None

    @staticmethod
    def _detection_to_dict(d: DetectionResult) -> dict[str, Any]:
        return {
            "track_id": d.track_id,
            "person_id": d.person_id,
            "person_name": d.person_name,
            "confidence": d.confidence,
            "person_bbox": list(d.person_bbox),
            "face_bbox": list(d.face_bbox) if d.face_bbox else None,
            "track_cached": d.track_cached,
            "is_reidentified": d.is_reidentified,
            "zone_status": d.zone_status,
        }

    def _pipeline_name(self) -> str:
        parts = []
        if self._yolo is not None:
            parts.append("yolo26+bytetrack")
        if self._insightface is not None:
            parts.append("insightface")
        return "+".join(parts) or "none"

    @property
    def track_stats(self) -> dict[str, Any]:
        return self._track_manager.stats()


# ────────────────────────────────────────────────────────────────────
# Zone geometry — Python-side point-in-polygon (mirrors Rust impl)
# ────────────────────────────────────────────────────────────────────

def _point_in_polygon(px: float, py: float, polygon: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test."""
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside
