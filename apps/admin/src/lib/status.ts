import type { Tone } from "../components/ui";

export const RIDE_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRIVER_SELECTED: { label: "Driver selected", tone: "amber" },
  DRIVER_EN_ROUTE: { label: "Driver en route", tone: "amber" },
  DRIVER_ARRIVED: { label: "Driver arrived", tone: "amber" },
  TRIP_STARTED: { label: "Trip started", tone: "blue" },
  TRIP_COMPLETED: { label: "Completed", tone: "green" },
  CANCELLED: { label: "Cancelled", tone: "red" },
  DISPUTED: { label: "Disputed", tone: "violet" },
  SEARCHING: { label: "Searching", tone: "amber" },
  OFFERS_RECEIVED: { label: "Offers in", tone: "amber" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

export const NEGOTIATION_ACTION: Record<string, string> = {
  PASSENGER_PROPOSED: "proposed",
  PASSENGER_RAISED_FARE: "raised the fare to",
  DRIVER_ACCEPTED_PRICE: "accepted the price",
  DRIVER_COUNTER_OFFER: "counter-offered",
  DRIVER_UPDATED_OFFER: "updated their offer to",
  DRIVER_WITHDREW: "withdrew their offer",
  DRIVER_DECLINED: "declined",
  PASSENGER_REJECTED_OFFER: "rejected an offer",
  PASSENGER_ACCEPTED_OFFER: "accepted the offer at",
  OFFER_EXPIRED: "offer expired",
  REQUEST_EXPIRED: "request expired",
};

export const INCIDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  TRIGGERED: { label: "Needs acknowledgement", tone: "red" },
  ACKNOWLEDGED: { label: "Acknowledged", tone: "amber" },
  CONTACTS_NOTIFIED: { label: "Contacts notified", tone: "amber" },
  ESCALATED_EXTERNAL: { label: "Emergency services contacted", tone: "amber" },
  RESOLVED: { label: "Resolved", tone: "green" },
  FALSE_ALARM: { label: "False alarm", tone: "neutral" },
};

export const TICKET_STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: "Open", tone: "amber" },
  ASSIGNED: { label: "Assigned", tone: "blue" },
  AWAITING_USER: { label: "Awaiting customer", tone: "neutral" },
  RESOLVED: { label: "Resolved", tone: "green" },
  CLOSED: { label: "Closed", tone: "neutral" },
};

export const PRIORITY: Record<string, Tone> = { URGENT: "red", HIGH: "red", NORMAL: "neutral", LOW: "blue" };

export const WITHDRAWAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  REQUESTED: { label: "Requested", tone: "amber" },
  APPROVED: { label: "Approved, awaiting transfer", tone: "blue" },
  COMPLETED: { label: "Paid", tone: "green" },
  REJECTED: { label: "Rejected", tone: "red" },
  FAILED: { label: "Failed", tone: "red" },
  PROCESSING: { label: "Sending via Paystack", tone: "blue" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  INITIATED: { label: "Started", tone: "neutral" },
  PENDING: { label: "Waiting for customer", tone: "amber" },
  SUCCEEDED: { label: "Paid", tone: "green" },
  FAILED: { label: "Failed", tone: "red" },
  ABANDONED: { label: "Abandoned", tone: "neutral" },
  REVERSED: { label: "Reversed", tone: "red" },
  REFUNDED: { label: "Refunded", tone: "violet" },
  PARTIALLY_REFUNDED: { label: "Part refunded", tone: "violet" },
};

export const PAYMENT_PURPOSE: Record<string, string> = {
  RIDE_FARE: "Card trip",
  WALLET_TOPUP: "Wallet top-up",
  COMMISSION_SETTLEMENT: "Driver commission payment",
  CANCELLATION_FEE: "Cancellation fee",
};
