import { Logger } from "@nestjs/common";
import { createApp } from "./app.factory";
import { env } from "./config/env";

async function main() {
  const { app } = await createApp();
  await app.listen(env().PORT, "0.0.0.0");
  new Logger("Bootstrap").log(`Zuma API listening on :${env().PORT} (${env().NODE_ENV}, maps=${env().MAPS_PROVIDER}, sms=${env().SMS_PROVIDER})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
