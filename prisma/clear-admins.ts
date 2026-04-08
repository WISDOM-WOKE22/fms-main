/**
 * Clear all admins from the database.
 * Run: pnpm db:clear-admins
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.admin.deleteMany({});
  console.log(`Cleared ${result.count} admin(s) from the database.`);
}

main()
  .catch((e) => {
    console.error("Clear admins failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
