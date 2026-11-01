import type { RideStatus } from "@zuma/contracts";

export type TripEvent = "EN_ROUTE" | "ARRIVED" | "START" | "COMPLETE" | "CANCEL" | "DISPUTE";
export type Actor = "PASSENGER" | "DRIVER" | "ADMIN" | "SYSTEM";

interface Edge {
  from: RideStatus[];
  to: RideStatus;
  actors: Actor[];
}

/**
 * Trip state machine for a confirmed Ride (DRIVER_SELECTED onward). Negotiation states
 * (REQUESTED → OFFERS_RECEIVED) live on RideRequest and are handled by the negotiation service.
 */
export const TRIP_EDGES: Record<TripEvent, Edge> = {
  EN_ROUTE: { from: ["DRIVER_SELECTED"], to: "DRIVER_EN_ROUTE", actors: ["DRIVER"] },
  ARRIVED: { from: ["DRIVER_SELECTED", "DRIVER_EN_ROUTE"], to: "DRIVER_ARRIVED", actors: ["DRIVER"] },
  START: { from: ["DRIVER_ARRIVED"], to: "TRIP_STARTED", actors: ["DRIVER"] },
  COMPLETE: { from: ["TRIP_STARTED"], to: "TRIP_COMPLETED", actors: ["DRIVER", "ADMIN"] },
  CANCEL: { from: ["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"], to: "CANCELLED", actors: ["PASSENGER", "DRIVER", "ADMIN"] },
  DISPUTE: { from: ["TRIP_STARTED", "TRIP_COMPLETED"], to: "DISPUTED", actors: ["PASSENGER", "DRIVER", "ADMIN"] },
};

export const ACTIVE_RIDE_STATUSES: RideStatus[] = ["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "TRIP_STARTED"];
export const OPEN_REQUEST_STATUSES: RideStatus[] = ["REQUESTED", "SEARCHING", "OFFERS_RECEIVED"];

export type TransitionResult = { ok: true; to: RideStatus } | { ok: false; reason: "ACTOR_NOT_ALLOWED" | "INVALID_FROM_STATE" };

/** Pure: decides whether `actor` may apply `event` to a ride currently in `from`. */
export function transition(from: RideStatus, event: TripEvent, actor: Actor): TransitionResult {
  const edge = TRIP_EDGES[event];
  if (!edge.actors.includes(actor)) return { ok: false, reason: "ACTOR_NOT_ALLOWED" };
  if (!edge.from.includes(from)) return { ok: false, reason: "INVALID_FROM_STATE" };
  return { ok: true, to: edge.to };
}

/** Passenger cancellation fee applies only after the grace window and once the driver is on the way. */
export function passengerCancellationFee(opts: { status: RideStatus; assignedAt: Date; now: Date; graceSeconds: number; fee: bigint }): bigint {
  if (opts.status === "DRIVER_SELECTED") return 0n;
  const elapsed = (opts.now.getTime() - opts.assignedAt.getTime()) / 1000;
  return elapsed > opts.graceSeconds ? opts.fee : 0n;
}
