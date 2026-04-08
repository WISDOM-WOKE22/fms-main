import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h1>404 — Page not found</h1>
      <p>The page you are looking for does not exist.</p>
      <Link href="/">Return home</Link>
    </div>
  );
}
