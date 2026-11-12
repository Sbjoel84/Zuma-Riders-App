import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Banner, Button, Card, Chip, errorMessage, Field, Loading, Muted, Pill, Row, Screen, space, Txt, useSession } from "@zuma/mobile-core";
import { router } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

interface DriverMe {
  id: string;
  verificationStatus: string;
  activeVehicleId: string | null;
  licenceNumber: string | null;
  vehicles: Array<{ id: string; make: string; model: string; year: number; colour: string; plateNumber: string; categoryName: string; status: string; rejectionReason: string | null }>;
}

const CATEGORIES = [
  { key: "economy", name: "Economy", note: "2010+" },
  { key: "comfort", name: "Comfort", note: "2014+, AC" },
  { key: "premium", name: "Premium", note: "2017+" },
  { key: "suv", name: "SUV", note: "6 seats" },
];

/** Registration: licence details, then the vehicle, then document photos, then review. */
export default function Onboarding() {
  const qc = useQueryClient();
  const refreshMe = useSession((s) => s.refreshMe);
  const signOut = useSession((s) => s.signOut);
  const driver = useQuery({ queryKey: ["driver-me"], queryFn: () => api.get<DriverMe | null>("/v1/driver/me"), refetchInterval: 20_000 });
  const docs = useQuery({ queryKey: ["documents"], enabled: !!driver.data?.vehicles.length, queryFn: () => api.get<{ complete: boolean; required: boolean; driver: { status: string }[]; vehicles: { documents: { status: string }[] }[] }>("/v1/driver/documents") });
  const docCounts = docs.data ? [...docs.data.driver, ...docs.data.vehicles.flatMap((v) => v.documents)] : [];

  const [licence, setLicence] = useState("");
  const [expiry, setExpiry] = useState("");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("economy");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [colour, setColour] = useState("");
  const [plate, setPlate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (driver.isLoading) return <Screen><Loading /></Screen>;
  const d = driver.data;

  const submitDetails = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return setError("Enter the licence expiry as YYYY-MM-DD");
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/driver/onboarding", { licenceNumber: licence.trim(), licenceExpiresAt: expiry, addressLine: address.trim() });
      await qc.invalidateQueries({ queryKey: ["driver-me"] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitVehicle = async () => {
    const y = parseInt(year, 10);
    if (!y) return setError("Enter the vehicle's year");
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/driver/vehicles", { categoryKey: category, make: make.trim(), model: model.trim(), year: y, colour: colour.trim(), plateNumber: plate.trim() });
      await qc.invalidateQueries({ queryKey: ["driver-me"] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const continueIfApproved = async () => {
    const me = await refreshMe();
    if (me?.driver?.verificationStatus === "APPROVED" && me.driver.activeVehicleId) router.replace("/(app)/home");
    else qc.invalidateQueries({ queryKey: ["driver-me"] });
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.xl }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={driver.isFetching} onRefresh={() => { driver.refetch(); }} tintColor="#f2a900" />}>
        <Txt variant="title">Become a Riders App driver</Txt>
        <Row gap={space.sm}>
          <Pill label="1 Details" tone={d ? "green" : "amber"} />
          <Pill label="2 Vehicle" tone={d?.vehicles.length ? "green" : d ? "amber" : "neutral"} />
          <Pill label="3 Documents" tone={docs.data?.complete ? "green" : d?.vehicles.length ? "amber" : "neutral"} />
          <Pill label="4 Review" tone={d?.verificationStatus === "APPROVED" ? "green" : docs.data?.complete ? "amber" : "neutral"} />
        </Row>
        {error ? <Banner text={error} /> : null}

        {!d ? (
          <Card>
            <Txt variant="heading">Your licence</Txt>
            <Field label="Driver's licence number" value={licence} onChangeText={setLicence} autoCapitalize="characters" />
            <Field label="Licence expiry date" placeholder="2029-03-01" value={expiry} onChangeText={setExpiry} keyboardType="numbers-and-punctuation" hint="Format YYYY-MM-DD" />
            <Field label="Home address" value={address} onChangeText={setAddress} placeholder="12 Gimbiya Street, Garki" />
            <Button title="Save and continue" onPress={submitDetails} loading={busy} />
          </Card>
        ) : d.vehicles.length === 0 ? (
          <Card>
            <Txt variant="heading">Your vehicle</Txt>
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: space.sm }}>
              {CATEGORIES.map((c) => <Chip key={c.key} label={c.name} sub={c.note} selected={category === c.key} onPress={() => setCategory(c.key)} />)}
            </View>
            <Field label="Make" placeholder="Toyota" value={make} onChangeText={setMake} />
            <Field label="Model" placeholder="Corolla" value={model} onChangeText={setModel} />
            <Row>
              <Field style={{ flex: 1 }} label="Year" placeholder="2016" keyboardType="number-pad" maxLength={4} value={year} onChangeText={setYear} />
              <Field style={{ flex: 1 }} label="Colour" placeholder="Silver" value={colour} onChangeText={setColour} />
            </Row>
            <Field label="Plate number" placeholder="ABC 123 DE" autoCapitalize="characters" value={plate} onChangeText={setPlate} />
            <Button title="Add vehicle" onPress={submitVehicle} loading={busy} />
          </Card>
        ) : (
          <Card>
            <Txt variant="heading">{d.verificationStatus === "APPROVED" ? "You're approved" : d.verificationStatus === "REJECTED" ? "Changes needed" : "Under review"}</Txt>
            <Muted variant="body">
              {d.verificationStatus === "APPROVED"
                ? "You can go online and start receiving requests."
                : d.verificationStatus === "REJECTED"
                  ? "Our team couldn't approve your registration yet. Check your documents for what to fix."
                  : docs.data?.complete
                    ? "Thanks. Our team is checking your documents, usually within one working day. We'll notify you."
                    : "Upload photos of your licence, ID, a selfie and your vehicle papers. We review them and notify you."}
            </Muted>
            {d.verificationStatus !== "APPROVED" ? (
              <Button
                title={docs.data?.complete ? "View documents" : `Upload documents (${docCounts.filter((x) => x.status !== "MISSING").length} of ${docCounts.length || 8})`}
                kind={docs.data?.complete ? "secondary" : "amber"}
                onPress={() => router.push("/(app)/documents")}
              />
            ) : null}
            {docCounts.some((x) => x.status === "REJECTED") ? <Banner tone="amber" text="Some documents need a new photo. Open Documents to see why." /> : null}
            {d.vehicles.map((v) => (
              <Row key={v.id} style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Txt variant="label">{v.colour} {v.make} {v.model} {v.year}</Txt>
                  <Muted>{v.plateNumber} · {v.categoryName}</Muted>
                </View>
                <Pill label={v.status === "APPROVED" ? "Approved" : v.status === "REJECTED" ? "Rejected" : "Pending"} tone={v.status === "APPROVED" ? "green" : v.status === "REJECTED" ? "red" : "amber"} />
              </Row>
            ))}
            <Button title={d.verificationStatus === "APPROVED" ? "Go to dashboard" : "Check status"} onPress={continueIfApproved} />
          </Card>
        )}
        <Button title="Sign out" kind="ghost" onPress={signOut} />
      </ScrollView>
    </Screen>
  );
}
