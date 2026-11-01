import { Injectable } from "@nestjs/common";
import { Money } from "@zuma/contracts";
import type { PaymentMethodType } from "@zuma/database";
import { type Tx } from "../../infra/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { WalletService } from "../ledger/wallet.service";
import { shortCode } from "./codes";

export interface SettlementResult {
  finalFare: bigint;
  commission: bigint;
  method: PaymentMethodType;
  switchedToCash: boolean;
  driverPendingCredit: bigint;
}

/**
 * Books the money side of a completed trip inside the completion transaction.
 *  - CASH: driver already holds the fare; platform books only the commission the driver owes.
 *  - WALLET: passenger wallet → driver pending (fare − commission) + platform commission.
 * Commission is unique per ride (DB) and its ledger key is commission:{rideId}, so it can never be charged twice.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
  ) {}

  async settle(tx: Tx, rideId: string): Promise<SettlementResult> {
    const ride = await tx.ride.findUniqueOrThrow({ where: { id: rideId }, include: { driver: true, passenger: true } });
    const finalFare = ride.agreedFare - ride.discountAmount + ride.waitingCharge;
    const commission = Money.commission(finalFare, ride.commissionBps);

    let method: PaymentMethodType = ride.paymentMethod;
    let switchedToCash = false;
    if (method === "WALLET") {
      const w = await this.wallets.ensureWallet(ride.passenger.userId, "PASSENGER", tx);
      if (w.availableBalance < finalFare) {
        method = "CASH";
        switchedToCash = true;
      }
    }
    if (method === "CARD") method = "CASH"; // card payments arrive with the payments phase

    const payment = await tx.payment.create({
      data: {
        reference: shortCode("P", 10), idempotencyKey: `ride-fare:${rideId}`, userId: ride.passenger.userId, rideId,
        purpose: "RIDE_FARE", method, provider: "NONE", amount: finalFare, status: "SUCCEEDED", verifiedAt: new Date(),
      },
    });

    const driverUser = ride.driver.userId;
    const revenue = await this.wallets.systemAccountId("PLATFORM_COMMISSION_REVENUE", tx);
    let txnId: string;
    let driverPendingCredit = 0n;

    if (method === "CASH") {
      const driverAvail = await this.wallets.accountId(driverUser, "DRIVER", "WALLET_AVAILABLE", tx);
      const posted = await this.ledger.post(tx, {
        type: "RIDE_CASH_COMMISSION", idempotencyKey: `commission:${rideId}`, description: `Commission on cash trip ${ride.code}`,
        rideId, paymentId: payment.id, createdByType: "SYSTEM",
        entries: [
          { accountId: driverAvail, direction: "DEBIT", amount: commission },
          { accountId: revenue, direction: "CREDIT", amount: commission },
        ],
      });
      txnId = posted.id;
    } else {
      const passengerAvail = await this.wallets.accountId(ride.passenger.userId, "PASSENGER", "WALLET_AVAILABLE", tx);
      const driverPending = await this.wallets.accountId(driverUser, "DRIVER", "WALLET_PENDING", tx);
      driverPendingCredit = finalFare - commission;
      const posted = await this.ledger.post(tx, {
        type: "RIDE_PAYMENT_WALLET", idempotencyKey: `commission:${rideId}`, description: `Trip ${ride.code}`,
        rideId, paymentId: payment.id, createdByType: "SYSTEM",
        entries: [
          { accountId: passengerAvail, direction: "DEBIT", amount: finalFare },
          { accountId: driverPending, direction: "CREDIT", amount: driverPendingCredit },
          { accountId: revenue, direction: "CREDIT", amount: commission },
        ],
      });
      txnId = posted.id;
    }

    await tx.commission.create({
      data: { rideId, driverId: ride.driverId, grossFare: finalFare, commissionBps: ride.commissionBps, amount: commission, status: "COLLECTED", ledgerTransactionId: txnId },
    });
    await tx.receipt.create({ data: { number: shortCode("RC", 8), rideId, amountPaid: finalFare, method } });
    await tx.driver.update({ where: { id: ride.driverId }, data: { tripsCompleted: { increment: 1 } } });
    await tx.passengerProfile.update({ where: { id: ride.passengerId }, data: { tripsCompleted: { increment: 1 } } });
    return { finalFare, commission, method, switchedToCash, driverPendingCredit };
  }

  /** Move a wallet trip's earnings from pending to available after the hold period. */
  async release(tx: Tx, rideId: string) {
    const ride = await tx.ride.findUniqueOrThrow({ where: { id: rideId }, include: { driver: true, commission: true } });
    if (!ride.commission || ride.paymentMethod !== "WALLET" || ride.status === "DISPUTED") return;
    const amount = ride.commission.grossFare - ride.commission.amount;
    const pending = await this.wallets.accountId(ride.driver.userId, "DRIVER", "WALLET_PENDING", tx);
    const avail = await this.wallets.accountId(ride.driver.userId, "DRIVER", "WALLET_AVAILABLE", tx);
    await this.ledger.post(tx, {
      type: "PENDING_RELEASE", idempotencyKey: `release:${rideId}`, description: `Earnings released for ${ride.code}`,
      rideId, createdByType: "SYSTEM",
      entries: [
        { accountId: pending, direction: "DEBIT", amount },
        { accountId: avail, direction: "CREDIT", amount },
      ],
    });
  }
}
