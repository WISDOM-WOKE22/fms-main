export type ZoneStatus = "active" | "inactive";

/** Maximum number of zones that can be assigned per location. */
export const MAX_ZONES_PER_LOCATION = 10;

/** Supported DVR camera vendors. */
export type CameraVendor = "hikvision" | "dahua" | "generic";

/** Stream quality type. */
export type StreamType = "main" | "sub";

/** Zone (child of a location) with camera configuration. */
export interface ZoneConfig {
  name: string;
  ip: string;
  rtsp: string;
  // DVR camera integration fields (optional for backward compat)
  vendor?: CameraVendor;
  dvrIp?: string;
  rtspPort?: number;
  channelId?: number;
  streamType?: StreamType;
  username?: string;
  password?: string;
  rtspPath?: string;
  /** True when the backend has a stored password (never sent as plaintext). */
  hasPassword?: boolean;
}

export interface ZoneRow {
  id: string;
  name: string;
  assignedShifts: number;
  assignedEmployees: number;
  createdBy: string;
  status: ZoneStatus;
  dateCreated: string;
  /** Zones with camera IP and RTSP URL. */
  zones: ZoneConfig[];
}

type LegacyZoneCameraConfig = Partial<Omit<ZoneConfig, "name">>;
type ZoneConfigLike = Partial<ZoneConfig> | LegacyZoneCameraConfig;

export function createEmptyZone(index: number): ZoneConfig {
  return {
    name: `Zone ${index + 1}`,
    ip: "",
    rtsp: "",
    vendor: "generic",
  };
}

export function normalizeZoneZones(zones?: ZoneConfigLike[] | null): ZoneConfig[] {
  if (!Array.isArray(zones)) return [];
  return zones.map((item, index) => ({
    name:
      typeof (item as Partial<ZoneConfig>)?.name === "string" &&
      (item as Partial<ZoneConfig>).name?.trim()
        ? (item as Partial<ZoneConfig>).name as string
        : `Zone ${index + 1}`,
    ip: typeof item?.ip === "string" ? item.ip : "",
    rtsp: typeof item?.rtsp === "string" ? item.rtsp : "",
    vendor: (item as ZoneConfig)?.vendor || "generic",
    dvrIp: (item as ZoneConfig)?.dvrIp || "",
    rtspPort: (item as ZoneConfig)?.rtspPort || 554,
    channelId: (item as ZoneConfig)?.channelId || 1,
    streamType: (item as ZoneConfig)?.streamType || "main",
    username: (item as ZoneConfig)?.username || "",
    password: (item as ZoneConfig)?.password || "",
    rtspPath: (item as ZoneConfig)?.rtspPath || "",
    hasPassword: (item as ZoneConfig)?.hasPassword || false,
  }));
}

/** Whether the zone is using DVR advanced mode (vendor != generic or has dvrIp). */
export function isDvrMode(zone: ZoneConfig): boolean {
  return (
    (!!zone.vendor && zone.vendor !== "generic") ||
    !!zone.dvrIp?.trim()
  );
}

/** Build a preview RTSP URL client-side (mirrors backend logic). */
export function buildRtspPreview(cfg: ZoneConfig): string {
  const vendor = cfg.vendor || "generic";
  const ip = cfg.dvrIp?.trim() || cfg.ip?.trim() || "";
  const port = cfg.rtspPort || 554;
  const channel = cfg.channelId || 1;
  const user = cfg.username?.trim() || "";
  const pass = cfg.password ? "****" : "";
  const auth = user ? `${user}:${pass}@` : "";

  if (vendor === "hikvision") {
    const stream = cfg.streamType === "sub" ? 2 : 1;
    return `rtsp://${auth}${ip}:${port}/Streaming/Channels/${channel}0${stream}`;
  }
  if (vendor === "dahua") {
    const subtype = cfg.streamType === "sub" ? 1 : 0;
    return `rtsp://${auth}${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
  }
  // generic: use raw rtsp if present
  if (cfg.rtsp?.trim()) return cfg.rtsp.trim();
  const path = cfg.rtspPath?.trim() || "stream1";
  return `rtsp://${auth}${ip}:${port}/${path.replace(/^\//, "")}`;
}

/** Vendor display labels. */
export const VENDOR_OPTIONS: { value: CameraVendor; label: string }[] = [
  { value: "generic", label: "Generic / Manual" },
  { value: "hikvision", label: "Hikvision" },
  { value: "dahua", label: "Dahua" },
];

/** Stream type options. */
export const STREAM_TYPE_OPTIONS: { value: StreamType; label: string }[] = [
  { value: "main", label: "Main Stream" },
  { value: "sub", label: "Sub Stream" },
];
