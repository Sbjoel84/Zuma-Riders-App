/**
 * Approve a driver and their vehicles for local testing, until the admin dashboard ships.
 *   pnpm --filter @zuma/api approve-driver 0803 123 4567
 * Refuses to run when NODE_ENV=production. Writes an AdminActionLog row as the seeded admin.
 */
import "dotenv/config";
import { normalizeNigerianPhone } from "@zuma/contracts";
import { createPrismaClient } from "@zuma/database";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Use the admin dashboard in production");
  const phone = normalizeNigerianPhone(process.argv.slice(2).join(""));
  if (!phone) throw new Error("Usage: approve-driver <phone>");
  const db = createPrismaClient({ connectionString: process.env.DATABASE_URL!, quiet: true });
  const user = await db.user.findUnique({ where: { phoneE164: phone }, include: { driver: { include: { vehicles: true } } } });
  if (!user?.driver) throw new Error(`No driver registration for ${phone}. Finish onboarding in the driver app first.`);
  const d = user.driver;
  if (!d.vehicles.length) throw new Error("This driver has not added a vehicle yet");
  const admin = await db.adminProfile.findFirst();
  await db.$transaction(async (tx) => {
    await tx.driver.update({ where: { id: d.id }, data: { verificationStatus: "APPROVED", approvedAt: new Date(), activeVehicleId: d.activeVehicleId ?? d.vehicles[0]!.id } });
    await tx.vehicle.updateMany({ where: { driverId: d.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    await tx.driverVerification.create({ data: { driverId: d.id, fromStatus: d.verificationStatus, toStatus: "APPROVED", reviewerId: admin?.id, notes: "Approved with approve-driver script (development)" } });
    if (admin) await tx.adminActionLog.create({ data: { adminId: admin.id, action: "drivers.approve", targetType: "Driver", targetId: d.id, reason: "dev script" } });
  });
  console.log(`Approved ${user.firstName} (${phone}) with ${d.vehicles.length} vehicle(s). They can go online now.`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
