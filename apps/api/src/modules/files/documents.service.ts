import { Injectable } from "@nestjs/common";
import type { DocumentStatus, DriverDocumentType, VehicleDocumentType } from "@zuma/database";
import { env } from "../../config/env";
import { DomainError, fail } from "../../common/errors";
import { PrismaService } from "../../infra/prisma.service";
import { MAX_UPLOAD_BYTES, StorageService } from "../../infra/storage.service";
import { NotificationsService } from "../notifications/notifications.service";

export const DRIVER_DOCS: Array<{ type: DriverDocumentType; label: string; hint: string; needsNumber: boolean; needsExpiry: boolean }> = [
  { type: "DRIVERS_LICENCE", label: "Driver's licence", hint: "Front of your FRSC licence, all four corners visible", needsNumber: true, needsExpiry: true },
  { type: "NATIONAL_ID", label: "NIN slip or national ID", hint: "Your NIN slip, national ID card, voter's card or international passport", needsNumber: true, needsExpiry: false },
  { type: "PROFILE_PHOTO", label: "Profile photo", hint: "A clear selfie: face the camera, no sunglasses or cap. Riders see this photo.", needsNumber: false, needsExpiry: false },
];

export const VEHICLE_DOCS: Array<{ type: VehicleDocumentType; label: string; hint: string; needsNumber: boolean; needsExpiry: boolean }> = [
  { type: "VEHICLE_REGISTRATION", label: "Vehicle licence", hint: "Current vehicle licence (registration) paper", needsNumber: false, needsExpiry: true },
  { type: "ROADWORTHINESS", label: "Roadworthiness certificate", hint: "Valid roadworthiness certificate", needsNumber: false, needsExpiry: true },
  { type: "INSURANCE", label: "Insurance certificate", hint: "Third-party or comprehensive insurance", needsNumber: true, needsExpiry: true },
  { type: "PHOTO_FRONT", label: "Car photo: front", hint: "Whole car from the front with the number plate readable", needsNumber: false, needsExpiry: false },
  { type: "PHOTO_BACK", label: "Car photo: back", hint: "Whole car from the back with the number plate readable", needsNumber: false, needsExpiry: false },
];

type Status = DocumentStatus | "MISSING";

