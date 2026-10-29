/**
 * npm run eval
 * Runs the simulated evaluation suite against a THROWAWAY database (never your real data) and writes
 * evals/reports/latest.json + latest.md. Override the database with MONGODB_URI_EVAL.
 */
import fs from "node:fs";
import path from "node:path";

async function main() {
  process.env.MONGODB_URI = process.env.MONGODB_URI_EVAL ?? "mongodb://127.0.0.1:27017/staydesk_eval";
  const only = process.argv.find((a) => a.startsWith("--family="))?.split("=")[1];

  const { default: mongoose } = await import("mongoose");
  const { dbConnect, dbDisconnect } = await import("../../lib/mongodb");
  const { runSuite, toMarkdown } = await import("./report");
  const { ALL_SCENARIOS } = await import("./scenarios");

  await dbConnect();
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // recreate unique indexes after the drop

  const scenarios = only ? ALL_SCENARIOS.filter((s) => s.family === only) : ALL_SCENARIOS;
  console.log(`Running ${scenarios.length} scenarios against ${process.env.MONGODB_URI.replace(/\/\/[^@]*@/, "//***@")} ...`);
  const report = await runSuite(scenarios, { onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`) });
  console.log("");

  const dir = path.resolve(process.cwd(), "evals/reports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, "latest.md"), toMarkdown(report));

  console.log(toMarkdown(report).split("\n## Definitions")[0]);
  console.log(`Full report: ${path.join(dir, "latest.md")}`);

  await mongoose.connection.dropDatabase();
  await dbDisconnect();
  process.exit(report.metrics.some((m) => m.pass === false) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
