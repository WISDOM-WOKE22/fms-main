# FMS Backend — Rust Architecture

The FMS backend is now a high-performance, in-process API server built with **Rust** and **Axum**. This replaces the legacy Python (FastAPI) implementation.

---

## Architecture Overview

The backend is integrated directly into the Tauri application (`src-tauri`). When the application starts, it:
1. Initializes a local **SQLite** database.
2. Runs necessary database migrations.
3. Spawns an **Axum** HTTP server on a dynamic local port.
4. Communicates the port to the Next.js frontend via a Tauri command.

### Key Components

- **Axum**: Handles HTTP routing and requests.
- **Rusqlite**: Provides a synchronous (but wrapped in async tasks) interface to SQLite.
- **Tower-HTTP**: Provides middleware for CORS, logging, and panic recovery.
- **Serde**: Handles JSON serialization and deserialization.

---

## Development Workflow

### Starting the Application

To start both the frontend and the Rust backend in development mode:

```bash
pnpm tauri dev
```

The frontend (Next.js) will start on `localhost:3000`, and the Rust backend will start on a dynamic port (e.g., `localhost:12345`).

### Database Management

Database migrations and schema management are handled by the Rust code at runtime. The database file is stored in the application data directory:
- **macOS**: `~/Library/Application Support/com.wisdom.fms-main/fms.db`
- **Windows**: `%APPDATA%\com.wisdom.fms-main\fms.db`
- **Linux**: `~/.local/share/com.wisdom.fms-main/fms.db`

---

## API Endpoints

The Rust API maintains a compatible contract with the previous Python implementation:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check & DB status |
| GET | `/api/v1/admins` | List administrators |
| POST | `/api/v1/admins` | Create administrator |
| GET | `/api/v1/zones` | List zones |
| GET | `/api/v1/employees` | List employees |
| GET | `/api/v1/dashboard/stats` | Dashboard overview statistics |

---

## Security

- **Password Hashing**: Uses `bcrypt` for secure storage of administrative credentials.
- **CORS**: Restricted to local communication within the Tauri context.
- **In-Process**: The API server is only accessible on `127.0.0.1` and is destroyed when the application closes.
