import { TestApp } from "./helpers";

describe("place search (development provider)", () => {
  const t = new TestApp();
  let token: string;
  beforeAll(async () => {
    await t.start();
    token = (await t.passenger("08031119999", "Search")).accessToken;
  });
  afterAll(() => t.stop());

  it("finds Abuja places, resolves details and reverse-geocodes", async () => {
    const A = t.api(token);
    const s = await A.get("/v1/maps/autocomplete?input=jabi").expect(200);
    expect(s.body[0]).toMatchObject({ placeId: "dev:jabi", primary: "Jabi Lake Mall" });
    const d = await A.get("/v1/maps/place/dev:jabi").expect(200);
    expect(d.body).toMatchObject({ lat: 9.0703, lng: 7.4247 });
    const r = await A.get("/v1/maps/reverse-geocode?lat=9.0704&lng=7.4248").expect(200);
    expect(r.body.address).toContain("Jabi Lake Mall");
    const n = await A.get("/v1/maps/nearby-drivers?lat=9.07&lng=7.42").expect(200);
    expect(n.body.inServiceArea).toBe(true);
    const out = await A.get("/v1/maps/nearby-drivers?lat=6.52&lng=3.37").expect(200);
    expect(out.body.inServiceArea).toBe(false);
  });

  it("requires sign-in", async () => {
    await t.http().get("/v1/maps/autocomplete?input=jabi").expect(401);
  });
});
