# FMS Local AI Service (Python)

This service runs locally on the desktop and provides:

- Face registration (`/register/json`)
- Face recognition (`/recognize/json`)
- Health check (`/health`)

Models:

- MediaPipe Face Mesh (quality gate / framing checks)
- InsightFace (face embedding)

## Run locally

```bash
cd src-tauri/resources/ai-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn ai_service:app --host 127.0.0.1 --port 8000
```

Set desktop env config:

```bash
FMS_LOCAL_AI_URL=http://127.0.0.1:8000
```
