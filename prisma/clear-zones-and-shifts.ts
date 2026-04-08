/**
 * Clear all zone and shift data (and dependent employees + activities) from the database.
 * Deletion order: employee_activities → employees → shifts → zones.
 * Run: pnpm db:clear-zones-shifts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.employeeActivity.deleteMany({});
  const employees = await prisma.employee.deleteMany({});
  const shifts = await prisma.shift.deleteMany({});
  const zones = await prisma.zone.deleteMany({});
  console.log(
    `Cleared: ${employees.count} employee(s), ${shifts.count} shift(s), ${zones.count} zone(s).`
  );
}

main()
  .catch((e) => {
    console.error("Clear zones/shifts failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
