"use client";

import { useParams } from "next/navigation";
import AddShiftPage from "@/modules/shifts/pages/AddShiftPage/AddShiftPage";

export default function EditShiftClient() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : undefined;
  return <AddShiftPage editId={id} />;
}
