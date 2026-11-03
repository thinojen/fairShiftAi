import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Only needed for `db:migrate`; `db:generate` works offline.
    url: process.env.DATABASE_URL ?? "postgres://placeholder@localhost:5432/placeholder",
  },
  strict: true,
  verbose: true,
});
