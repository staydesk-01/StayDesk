import { dbConnect, dbDisconnect } from "../../lib/mongodb";
import { DEMO_OWNER, DEMO_STAFF, DEMO_STAYDESK_NUMBER, seedDemoBusiness } from "./demoData";

async function main() {
  await dbConnect();
  const { business } = await seedDemoBusiness();
  console.log(`\nSeeded demo business "${business.name}" (sample data, flagged isDemo).`);
  console.log(`  Owner login: ${DEMO_OWNER.email} / ${DEMO_OWNER.password}`);
  console.log(`  Staff login: ${DEMO_STAFF.email} / ${DEMO_STAFF.password}`);
  console.log(`  StayDesk number on file: ${DEMO_STAYDESK_NUMBER}  (replace with your real Twilio number on the Call Routing page)\n`);
  await dbDisconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
