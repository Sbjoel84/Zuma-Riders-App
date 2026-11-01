import { Injectable } from "@nestjs/common";
import type { DriverOnboardBody, VehicleBody } from "@zuma/contracts";
import { fail } from "../../common/errors";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { WalletService } from "../ledger/wallet.service";

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
  ) {}

  async onboard(userId: string, body: DriverOnboardBody) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.firstName) fail("PROFILE_INCOMPLETE", "Add your name first");
    const city = await this.prisma.db.city.findUnique({ where: { key: body.cityKey } });
    if (!city || !city.isLive) fail("OUTSIDE_SERVICE_AREA", "We're not live in that city yet");
    const driver = await this.prisma.db.driver.upsert({
      where: { userId },
      update: { licenceNumber: body.licenceNumber, licenceExpiresAt: new Date(body.licenceExpiresAt), addressLine: body.addressLine },
      create: {
        userId, cityId: city!.id, licenceNumber: body.licenceNumber, licenceExpiresAt: new Date(body.licenceExpiresAt),
        addressLine: body.addressLine, verificationStatus: "PENDING_REVIEW",
      },
    });
    await this.wallets.ensureWallet(userId, "DRIVER");
    return this.me(userId).then((m) => m ?? driver);
  }

  async addVehicle(userId: string, body: VehicleBody) {
    const driver = await this.prisma.db.driver.findUnique({ where: { userId } });
    if (!driver) fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
    const category = await this.prisma.db.vehicleCategory.findUnique({ where: { key: body.categoryKey } });
    const enabled = category && (await this.prisma.db.cityVehicleCategory.findUnique({ where: { cityId_categoryId: { cityId: driver!.cityId, categoryId: category.id } } }));
    if (!category || !enabled?.isEnabled) fail("CATEGORY_UNAVAILABLE", "That vehicle category is not available in your city");
    if (category!.minYear && body.year < category!.minYear) fail("VALIDATION_FAILED", `${category!.name} needs a ${category!.minYear} or newer vehicle`);
    const plate = body.plateNumber.replace(/[- ]/g, "").replace(/^([A-Z]{3})(\d{2,3})([A-Z]{2})$/, "$1 $2 $3");
    try {
      return await this.prisma.db.vehicle.create({
        data: { driverId: driver!.id, categoryId: category!.id, make: body.make, model: body.model, year: body.year, colour: body.colour, plateNumber: plate },
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("VALIDATION_FAILED", "A vehicle with this plate number is already registered");
      throw e;
    }
  }

  async setActiveVehicle(userId: string, vehicleId: string) {
    const driver = await this.prisma.db.driver.findUnique({ where: { userId } });
    const v = await this.prisma.db.vehicle.findUnique({ where: { id: vehicleId } });
    if (!driver || !v || v.driverId !== driver.id) fail("NOT_FOUND", "Vehicle not found");
    if (v!.status !== "APPROVED") fail("NO_ACTIVE_VEHICLE", "This vehicle has not been approved yet");
    await this.prisma.db.driver.update({ where: { id: driver!.id }, data: { activeVehicleId: v!.id } });
    return this.me(userId);
  }

  async me(userId: string) {
    const d = await this.prisma.db.driver.findUnique({
      where: { userId },
      include: { vehicles: { where: { deletedAt: null }, include: { category: true }, orderBy: { createdAt: "asc" } }, availability: true, city: true },
    });
    if (!d) return null;
    return {
      id: d.id,
      city: d.city.name,
      verificationStatus: d.verificationStatus,
      activeVehicleId: d.activeVehicleId,
      licenceNumber: d.licenceNumber,
      ratingAvg: d.ratingAvg.toString(),
      tripsCompleted: d.tripsCompleted,
      availability: d.availability?.status ?? "OFFLINE",
      suspendedUntil: d.suspendedUntil?.toISOString() ?? null,
      vehicles: d.vehicles.map((v) => ({ id: v.id, make: v.make, model: v.model, year: v.year, colour: v.colour, plateNumber: v.plateNumber, categoryKey: v.category.key, categoryName: v.category.name, status: v.status, rejectionReason: v.rejectionReason })),
    };
  }
}
