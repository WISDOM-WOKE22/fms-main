import EditShiftClient from "./EditShiftClient";

/** Required for static export (Tauri build). Return placeholder so route is pre-rendered; app resolves real id client-side. */
export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function EditShiftRoute() {
  return <EditShiftClient />;
}
