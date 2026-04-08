/**
 * Clear all employees and their activities from the database.
 * Run: pnpm db:clear-employees
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.employeeActivity.deleteMany({});
  const result = await prisma.employee.deleteMany({});
  console.log(`Cleared ${result.count} employee(s) from the database.`);
}

main()
  .catch((e) => {
    console.error("Clear employees failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
