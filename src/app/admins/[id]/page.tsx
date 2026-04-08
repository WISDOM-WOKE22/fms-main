import AdminDetailPage from "@/modules/admins/pages/AdminDetailPage/AdminDetailPage";

/** Required for static export (Tauri build). Return placeholder so route is pre-rendered; app resolves real id client-side. */
export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function Page() {
  return <AdminDetailPage />;
}
