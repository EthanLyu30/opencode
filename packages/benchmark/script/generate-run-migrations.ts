import fs from "node:fs/promises"
import path from "node:path"
import { RUN_DATABASE_SQL, RUN_DATABASE_SCHEMA_VERSION } from "../src/run/sql"

const directory = path.join(import.meta.dir, "..", "migrations")
const target = path.join(directory, `${String(RUN_DATABASE_SCHEMA_VERSION).padStart(4, "0")}_task24_run.sql`)
await fs.mkdir(directory, { recursive: true })
await fs.writeFile(target, RUN_DATABASE_SQL.trim() + "\n", "utf8")
process.stdout.write(target + "\n")
