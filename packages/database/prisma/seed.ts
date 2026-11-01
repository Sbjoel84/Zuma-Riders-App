/**
 * Seed: reference data needed for the platform to run (roles, permissions,
 * Abuja, its service area, vehicle categories, pricing v1, system ledger accounts)
 * plus one super admin identified by SEED_ADMIN_PHONE.
 *
 * Idempotent: safe to run repeatedly.
 * Run: pnpm --filter @zuma/database seed
 */
import "dotenv/config";
import { createPrismaClient } from "../src";

const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL! });

const naira = (n: number) => BigInt(Math.round(n * 100));

const PERMISSIONS = [
  "dashboard:read",
  "passengers:read", "passengers:write",
  "drivers:read", "drivers:write", "drivers:verify",
  "rides:read", "rides:write",
  "ops:live",
  "pricing:write", "config:write",
  "finance:read", "finance:refund", "finance:payout", "finance:adjust",
  "marketing:write", "support:write", "disputes:write", "safety:write",
  "notifications:send", "rbac:write", "audit:read",
];

const ROLES: Array<{ key: string; name: string; scope: "PASSENGER" | "DRIVER" | "ADMIN"; perms: string[] }> = [
  { key: "passenger", name: "Passenger", scope: "PASSENGER", perms: [] },
  { key: "driver", name: "Driver", scope: "DRIVER", perms: [] },
  { key: "super_admin", name: "Super admin", scope: "ADMIN", perms: PERMISSIONS },
  { key: "ops_agent", name: "Ops agent", scope: "ADMIN", perms: ["dashboard:read", "rides:read", "rides:write", "ops:live", "drivers:read", "passengers:read", "safety:write"] },
  { key: "verification_officer", name: "Verification officer", scope: "ADMIN", perms: ["dashboard:read", "drivers:read", "drivers:verify"] },
  { key: "finance", name: "Finance", scope: "ADMIN", perms: ["dashboard:read", "finance:read", "finance:refund", "finance:payout", "finance:adjust"] },
  { key: "support_agent", name: "Support agent", scope: "ADMIN", perms: ["dashboard:read", "rides:read", "passengers:read", "drivers:read", "support:write", "disputes:write"] },
];

const CATEGORIES = [
  { key: "economy", name: "Economy", seats: 4, sortOrder: 1, minYear: 2010, enabled: true },
  { key: "comfort", name: "Comfort", seats: 4, sortOrder: 2, minYear: 2014, enabled: true },
  { key: "premium", name: "Premium", seats: 4, sortOrder: 3, minYear: 2017, enabled: true },
  { key: "suv", name: "SUV", seats: 6, sortOrder: 4, minYear: 2014, enabled: true },
  // Off until the FCT legal review is done (see README decision #4).
  { key: "motorcycle", name: "Motorcycle", seats: 1, sortOrder: 5, minYear: 2015, enabled: false },
  { key: "tricycle", name: "Tricycle", seats: 3, sortOrder: 6, minYear: 2015, enabled: false },
];

// Pricing v1 (₦). Commission rate is a placeholder pending the owner's decision.
const PRICING: Record<string, { base: number; km: number; min: number; minFare: number; maxFare: number; floorKm: number }> = {
  economy: { base: 500, km: 120, min: 15, minFare: 1200, maxFare: 25000, floorKm: 60 },
  comfort: { base: 700, km: 160, min: 20, minFare: 1600, maxFare: 35000, floorKm: 80 },
  premium: { base: 1200, km: 240, min: 30, minFare: 2500, maxFare: 60000, floorKm: 120 },
  suv: { base: 1400, km: 280, min: 35, minFare: 3000, maxFare: 70000, floorKm: 140 },
  motorcycle: { base: 200, km: 60, min: 8, minFare: 500, maxFare: 8000, floorKm: 30 },
  tricycle: { base: 250, km: 70, min: 8, minFare: 600, maxFare: 9000, floorKm: 35 },
};

const SYSTEM_ACCOUNTS: Array<{ purpose: string; type: string }> = [
  { purpose: "PLATFORM_COMMISSION_REVENUE", type: "REVENUE" },
  { purpose: "PLATFORM_CANCELLATION_REVENUE", type: "REVENUE" },
  { purpose: "PROMO_EXPENSE", type: "EXPENSE" },
  { purpose: "REFERRAL_EXPENSE", type: "EXPENSE" },
  { purpose: "PAYSTACK_CLEARING", type: "ASSET" },
  { purpose: "FLUTTERWAVE_CLEARING", type: "ASSET" },
  { purpose: "BANK_PAYOUT_CLEARING", type: "LIABILITY" },
  { purpose: "PROVIDER_FEES_EXPENSE", type: "EXPENSE" },
  { purpose: "SUSPENSE", type: "LIABILITY" },
];

