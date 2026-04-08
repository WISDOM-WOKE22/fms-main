"use client";

import { isTauri } from "@/core/tauri/isTauri";
import { saveAs } from "file-saver";

/**
 * Save a blob to a file. In the Tauri desktop app, opens a native save dialog
 * and writes the file to the chosen path. In the browser, triggers a download
 * with the given filename.
 */
export async function saveFile(blob: Blob, defaultFilename: string): Promise<void> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const ext = defaultFilename.includes(".") ? defaultFilename.split(".").pop()! : "bin";
    const filterName = ext === "pdf" ? "PDF" : ext === "csv" ? "CSV" : ext.toUpperCase();
    try {
      const path = await save({
        defaultPath: defaultFilename,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (path == null) {
        throw new Error("Save was cancelled.");
      }
      const buffer = await blob.arrayBuffer();
      await writeFile(path, new Uint8Array(buffer));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to write file.";
      throw new Error(`Desktop save failed: ${message}`);
    }
  }
  saveAs(blob, defaultFilename);
}
