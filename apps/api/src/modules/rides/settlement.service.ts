import { Injectable } from "@nestjs/common";
import { Money } from "@zuma/contracts";
import type { Payment, PaymentMethodType } from "@zuma/database";
import { type Tx } from "../../infra/prisma.service";
import { LedgerService, type Posting } from "../ledger/ledger.service";
import { WalletService } from "../ledger/wallet.service";
import { PromosService } from "../promos/promos.service";
import { ReferralsService, type RewardPaid } from "../promos/referrals.service";
import { shortCode } from "./codes";

export interface SettlementResult {
  /** What the passenger paid: agreed fare + waiting − promo discount. */
  finalFare: bigint;
  /** What the driver's fare is: agreed fare + waiting. Commission is charged on this. */
  grossFare: bigint;
  commission: bigint;
  discount: bigint;
  method: PaymentMethodType;
  switchedToCash: boolean;
  /** Card couldn't be charged and the wallet covered the trip instead. */
  switchedToWallet: boolean;
  driverPendingCredit: bigint;
  rewards: RewardPaid[];
}

/**
 * Books the money side of a completed trip inside the completion transaction.
 *  - CASH:   driver already holds what the passenger paid; the ledger books the commission the driver owes,
 *            minus any promo discount Riders App owes the driver.
 *  - WALLET: passenger wallet (+ promo expense) → driver pending (gross − commission) + commission revenue.
 *  - CARD:   Paystack clearing (+ promo expense) → driver pending + commission revenue; Paystack fee expensed.
 * A card that couldn't be charged falls back to the wallet if it covers the fare, otherwise to cash.
 * Commission is unique per ride (DB) and its ledger key is commission:{rideId}, so it can never be charged twice.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly promos: PromosService,
    private readonly referrals: ReferralsService,
  ) {}

  async settle(tx: Tx, rideId: string, cardPayment: Payment | null = null): Promise<SettlementResult> {
    const ride = await tx.ride.findUniqueOrThrow({ where: { id: rideId }, include: { driver: true, passenger: true, rideRequest: true } });
    const grossFare = ride.agreedFare + ride.waitingCharge;
    const discount = ride.discountAmount > grossFare ? grossFare : ride.discountAmount;
    const finalFare = grossFare - discount;
    const commission = Money.commission(grossFare, ride.commissionBps);

    let method: PaymentMethodType = ride.paymentMethod;
    let switchedToCash = false;
    let switchedToWallet = false;
    const walletCovers = async () => (await this.wallets.ensureWallet(ride.passenger.userId, "PASSENGER", tx)).availableBalance >= finalFare;
    if (method === "CARD" && !cardPayment) {
      if (await walletCovers()) {
        method = "WALLET";
        switchedToWallet = true;
      } else {
        method = "CASH";
        switchedToCash = true;
      }
    } else if (method === "WALLET" && !(await walletCovers())) {
      method = "CASH";
      switchedToCash = true;
    }

    const payment = method === "CARD"
      ? cardPayment!
      : await tx.payment.create({
          data: {
            reference: shortCode("P", 10), idempotencyKey: `ride-fare:${rideId}`, userId: ride.passenger.userId, rideId,
            purpose: "RIDE_FARE", method, provider: "NONE", amount: finalFare, status: "SUCCEEDED", verifiedAt: new Date(),
          },
        });

    const driverUser = ride.driver.userId;
    const revenue = await this.wallets.systemAccountId("PLATFORM_COMMISSION_REVENUE", tx);
    const promoExpense = discount > 0n ? await this.wallets.systemAccountId("PROMO_EXPENSE", tx) : null;
    let driverPendingCredit = 0n;
    const entries: Posting[] = [{ accountId: revenue, direction: "CREDIT", amount: commission }];
    if (promoExpense) entries.push({ accountId: promoExpense, direction: "DEBIT", amount: discount });

    if (method === "CASH") {
      // Driver holds finalFare in cash. Net effect on their balance: + discount − commission.
      const driverAvail = await this.wallets.accountId(driverUser, "DRIVER", "WALLET_AVAILABLE", tx);
      const net = discount - commission;
      if (net !== 0n) entries.push({ accountId: driverAvail, direction: net > 0n ? "CREDIT" : "DEBIT", amount: net > 0n ? net : -net });
    } else {
      driverPendingCredit = grossFare - commission;
      entries.push({ accountId: await this.wallets.accountId(driverUser, "DRIVER", "WALLET_PENDING", tx), direction: "CREDIT", amount: driverPendingCredit });
      const source = method === "WALLET"
        ? await this.wallets.accountId(ride.passenger.userId, "PASSENGER", "WALLET_AVAILABLE", tx)
        : await this.wallets.systemAccountId("PAYSTACK_CLEARING", tx);
      entries.push({ accountId: source, direction: "DEBIT", amount: finalFare });
    }

    const posted = await this.ledger.post(tx, {
      type: method === "CASH" ? "RIDE_CASH_COMMISSION" : method === "WALLET" ? "RIDE_PAYMENT_WALLET" : "RIDE_PAYMENT_CARD",
      idempotencyKey: `commission:${rideId}`,
      description: method === "CASH" ? `Commission on cash trip ${ride.code}${discount ? ` (promo ${Money.format(discount)} paid by Riders App)` : ""}` : `Trip ${ride.code}`,
      rideId, paymentId: payment.id, createdByType: "SYSTEM", entries,
    });

    if (method === "CARD" && payment.feeAmount > 0n) {
      await this.ledger.post(tx, {
        type: "ADJUSTMENT", idempotencyKey: `fee:${payment.id}`, description: "Paystack processing fee", paymentId: payment.id, rideId, createdByType: "SYSTEM",
        entries: [
          { accountId: await this.wallets.systemAccountId("PROVIDER_FEES_EXPENSE", tx), direction: "DEBIT", amount: payment.feeAmount },
          { accountId: await this.wallets.systemAccountId("PAYSTACK_CLEARING", tx), direction: "CREDIT", amount: payment.feeAmount },
        ],
      });
    }

    await this.promos.redeem(tx, { id: ride.id, discountAmount: discount }, ride.rideRequest.promoCodeId, ride.passenger.userId);
    await tx.commission.create({
      data: { rideId, driverId: ride.driverId, grossFare, commissionBps: ride.commissionBps, amount: commission, status: "COLLECTED", ledgerTransactionId: posted.id },
    });
    await tx.receipt.create({ data: { number: shortCode("RC", 8), rideId, amountPaid: finalFare, method } });
    const d = await tx.driver.update({ where: { id: ride.driverId }, data: { tripsCompleted: { increment: 1 } } });
    const p = await tx.passengerProfile.update({ where: { id: ride.passengerId }, data: { tripsCompleted: { increment: 1 } } });
    const rewards = [
      ...(await this.referrals.onTripCompleted(tx, ride.passenger.userId, "PASSENGER", p.tripsCompleted)),
      ...(await this.referrals.onTripCompleted(tx, driverUser, "DRIVER", d.tripsCompleted)),
    ];
    return { finalFare, grossFare, commission, discount, method, switchedToCash, switchedToWallet, driverPendingCredit, rewards };
  }

  /** Move a wallet or card trip's earnings from pending to available after the hold period. */
  async release(tx: Tx, rideId: string) {
    const ride = await tx.ride.findUniqueOrThrow({ where: { id: rideId }, include: { driver: true, commission: true } });
    if (!ride.commission || !["WALLET", "CARD"].includes(ride.paymentMethod) || ride.status === "DISPUTED") return;
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
