-- Remove zone from shifts: drop zoneId and Zone relation, make shift name globally unique.
-- SQLite does not support DROP COLUMN; recreate table and copy data.

PRAGMA foreign_keys=OFF;

-- Create new shifts table without zoneId
CREATE TABLE "shifts_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "breakTime" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Copy existing data (drop zoneId)
INSERT INTO "shifts_new" ("id", "name", "breakTime", "status", "createdBy", "createdAt")
SELECT "id", "name", "breakTime", "status", "createdBy", "createdAt" FROM "shifts";

-- Replace old table
DROP TABLE "shifts";
ALTER TABLE "shifts_new" RENAME TO "shifts";

-- Unique constraint on shift name
CREATE UNIQUE INDEX "shifts_name_key" ON "shifts"("name");

-- Re-enable foreign keys (employees.shiftId still references shifts.id)
PRAGMA foreign_keys=ON;