/**
 * Driver and vehicle documents. Each upload supersedes the previous one of the same type; reviewers
 * approve or reject documents one by one, and (with DRIVER_DOCS_REQUIRED) a driver or vehicle can only
 * be approved once every required document is approved and in date.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly notify: NotificationsService,
  ) {}

  private async checkFile(userId: string, fileId: string) {
    const f = await this.prisma.db.fileObject.findUnique({ where: { id: fileId } });
    if (!f || f.uploaderId !== userId) fail("FILE_INVALID", "Upload the photo again");
    const head = await this.storage.head(f!.objectKey);
    if (!head || head.size === 0) fail("FILE_INVALID", "The upload didn't finish. Try again.");
    if (head!.size > MAX_UPLOAD_BYTES) fail("FILE_INVALID", "That file is too large (10 MB maximum)");
    const used = (await this.prisma.db.driverDocument.count({ where: { fileId } })) + (await this.prisma.db.vehicleDocument.count({ where: { fileId } }));
    if (used) fail("FILE_INVALID", "That file was already used for another document");
    return f!;
  }

  private static expiryProblem(expiresAt: string | undefined, needed: boolean): Date | null {
    if (!expiresAt) {
      if (needed) fail("VALIDATION_FAILED", "Enter the expiry date shown on the document");
      return null;
    }
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) fail("VALIDATION_FAILED", "Enter a valid expiry date");
    if (d < new Date()) fail("VALIDATION_FAILED", "This document has expired. Upload a current one.");
    return d;
  }

  async submitDriverDoc(userId: string, body: { type: DriverDocumentType; fileId: string; documentNumber?: string; expiresAt?: string }) {
    const driver = await this.prisma.db.driver.findUnique({ where: { userId } });
    if (!driver) fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
    const spec = DRIVER_DOCS.find((d) => d.type === body.type);
    if (!spec) fail("VALIDATION_FAILED", "Unsupported document type");
    if (spec!.needsNumber && !body.documentNumber) fail("VALIDATION_FAILED", `Enter the number on your ${spec!.label.toLowerCase()}`);
    const expiresAt = DocumentsService.expiryProblem(body.expiresAt, spec!.needsExpiry);
    await this.checkFile(userId, body.fileId);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.driverDocument.updateMany({ where: { driverId: driver!.id, type: body.type, supersededAt: null }, data: { supersededAt: new Date() } });
      await tx.driverDocument.create({ data: { driverId: driver!.id, type: body.type, fileId: body.fileId, documentNumber: body.documentNumber, expiresAt } });
      if (driver!.verificationStatus === "NOT_SUBMITTED" || driver!.verificationStatus === "REJECTED") {
        await tx.driver.update({ where: { id: driver!.id }, data: { verificationStatus: "PENDING_REVIEW" } });
        await tx.driverVerification.create({ data: { driverId: driver!.id, fromStatus: driver!.verificationStatus, toStatus: "PENDING_REVIEW", notes: "New document uploaded" } });
      }
    });
    return this.forDriver(userId);
  }

  async submitVehicleDoc(userId: string, vehicleId: string, body: { type: VehicleDocumentType; fileId: string; documentNumber?: string; expiresAt?: string }) {
    const v = await this.prisma.db.vehicle.findUnique({ where: { id: vehicleId }, include: { driver: true } });
    if (!v || v.driver.userId !== userId || v.deletedAt) fail("NOT_FOUND", "Vehicle not found");
    const spec = VEHICLE_DOCS.find((d) => d.type === body.type);
    if (!spec) fail("VALIDATION_FAILED", "Unsupported document type");
    if (spec!.needsNumber && !body.documentNumber) fail("VALIDATION_FAILED", `Enter the policy or certificate number`);
    const expiresAt = DocumentsService.expiryProblem(body.expiresAt, spec!.needsExpiry);
    await this.checkFile(userId, body.fileId);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.vehicleDocument.updateMany({ where: { vehicleId, type: body.type, supersededAt: null }, data: { supersededAt: new Date() } });
      await tx.vehicleDocument.create({ data: { vehicleId, type: body.type, fileId: body.fileId, documentNumber: body.documentNumber, expiresAt } });
      if (v!.status === "REJECTED") await tx.vehicle.update({ where: { id: vehicleId }, data: { status: "PENDING_REVIEW" } });
    });
    return this.forDriver(userId);
  }

  private static status(doc: { status: DocumentStatus; expiresAt: Date | null } | undefined): Status {
    if (!doc) return "MISSING";
    if (doc.status === "APPROVED" && doc.expiresAt && doc.expiresAt < new Date()) return "EXPIRED";
    return doc.status;
  }

  /** What the driver app shows: every required document with its current state. */
  async forDriver(userId: string) {
    const driver = await this.prisma.db.driver.findUnique({
      where: { userId },
      include: {
        documents: { where: { supersededAt: null } },
        vehicles: { where: { deletedAt: null }, include: { documents: { where: { supersededAt: null } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!driver) fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
    const driverDocs = DRIVER_DOCS.map((spec) => {
      const doc = driver!.documents.find((d) => d.type === spec.type);
      return { ...spec, status: DocumentsService.status(doc), rejectionReason: doc?.status === "REJECTED" ? doc.rejectionReason : null, expiresAt: doc?.expiresAt?.toISOString().slice(0, 10) ?? null };
    });
    const vehicles = driver!.vehicles.map((v) => ({
      vehicleId: v.id, label: `${v.colour} ${v.make} ${v.model}`, plateNumber: v.plateNumber, status: v.status,
      documents: VEHICLE_DOCS.map((spec) => {
        const doc = v.documents.find((d) => d.type === spec.type);
        return { ...spec, status: DocumentsService.status(doc), rejectionReason: doc?.status === "REJECTED" ? doc.rejectionReason : null, expiresAt: doc?.expiresAt?.toISOString().slice(0, 10) ?? null };
      }),
    }));
    const all = [...driverDocs, ...vehicles.flatMap((v) => v.documents)];
    return {
      required: env().DRIVER_DOCS_REQUIRED,
      complete: all.every((d) => d.status !== "MISSING" && d.status !== "REJECTED" && d.status !== "EXPIRED"),
      driver: driverDocs,
      vehicles,
    };
  }

  /** Reviewer view with short-lived links to the files. */
  async forAdmin(driverId: string) {
    const d = await this.prisma.db.driver.findUnique({
      where: { id: driverId },
      include: {
        documents: { where: { supersededAt: null }, include: { file: true, reviewedBy: { include: { user: true } } } },
        vehicles: { where: { deletedAt: null }, include: { documents: { where: { supersededAt: null }, include: { file: true, reviewedBy: { include: { user: true } } } } } },
      },
    });
    if (!d) fail("NOT_FOUND", "Driver not found");
    const row = async (spec: { type: string; label: string }, doc: NonNullable<typeof d>["documents"][number] | NonNullable<typeof d>["vehicles"][number]["documents"][number] | undefined, kind: "driver" | "vehicle") => ({
      kind, type: spec.type, label: spec.label, id: doc?.id ?? null, status: DocumentsService.status(doc),
      documentNumber: doc?.documentNumber ?? null, expiresAt: doc?.expiresAt?.toISOString().slice(0, 10) ?? null, rejectionReason: doc?.rejectionReason ?? null,
      uploadedAt: doc?.createdAt.toISOString() ?? null, reviewedBy: doc?.reviewedBy ? `${doc.reviewedBy.user.firstName} ${doc.reviewedBy.user.lastName}`.trim() : null,
      mimeType: doc?.file.mimeType ?? null, url: doc ? await this.storage.presignGet(doc.file.objectKey, 600) : null,
    });
    return {
      required: env().DRIVER_DOCS_REQUIRED,
      driver: await Promise.all(DRIVER_DOCS.map((s) => row(s, d!.documents.find((x) => x.type === s.type), "driver"))),
      vehicles: await Promise.all(d!.vehicles.map(async (v) => ({
        vehicleId: v.id, label: `${v.colour} ${v.make} ${v.model}`, plateNumber: v.plateNumber, status: v.status,
        documents: await Promise.all(VEHICLE_DOCS.map((s) => row(s, v.documents.find((x) => x.type === s.type), "vehicle"))),
      }))),
    };
  }

  async review(adminId: string, kind: "driver" | "vehicle", id: string, decision: "approve" | "reject", reason?: string) {
    if (decision === "reject" && !reason) fail("VALIDATION_FAILED", "Say why the document was rejected, so the driver can fix it");
    const data = decision === "approve"
      ? { status: "APPROVED" as const, reviewedById: adminId, reviewedAt: new Date(), rejectionReason: null }
      : { status: "REJECTED" as const, reviewedById: adminId, reviewedAt: new Date(), rejectionReason: reason };
    let userId: string;
    let label: string;
    if (kind === "driver") {
      const doc = await this.prisma.db.driverDocument.findUnique({ where: { id }, include: { driver: true } });
      if (!doc || doc.supersededAt) fail("NOT_FOUND", "Document not found or replaced by a newer upload");
      await this.prisma.db.driverDocument.update({ where: { id }, data });
      userId = doc!.driver.userId;
      label = DRIVER_DOCS.find((s) => s.type === doc!.type)?.label ?? "document";
    } else {
      const doc = await this.prisma.db.vehicleDocument.findUnique({ where: { id }, include: { vehicle: { include: { driver: true } } } });
      if (!doc || doc.supersededAt) fail("NOT_FOUND", "Document not found or replaced by a newer upload");
      await this.prisma.db.vehicleDocument.update({ where: { id }, data });
      userId = doc!.vehicle.driver.userId;
      label = VEHICLE_DOCS.find((s) => s.type === doc!.type)?.label ?? "document";
    }
    if (decision === "reject") {
      this.notify.send(userId, { category: "ACCOUNT", title: `${label} needs another upload`, body: reason!, data: { type: "documents" } });
    }
    return { id, status: data.status };
  }

  /** Throws unless every required driver document is approved and in date. */
  async assertDriverReady(driverId: string) {
    if (!env().DRIVER_DOCS_REQUIRED) return;
    const docs = await this.prisma.db.driverDocument.findMany({ where: { driverId, supersededAt: null } });
    const missing = DRIVER_DOCS.filter((s) => DocumentsService.status(docs.find((d) => d.type === s.type)) !== "APPROVED").map((s) => s.label);
    if (missing.length) throw new DomainError("DOCUMENTS_INCOMPLETE", `Approve these documents first: ${missing.join(", ")}`, { missing });
  }

  async assertVehicleReady(vehicleId: string) {
    if (!env().DRIVER_DOCS_REQUIRED) return;
    const docs = await this.prisma.db.vehicleDocument.findMany({ where: { vehicleId, supersededAt: null } });
    const missing = VEHICLE_DOCS.filter((s) => DocumentsService.status(docs.find((d) => d.type === s.type)) !== "APPROVED").map((s) => s.label);
    if (missing.length) throw new DomainError("DOCUMENTS_INCOMPLETE", `Approve these documents first: ${missing.join(", ")}`, { missing });
  }
}
