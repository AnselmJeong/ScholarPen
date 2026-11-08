import { expect, test } from "bun:test";
import { DetectorInstaller, parseInstallProgress } from "./installer";
import { detectorActivity } from "./runtime";

test("accepts bounded progress and rejects corrupt download counters", () => {
  expect(parseInstallProgress('{"kind":"files","completed":2,"total":56}')).toEqual({ kind: "files", completed: 2, total: 56 });
  expect(parseInstallProgress('{"kind":"bytes","completed":200,"total":null}')).toEqual({ kind: "bytes", completed: 200, total: null });
  for (const value of ["not json", '{"kind":"files","completed":-1,"total":56}', '{"kind":"files","completed":57,"total":56}', '{"kind":"bytes","completed":1,"total":0}']) {
    expect(parseInstallProgress(value)).toBeNull();
  }
});

test("install never mutates the interpreter during active analysis", () => {
  detectorActivity.analyzing = true;
  try { expect(new DetectorInstaller().start().state).toBe("error"); }
  finally { detectorActivity.analyzing = false; }
  expect(detectorActivity.installing).toBe(false);
});

test("app installer does not silently ignore a custom development interpreter", () => {
  const previous = process.env.SCHOLARPEN_DETECTOR_PYTHON;
  process.env.SCHOLARPEN_DETECTOR_PYTHON = "/custom/python";
  try {
    expect(new DetectorInstaller().start().state).toBe("error");
    expect(detectorActivity.installing).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.SCHOLARPEN_DETECTOR_PYTHON;
    else process.env.SCHOLARPEN_DETECTOR_PYTHON = previous;
  }
});
