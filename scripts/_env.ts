// Loaded first (before any src/ import) so process.env is populated
// for scripts run via tsx. Import this at the very top of a script.
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error(
    "⚠  NEXT_PUBLIC_SUPABASE_URL not found. Run from the project root with a .env.local present.",
  );
}
