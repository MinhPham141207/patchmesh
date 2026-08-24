/**
 * Make any test file that *dies* say why, instead of reporting `'test failed'` with no name.
 *
 * `node --test` runs each test file in its own child process. When a subtest fails an
 * assertion the reporter names it and prints a diff; but when the child process itself exits
 * early -- an uncaught exception, an unhandled rejection, a native crash -- there is no subtest
 * to attribute it to, so the whole file is reported as one failure whose message is the string
 * `'test failed'`.
 *
 * That is the shape this repository's CI failures keep taking:
 *
 * ```
 * ✖ test\node-observation.test.ts (9171.1836ms)
 *   'test failed'
 * ```
 *
 * 24 passed, 1 failed, and nothing anywhere saying which test or why. Two fixes were shipped
 * against that log without knowing which test produced it, and the first -- a longer settle
 * window -- did not hold. The missing information is not a reporter setting: the process was
 * gone before the reporter could say anything.
 *
 * A throwaway probe confirmed the mechanism. A test that arms
 * `setTimeout(() => Promise.reject(new Error("boom")))` and returns reproduces that output
 * exactly, so an anonymous file-level failure means a process-level death and never a failed
 * assertion or a timeout.
 *
 * This is preloaded into **every** package's test run rather than imported by one suite,
 * because the second package to fail this way was not the one that was instrumented. A
 * diagnostic that only covers the file you already suspect is a diagnostic that arrives too
 * late every time.
 *
 * The handlers log with a stack and then exit non-zero, so the failure stays a failure: a
 * diagnostic that accidentally turned a crash green would be far worse than none.
 */

import { writeSync } from "node:fs";

function describe(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? "(no stack)"}`;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function report(kind, value) {
  // `writeSync` on fd 2 rather than `console.error`: the handlers exit immediately afterwards,
  // and on Windows a piped stderr is asynchronous, so a buffered write can be lost precisely
  // when it is the only record of what happened.
  const text =
    `\n=== ${kind} escaped a test ===\n`
    + `file: ${process.argv[1] ?? "(unknown)"}\n`
    + `${describe(value)}\n`
    + "This killed the test file, which is why the reporter had no test name for it.\n\n";
  try {
    writeSync(2, text);
  } catch {
    process.stderr.write(text);
  }
}

process.on("uncaughtException", (error) => {
  report("UNCAUGHT EXCEPTION", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  report("UNHANDLED REJECTION", reason);
  process.exit(1);
});

// Warnings do not kill a file, but an EBUSY or EPERM immediately before a death is the clue
// that says the death was a filesystem race rather than a logic error. Deprecations are noise.
process.on("warning", (warning) => {
  if (warning.name === "DeprecationWarning") return;
  process.stderr.write(`[warning] ${warning.name}: ${warning.message}\n`);
});
