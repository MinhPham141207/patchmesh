import { ReadServiceError } from "./types.js";

const durationPattern = /^(\d+)([smhd])$/;

export function parseTimeBound(value: string, now: number): number {
  if (value.trim().length === 0 || !Number.isFinite(now)) {
    throw new ReadServiceError("usage", "time bound is invalid");
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return timestamp;
  const match = durationPattern.exec(value);
  if (!match) throw new ReadServiceError("usage", "time bound is invalid");
  const amount = Number(match[1]);
  const unit = match[2];
  const milliseconds = unit === "s"
    ? amount * 1000
    : unit === "m"
      ? amount * 60_000
      : unit === "h"
        ? amount * 3_600_000
        : amount * 86_400_000;
  if (!Number.isSafeInteger(milliseconds)) throw new ReadServiceError("usage", "time bound is invalid");
  return now - milliseconds;
}
