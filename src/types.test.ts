import {
  FLEET_STATUS_PRIORITY,
  getWorstStatus,
  statusToLifecycle,
} from "./types";

// ============================================================================
// FLEET_STATUS_PRIORITY Tests
// ============================================================================

describe("FLEET_STATUS_PRIORITY", () => {
  it("should have Ready as lowest priority (0)", () => {
    expect(FLEET_STATUS_PRIORITY["Ready"]).toBe(0);
  });

  it("should have ErrApplied as highest priority (6)", () => {
    expect(FLEET_STATUS_PRIORITY["ErrApplied"]).toBe(6);
  });

  it("should have all expected statuses", () => {
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("Ready");
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("NotReady");
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("Pending");
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("OutOfSync");
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("Modified");
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("WaitApplied");
    expect(FLEET_STATUS_PRIORITY).toHaveProperty("ErrApplied");
  });

  it("should have priorities in correct order", () => {
    expect(FLEET_STATUS_PRIORITY["Ready"]).toBeLessThan(
      FLEET_STATUS_PRIORITY["NotReady"],
    );
    expect(FLEET_STATUS_PRIORITY["NotReady"]).toBeLessThan(
      FLEET_STATUS_PRIORITY["Pending"],
    );
    expect(FLEET_STATUS_PRIORITY["Pending"]).toBeLessThan(
      FLEET_STATUS_PRIORITY["OutOfSync"],
    );
    expect(FLEET_STATUS_PRIORITY["OutOfSync"]).toBeLessThan(
      FLEET_STATUS_PRIORITY["Modified"],
    );
    expect(FLEET_STATUS_PRIORITY["Modified"]).toBeLessThan(
      FLEET_STATUS_PRIORITY["WaitApplied"],
    );
    expect(FLEET_STATUS_PRIORITY["WaitApplied"]).toBeLessThan(
      FLEET_STATUS_PRIORITY["ErrApplied"],
    );
  });
});

// ============================================================================
// getWorstStatus Tests
// ============================================================================

describe("getWorstStatus", () => {
  it("should return Ready for empty array", () => {
    expect(getWorstStatus([])).toBe("Ready");
  });

  it("should return Ready for array of Ready statuses", () => {
    expect(getWorstStatus(["Ready", "Ready", "Ready"])).toBe("Ready");
  });

  it("should return worst status from mixed array", () => {
    expect(getWorstStatus(["Ready", "NotReady", "Pending"])).toBe("Pending");
  });

  it("should return ErrApplied as worst when present", () => {
    expect(getWorstStatus(["Ready", "ErrApplied", "NotReady"])).toBe(
      "ErrApplied",
    );
  });

  it("should handle undefined values", () => {
    expect(getWorstStatus([undefined, "Ready", undefined])).toBe("Ready");
  });

  it("should handle all undefined values", () => {
    expect(getWorstStatus([undefined, undefined])).toBe("Ready");
  });

  it("should handle unknown status with high priority", () => {
    expect(getWorstStatus(["Ready", "UnknownStatus"])).toBe("UnknownStatus");
  });

  it("should handle single status", () => {
    expect(getWorstStatus(["Modified"])).toBe("Modified");
  });

  it("should prefer OutOfSync over NotReady", () => {
    expect(getWorstStatus(["NotReady", "OutOfSync"])).toBe("OutOfSync");
  });

  it("should prefer Modified over OutOfSync", () => {
    expect(getWorstStatus(["OutOfSync", "Modified"])).toBe("Modified");
  });

  it("should prefer WaitApplied over Modified", () => {
    expect(getWorstStatus(["Modified", "WaitApplied"])).toBe("WaitApplied");
  });
});

// ============================================================================
// statusToLifecycle Tests
// ============================================================================

describe("statusToLifecycle", () => {
  it("should return production for Ready status", () => {
    expect(statusToLifecycle("Ready")).toBe("production");
  });

  it("should return experimental for Pending status", () => {
    expect(statusToLifecycle("Pending")).toBe("experimental");
  });

  it("should return experimental for WaitApplied status", () => {
    expect(statusToLifecycle("WaitApplied")).toBe("experimental");
  });

  it("should return deprecated for NotReady status", () => {
    expect(statusToLifecycle("NotReady")).toBe("deprecated");
  });

  it("should return deprecated for OutOfSync status", () => {
    expect(statusToLifecycle("OutOfSync")).toBe("deprecated");
  });

  it("should return deprecated for Modified status", () => {
    expect(statusToLifecycle("Modified")).toBe("deprecated");
  });

  it("should return deprecated for ErrApplied status", () => {
    expect(statusToLifecycle("ErrApplied")).toBe("deprecated");
  });

  it("should return production for undefined status", () => {
    expect(statusToLifecycle(undefined)).toBe("production");
  });

  it("should return production for unknown status", () => {
    expect(statusToLifecycle("UnknownStatus")).toBe("production");
  });

  it("should return production for empty string", () => {
    expect(statusToLifecycle("")).toBe("production");
  });
});
