import { FleetClient, selectorToString } from "./FleetClient";
import { FleetClusterConfig, LabelSelector } from "./types";

// ============================================================================
// Mock Logger
// ============================================================================

const createMockLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
});

// ============================================================================
// selectorToString Tests
// ============================================================================

describe("selectorToString", () => {
  it("should return undefined for undefined selector", () => {
    expect(selectorToString(undefined)).toBeUndefined();
  });

  it("should return undefined for empty selector", () => {
    expect(selectorToString({})).toBeUndefined();
  });

  it("should convert matchLabels to string", () => {
    const selector: LabelSelector = {
      matchLabels: {
        app: "my-app",
        env: "prod",
      },
    };
    const result = selectorToString(selector);
    expect(result).toContain("app=my-app");
    expect(result).toContain("env=prod");
  });

  it("should convert In operator to string", () => {
    const selector: LabelSelector = {
      matchExpressions: [
        {
          key: "tier",
          operator: "In",
          values: ["frontend", "backend"],
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toBe("tier in (frontend,backend)");
  });

  it("should convert NotIn operator to string", () => {
    const selector: LabelSelector = {
      matchExpressions: [
        {
          key: "tier",
          operator: "NotIn",
          values: ["test"],
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toBe("tier notin (test)");
  });

  it("should convert Exists operator to string", () => {
    const selector: LabelSelector = {
      matchExpressions: [
        {
          key: "tier",
          operator: "Exists",
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toBe("tier");
  });

  it("should convert DoesNotExist operator to string", () => {
    const selector: LabelSelector = {
      matchExpressions: [
        {
          key: "tier",
          operator: "DoesNotExist",
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toBe("!tier");
  });

  it("should combine matchLabels and matchExpressions", () => {
    const selector: LabelSelector = {
      matchLabels: {
        app: "my-app",
      },
      matchExpressions: [
        {
          key: "tier",
          operator: "Exists",
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toContain("app=my-app");
    expect(result).toContain("tier");
  });

  it("should handle empty values array in In operator", () => {
    const selector: LabelSelector = {
      matchExpressions: [
        {
          key: "tier",
          operator: "In",
          values: [],
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toBe("tier in ()");
  });

  it("should handle undefined values in In operator", () => {
    const selector: LabelSelector = {
      matchExpressions: [
        {
          key: "tier",
          operator: "In",
        },
      ],
    };
    const result = selectorToString(selector);
    expect(result).toBe("tier in ()");
  });
});

// ============================================================================
// FleetClient.extractClusterIdFromNamespace Tests
// ============================================================================

describe("FleetClient.extractClusterIdFromNamespace", () => {
  it("should extract cluster ID from default namespace", () => {
    const result = FleetClient.extractClusterIdFromNamespace(
      "cluster-fleet-default-my-cluster",
    );
    expect(result).toBe("my-cluster");
  });

  it("should extract cluster ID from local namespace", () => {
    const result = FleetClient.extractClusterIdFromNamespace(
      "cluster-fleet-local-prod-cluster",
    );
    expect(result).toBe("prod-cluster");
  });

  it("should return undefined for invalid namespace", () => {
    const result =
      FleetClient.extractClusterIdFromNamespace("invalid-namespace");
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    const result = FleetClient.extractClusterIdFromNamespace("");
    expect(result).toBeUndefined();
  });

  it("should handle complex cluster IDs", () => {
    const result = FleetClient.extractClusterIdFromNamespace(
      "cluster-fleet-default-prod-us-east-1",
    );
    expect(result).toBe("prod-us-east-1");
  });

  it("should not match similar but invalid patterns", () => {
    expect(
      FleetClient.extractClusterIdFromNamespace("cluster-fleet-custom-test"),
    ).toBeUndefined();
    expect(
      FleetClient.extractClusterIdFromNamespace("fleet-default-test"),
    ).toBeUndefined();
  });
});

// ============================================================================
// FleetClient Constructor Tests
// ============================================================================

describe("FleetClient constructor", () => {
  it("should create client with valid config", () => {
    const cluster: FleetClusterConfig = {
      name: "test-cluster",
      url: "https://rancher.example.com",
      token: "test-token",
      namespaces: [{ name: "fleet-default" }],
    };
    const logger = createMockLogger();

    // This will fail to connect but should not throw
    expect(() => {
      new FleetClient({ cluster, logger: logger as any });
    }).not.toThrow();
  });

  it("should handle skipTLSVerify option", () => {
    const cluster: FleetClusterConfig = {
      name: "test-cluster",
      url: "https://rancher.example.com",
      token: "test-token",
      skipTLSVerify: true,
      namespaces: [{ name: "fleet-default" }],
    };
    const logger = createMockLogger();

    expect(() => {
      new FleetClient({ cluster, logger: logger as any });
    }).not.toThrow();
  });

  it("should handle caData option", () => {
    const cluster: FleetClusterConfig = {
      name: "test-cluster",
      url: "https://rancher.example.com",
      token: "test-token",
      caData: "base64-encoded-ca-cert",
      namespaces: [{ name: "fleet-default" }],
    };
    const logger = createMockLogger();

    expect(() => {
      new FleetClient({ cluster, logger: logger as any });
    }).not.toThrow();
  });
});
