// Clear only the retired scheduling-clock override in the configured database.
import "./_env";
import { updateConfig } from "../src/lib/repo";
import { nowISO } from "../src/lib/time";

async function main() {
  const config = await updateConfig({ clockMode: "real", customTimeISO: null });
  console.log(JSON.stringify({ clockMode: config.clockMode, customTimeISO: config.customTimeISO, currentTimeUTC: nowISO() }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
