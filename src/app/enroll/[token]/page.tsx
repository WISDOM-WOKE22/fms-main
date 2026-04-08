import { EnrollFacePage } from "@/modules/employees/pages/EnrollFacePage/EnrollFacePage";

/** Static export (Tauri): pre-render placeholder; real token is read client-side from the URL. */
export function generateStaticParams() {
  return [{ token: "placeholder" }];
}

export default function Page() {
  return <EnrollFacePage />;
}
