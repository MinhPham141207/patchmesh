import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const source = join(packageDirectory, "..", "src", "migrations");
const destination = join(packageDirectory, "..", "dist", "migrations");

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
