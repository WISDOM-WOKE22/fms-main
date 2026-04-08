import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding demo data for People Log, shifts, employees…");

  // Wipe existing demo data
  await prisma.accessLog.deleteMany();
  await prisma.employeeActivity.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.zone.deleteMany();

  // Zones
  const mainGate = await prisma.zone.create({
    data: {
      name: "Main Gate",
      status: "active",
      cameraIds: JSON.stringify(["cam1"]),
      createdBy: "Seed",
    },
  });
  const buildingA = await prisma.zone.create({
    data: {
      name: "Building A",
      status: "active",
      cameraIds: JSON.stringify(["cam2"]),
      createdBy: "Seed",
    },
  });
  const buildingB = await prisma.zone.create({
    data: {
      name: "Building B",
      status: "active",
      cameraIds: JSON.stringify(["cam3"]),
      createdBy: "Seed",
    },
  });

  // Shifts (mapped to front‑end demo: Morning, Evening, Night, 24/7)
  const morning = await prisma.shift.create({
    data: {
      name: "Morning Shift",
      description: "09:00–17:00, 60‑minute break",
      breakTime: "60", // minutes, non‑zero => Break = Yes
      status: "active",
      createdBy: "Seed",
    },
  });

  const morningShort = await prisma.shift.create({
    data: {
      name: "Morning Short Break",
      description: "08:00–16:00, 30‑minute break",
      breakTime: "30",
      status: "active",
      createdBy: "Seed",
    },
  });

  const evening = await prisma.shift.create({
    data: {
      name: "Evening Shift",
      description: "14:00–22:00, 45‑minute break",
      breakTime: "45",
      status: "active",
      createdBy: "Seed",
    },
  });

  const nightNoBreak = await prisma.shift.create({
    data: {
      name: "Night Shift (No Break)",
      description: "22:00–06:00, no scheduled break",
      breakTime: "0", // => Break = No
      status: "active",
      createdBy: "Seed",
    },
  });

  const coverage247 = await prisma.shift.create({
    data: {
      name: "24/7 Coverage",
      description: "Continuous coverage schedule",
      breakTime: "0", // treated as 24/7 in UI
      status: "active",
      createdBy: "Seed",
    },
  });

  // Employees mapped to these shifts
  const sarah = await prisma.employee.create({
    data: {
      name: "Sarah Chen",
      email: "sarah@example.com",
      phone: "555-0001",
      department: "Security",
      status: "checked-out",
      isActive: true,
      joinedDate: new Date("2024-01-10"),
      zoneId: mainGate.id,
      shiftId: morning.id,
    },
  });

  const james = await prisma.employee.create({
    data: {
      name: "James Okonkwo",
      email: "james@example.com",
      phone: "555-0002",
      department: "Security",
      status: "checked-out",
      isActive: true,
      joinedDate: new Date("2024-01-10"),
      zoneId: buildingA.id,
      shiftId: morningShort.id,
    },
  });

  const amina = await prisma.employee.create({
    data: {
      name: "Amina Hassan",
      email: "amina@example.com",
      phone: "555-0003",
      department: "Security",
      status: "checked-out",
      isActive: true,
      joinedDate: new Date("2024-02-15"),
      zoneId: mainGate.id,
      shiftId: evening.id,
    },
  });

  const michael = await prisma.employee.create({
    data: {
      name: "Michael Brown",
      email: "michael@example.com",
      phone: "555-0004",
      department: "Security",
      status: "checked-out",
      isActive: true,
      joinedDate: new Date("2024-01-12"),
      zoneId: buildingB.id,
      shiftId: nightNoBreak.id,
    },
  });

  const priya = await prisma.employee.create({
    data: {
      name: "Priya Sharma",
      email: "priya@example.com",
      phone: "555-0005",
      department: "Security",
      status: "checked-out",
      isActive: true,
      joinedDate: new Date("2024-03-01"),
      zoneId: mainGate.id,
      shiftId: evening.id,
    },
  });

  const david = await prisma.employee.create({
    data: {
      name: "David Kim",
      email: "david@example.com",
      phone: "555-0006",
      department: "Security",
      status: "checked-out",
      isActive: true,
      joinedDate: new Date("2024-02-20"),
      zoneId: buildingA.id,
      shiftId: coverage247.id,
    },
  });

  // Helper to create an access log + matching EmployeeActivity.
  async function logEvent(args: {
    employee: typeof sarah;
    zone: typeof mainGate;
    action: "check-in" | "check-out";
    at: string; // ISO date time
    breakValue: "yes" | "no" | "none";
    breakStatus: "on_time_for_break" | "late_for_break" | "returned_on_time" | "late_return" | "none";
  }) {
    const ts = new Date(args.at);
    await prisma.employeeActivity.create({
      data: {
        type: args.action,
        date: ts,
        time: ts.toISOString().slice(11, 16),
        zoneId: args.zone.id,
        employeeId: args.employee.id,
      },
    });

    // Encode schedule + break info into metadata JSON so the API layer
    // can surface it to the People Log if desired.
    await prisma.accessLog.create({
      data: {
        employeeId: args.employee.id,
        zoneId: args.zone.id,
        action: args.action,
        timestamp: ts,
        metadata: JSON.stringify({
          scheduleName: (await prisma.shift.findUnique({ where: { id: args.employee.shiftId } }))?.name,
          break: args.breakValue,
          breakStatus: args.breakStatus,
        }),
      },
    });
  }

  // Morning Shift (Sarah) – Break = Yes, Break Status examples:
  await logEvent({
    employee: sarah,
    zone: mainGate,
    action: "check-in",
    at: "2025-03-02T09:05:00.000Z",
    breakValue: "yes",
    breakStatus: "late_return",
  });
  await logEvent({
    employee: sarah,
    zone: mainGate,
    action: "check-out",
    at: "2025-03-02T17:02:00.000Z",
    breakValue: "yes",
    breakStatus: "late_return",
  });

  // Morning Short Break (James) – On Time for Break
  await logEvent({
    employee: james,
    zone: buildingA,
    action: "check-in",
    at: "2025-03-02T08:55:00.000Z",
    breakValue: "yes",
    breakStatus: "on_time_for_break",
  });
  await logEvent({
    employee: james,
    zone: buildingA,
    action: "check-out",
    at: "2025-03-02T16:05:00.000Z",
    breakValue: "yes",
    breakStatus: "on_time_for_break",
  });

  // Evening Shift (Amina) – Late for Break
  await logEvent({
    employee: amina,
    zone: mainGate,
    action: "check-in",
    at: "2025-03-02T14:02:00.000Z",
    breakValue: "yes",
    breakStatus: "late_for_break",
  });
  await logEvent({
    employee: amina,
    zone: mainGate,
    action: "check-out",
    at: "2025-03-02T22:10:00.000Z",
    breakValue: "yes",
    breakStatus: "late_for_break",
  });

  // Night Shift (no break) – Break = No, Break Status => "—"
  await logEvent({
    employee: michael,
    zone: buildingB,
    action: "check-in",
    at: "2025-03-02T22:01:00.000Z",
    breakValue: "no",
    breakStatus: "none",
  });
  await logEvent({
    employee: michael,
    zone: buildingB,
    action: "check-out",
    at: "2025-03-03T06:00:00.000Z",
    breakValue: "no",
    breakStatus: "none",
  });

  // Evening Shift (Priya) – Returned On Time
  await logEvent({
    employee: priya,
    zone: mainGate,
    action: "check-in",
    at: "2025-03-01T14:10:00.000Z",
    breakValue: "yes",
    breakStatus: "returned_on_time",
  });
  await logEvent({
    employee: priya,
    zone: mainGate,
    action: "check-out",
    at: "2025-03-01T21:55:00.000Z",
    breakValue: "yes",
    breakStatus: "returned_on_time",
  });

  // 24/7 Coverage (David) – Break = None, Break Status => "—"
  await logEvent({
    employee: david,
    zone: buildingA,
    action: "check-in",
    at: "2025-02-28T08:35:00.000Z",
    breakValue: "none",
    breakStatus: "none",
  });
  await logEvent({
    employee: david,
    zone: buildingA,
    action: "check-out",
    at: "2025-02-28T20:40:00.000Z",
    breakValue: "none",
    breakStatus: "none",
  });

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
