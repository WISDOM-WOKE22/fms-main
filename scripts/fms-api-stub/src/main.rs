// Stub executable for Windows cross-builds. When building the Tauri app for
// x86_64-pc-windows-msvc from macOS/Linux, the Python backend cannot be built
// (PyInstaller produces host binaries). This stub satisfies the externalBin
// requirement so the build succeeds. For a full Windows build with the real
// API, build the Python backend on Windows and replace this binary.
fn main() {
    std::process::exit(0);
}
