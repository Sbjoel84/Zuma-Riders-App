import type { EstimateResponse, Place } from "@zuma/contracts";
import { create } from "zustand";

/** In-progress booking, shared by the home, search and fare screens. */
interface BookingState {
  pickup: Place | null;
  dropoff: Place | null;
  editing: "pickup" | "dropoff";
  estimate: EstimateResponse | null;
  setPickup: (p: Place) => void;
  setDropoff: (p: Place) => void;
  setEditing: (w: "pickup" | "dropoff") => void;
  setEstimate: (e: EstimateResponse | null) => void;
  reset: () => void;
}

export const useBooking = create<BookingState>((set) => ({
  pickup: null,
  dropoff: null,
  editing: "dropoff",
  estimate: null,
  setPickup: (pickup) => set({ pickup, estimate: null }),
  setDropoff: (dropoff) => set({ dropoff, estimate: null }),
  setEditing: (editing) => set({ editing }),
  setEstimate: (estimate) => set({ estimate }),
  reset: () => set({ dropoff: null, estimate: null, editing: "dropoff" }),
}));

export const ABUJA_CENTER = { latitude: 9.0579, longitude: 7.4951, latitudeDelta: 0.08, longitudeDelta: 0.08 };