// Abuja metro service area (lng lat). Covers the city centre, Kubwa, Lugbe, Gwarinpa and the airport.
const ABUJA_POLYGON = "MULTIPOLYGON(((7.15 8.85, 7.65 8.85, 7.65 9.30, 7.15 9.30, 7.15 8.85)))";

async function main() {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name },
      create: { key: r.key, name: r.name, scope: r.scope, isSystem: true },
    });
    for (const pk of r.perms) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key: pk } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }

  const abuja = await prisma.city.upsert({
    where: { key: "abuja" },
    update: {},
    create: {
      key: "abuja", name: "Abuja", state: "FCT", centerLat: 9.0579, centerLng: 7.4951, isLive: true,
      supportContacts: { emergencyNumbers: ["112", "199"] },
    },
  });

  const categoryIds: Record<string, string> = {};
  for (const c of CATEGORIES) {
    const cat = await prisma.vehicleCategory.upsert({
      where: { key: c.key },
      update: {},
      create: { key: c.key, name: c.name, seats: c.seats, sortOrder: c.sortOrder, minYear: c.minYear },
    });
    categoryIds[c.key] = cat.id;
    await prisma.cityVehicleCategory.upsert({
      where: { cityId_categoryId: { cityId: abuja.id, categoryId: cat.id } },
      update: {},
      create: {
        cityId: abuja.id, categoryId: cat.id, isEnabled: c.enabled,
        legalNote: c.enabled ? null : "Pending legal review of FCT commercial motorcycle/tricycle restrictions",
      },
    });
  }

  let area = await prisma.serviceArea.findFirst({ where: { cityId: abuja.id, name: "Abuja Metro" } });
  if (!area) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "ServiceArea" (id, "cityId", name, boundary, status, "restrictedCategoryKeys", "searchRadiusM", "maxSearchRadiusM", "radiusStepM", "updatedAt")
      VALUES (gen_random_uuid()::text, ${abuja.id}, 'Abuja Metro', ST_GeogFromText(${ABUJA_POLYGON}), 'ACTIVE', ARRAY['motorcycle','tricycle'], 3000, 9000, 1500, now())
      RETURNING id`;
    area = await prisma.serviceArea.findUniqueOrThrow({ where: { id: rows[0]!.id } });
  }

  for (const [key, p] of Object.entries(PRICING)) {
    const existing = await prisma.pricingConfiguration.findFirst({
      where: { serviceAreaId: area.id, categoryId: categoryIds[key], effectiveTo: null },
    });
    if (!existing) {
      await prisma.pricingConfiguration.create({
        data: {
          serviceAreaId: area.id, categoryId: categoryIds[key]!, version: 1,
          baseFare: naira(p.base), perKm: naira(p.km), perMinute: naira(p.min),
          minFare: naira(p.minFare), maxFare: naira(p.maxFare), minFarePerKm: naira(p.floorKm),
          cancellationFeePassenger: naira(500), cancellationFeeDriver: 0n,
          commissionBps: 1500, changeReason: "Launch pricing (seed)",
        },
      });
    }
  }

  for (const a of SYSTEM_ACCOUNTS) {
    const code = `SYS:${a.purpose}:NGN`;
    await prisma.ledgerAccount.upsert({
      where: { code },
      update: {},
      create: { code, purpose: a.purpose as never, type: a.type as never },
    });
  }

  const adminPhone = process.env.SEED_ADMIN_PHONE;
  if (adminPhone) {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    const user = await prisma.user.upsert({
      where: { phoneE164: adminPhone },
      update: {},
      create: {
        phoneE164: adminPhone, firstName: "Ops", lastName: "Lead", status: "ACTIVE",
        referralCode: "ADMIN" + adminPhone.slice(-4), phoneVerifiedAt: new Date(),
      },
    });
    await prisma.adminProfile.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id, jobTitle: "Operations lead" } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: superAdmin.id } },
      update: {},
      create: { userId: user.id, roleId: superAdmin.id },
    });
  }

  console.log("Seed complete: Abuja, service area, 6 categories, pricing v1, roles, system ledger accounts.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
