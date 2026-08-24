/**
 * Make a test file that *dies* say why, instead of reporting `'test failed'` with no name.
 *
 * `node --test` runs each test file in its own child process. When a subtest fails an
 * assertion the reporter names it and prints a diff; but when the child process itself exits
 * early -- an uncaught exception, an unhandled rejection, a native crash -- there is no subtest
 * to attribute it to, so the whole file is reported as one failure whose message is the string
 * `'test failed'`.
 *
 * That is the exact shape this repository's Windows CI failure has taken twice:
 *
 * ```
 * ✖ test\node-observation.test.ts (9171.1836ms)
 *   'test failed'
 * ```
 *
 * 24 passed, 1 failed, and nothing anywhere saying which test or why. Two fixes have now been
 * shipped against that log without knowing which test produced it, and the first one -- a
 * longer settle window -- did not hold. The missing information is not a reporter setting: the
 * process was gone before the reporter could say anything.
 *
 * So these handlers exist to convert an anonymous death into a named one. They log the reason
 * with a stack, then exit non-zero so the failure is still a failure: a diagnostic that
 * accidentally turns a crash green would be far worse than no diagnostic at all.
 *
 * Importing this module for its side effects is deliberate. It is not a `.test.ts` file, so the
 * `test/**\/*.test.ts` glob does not pick it up as a suite of its own.
 */

function report(kind: string, value: unknown): void {
  const detail =
    value instanceof Error
      ? `${value.name}: ${value.message}\n${value.stack ?? "(no stack)"}`
      : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value);

  // stderr, and unbuffered by process.exit below only because we write before exiting: this is
  // the one output that has to survive, since by definition nothing else will describe it.
  process.stderr.write(
    `\n=== ${kind} escaped a test in ${process.argv[1] ?? "this file"} ===\n${detail}\n`
      + "This killed the test file, which is why the reporter had no test name for it.\n\n",
  );
}

process.on("uncaughtException", (error) => {
  report("UNCAUGHT EXCEPTION", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  report("UNHANDLED REJECTION", reason);
  process.exit(1);
});

// A watcher-backed suite is the likeliest place for this: `fs.watch` callbacks run outside any
// test's async context, so anything they throw lands here rather than on the test that armed
// them. Warnings do not kill a file, but an EBUSY or EPERM warning immediately before a death
// is the clue that says the death was a filesystem race rather than a logic error.
process.on("warning", (warning) => {
  if (warning.name === "DeprecationWarning") return;
  process.stderr.write(`[warning] ${warning.name}: ${warning.message}\n`);
});
