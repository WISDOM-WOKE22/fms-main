export type ExportFormat = "pdf" | "excel" | "csv";

export type ExportDataType =
  | "accessLogs"
  | "employeeCheckIn"
  | "peopleCount"
  | "peopleType"
  | "performance"
  | "auditLogs"
  | "zones"
  | "shifts";

export interface ExportSettings {
  format: ExportFormat;
  dataTypes: Record<ExportDataType, boolean>;
}
