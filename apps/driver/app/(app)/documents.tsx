import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Banner, Button, Card, colors, errorMessage, Field, Loading, Muted, Pill, Row, Screen, space, Txt } from "@zuma/mobile-core";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";

interface Doc { type: string; label: string; hint: string; needsNumber: boolean; needsExpiry: boolean; status: "MISSING" | "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"; rejectionReason: string | null; expiresAt: string | null }
interface Docs { required: boolean; complete: boolean; driver: Doc[]; vehicles: { vehicleId: string; label: string; plateNumber: string; status: string; documents: Doc[] }[] }

const TONE = { MISSING: "neutral", PENDING: "amber", APPROVED: "green", REJECTED: "red", EXPIRED: "red" } as const;
const LABEL = { MISSING: "Needed", PENDING: "In review", APPROVED: "Approved", REJECTED: "Retake", EXPIRED: "Expired" } as const;

/** Uploads a photo straight to storage with the presigned URL, then returns the file id. */
async function uploadPhoto(uri: string, mimeType: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const u = await api.post<{ fileId: string; uploadUrl: string; headers: Record<string, string> }>("/v1/files/uploads", { purpose: "DRIVER_DOCUMENT", mimeType, sizeBytes: blob.size });
  const res = await fetch(u.uploadUrl, { method: "PUT", headers: u.headers, body: blob });
  if (!res.ok) throw new Error("Upload failed. Check your connection and try again.");
  return u.fileId;
}

export default function Documents() {
  const q = useQuery({ queryKey: ["documents"], queryFn: () => api.get<Docs>("/v1/driver/documents") });
  const [open, setOpen] = useState<{ doc: Doc; vehicleId?: string } | null>(null);

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!q.data) return <Screen><Banner text={errorMessage(q.error)} /></Screen>;
  if (open) return <Capture doc={open.doc} vehicleId={open.vehicleId} onDone={() => setOpen(null)} />;

  const Item = ({ d, vehicleId }: { d: Doc; vehicleId?: string }) => (
    <Pressable accessibilityRole="button" onPress={() => d.status !== "APPROVED" && setOpen({ doc: d, vehicleId })} style={{ paddingVertical: space.sm }}>
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <Txt variant="label">{d.label}</Txt>
          {d.rejectionReason && d.status === "REJECTED" ? <Txt variant="small" color={colors.red}>{d.rejectionReason}</Txt> : <Muted>{d.status === "MISSING" ? d.hint : d.expiresAt ? `Expires ${d.expiresAt}` : " "}</Muted>}
        </View>
        <Pill label={LABEL[d.status]} tone={TONE[d.status]} />
      </Row>
    </Pressable>
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt variant="title">Documents</Txt>
          <Button title="Close" kind="ghost" onPress={() => router.back()} />
        </Row>
        {q.data.complete ? <Banner tone="green" text="All documents uploaded. We'll notify you when they're reviewed." /> : <Muted variant="body">Take clear photos in good light with all four corners visible. Tap a document to upload it.</Muted>}
        <Card>
          <Txt variant="heading">You</Txt>
          {q.data.driver.map((d) => <Item key={d.type} d={d} />)}
        </Card>
        {q.data.vehicles.map((v) => (
          <Card key={v.vehicleId}>
            <Txt variant="heading">{v.label} · {v.plateNumber}</Txt>
            {v.documents.map((d) => <Item key={d.type} d={d} vehicleId={v.vehicleId} />)}
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}

function Capture({ doc, vehicleId, onDone }: { doc: Doc; vehicleId?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [photo, setPhoto] = useState<{ uri: string; mimeType: string } | null>(null);
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selfie = doc.type === "PROFILE_PHOTO";

  const pick = async (camera: boolean) => {
    setError(null);
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return setError(camera ? "Allow camera access in Settings to take the photo." : "Allow photo access in Settings to choose a photo.");
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6, allowsEditing: !selfie, cameraType: selfie ? ImagePicker.CameraType.front : ImagePicker.CameraType.back };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!r.canceled && r.assets[0]) setPhoto({ uri: r.assets[0].uri, mimeType: r.assets[0].mimeType === "image/png" ? "image/png" : "image/jpeg" });
  };

  const submit = async () => {
    if (!photo) return;
    if (doc.needsExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return setError("Enter the expiry date as YYYY-MM-DD");
    setBusy(true);
    setError(null);
    try {
      const fileId = await uploadPhoto(photo.uri, photo.mimeType);
      const body = { type: doc.type, fileId, documentNumber: number.trim() || undefined, expiresAt: expiry || undefined };
      await api.post(vehicleId ? `/v1/driver/vehicles/${vehicleId}/documents` : "/v1/driver/documents", body);
      await qc.invalidateQueries({ queryKey: ["documents"] });
      await qc.invalidateQueries({ queryKey: ["driver-me"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }} keyboardShouldPersistTaps="handled">
        <Txt variant="title">{doc.label}</Txt>
        <Muted variant="body">{doc.hint}</Muted>
        {doc.rejectionReason ? <Banner tone="amber" text={`Why we need a new one: ${doc.rejectionReason}`} /> : null}
        {photo ? <Image source={{ uri: photo.uri }} style={{ width: "100%", aspectRatio: selfie ? 3 / 4 : 4 / 3, borderRadius: 12 }} resizeMode="cover" accessibilityLabel="Your photo" /> : null}
        <Row gap={space.sm}>
          <Button title={photo ? "Retake" : selfie ? "Take a selfie" : "Take a photo"} kind={photo ? "secondary" : "amber"} style={{ flex: 1 }} onPress={() => pick(true)} />
          {!selfie ? <Button title="Choose photo" kind="secondary" style={{ flex: 1 }} onPress={() => pick(false)} /> : null}
        </Row>
        {doc.needsNumber ? <Field label={doc.type === "INSURANCE" ? "Policy number" : doc.type === "NATIONAL_ID" ? "NIN or ID number" : "Licence number"} value={number} onChangeText={setNumber} autoCapitalize="characters" /> : null}
        {doc.needsExpiry ? <Field label="Expiry date" value={expiry} onChangeText={setExpiry} placeholder="2027-06-30" keyboardType="numbers-and-punctuation" hint="Format YYYY-MM-DD" /> : null}
        {error ? <Banner text={error} /> : null}
        <Button title="Upload" onPress={submit} loading={busy} disabled={!photo || (doc.needsNumber && number.trim().length < 3)} />
        <Button title="Cancel" kind="ghost" onPress={onDone} />
      </ScrollView>
    </Screen>
  );
}
