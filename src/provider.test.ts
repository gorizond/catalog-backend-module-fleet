import { ConfigReader } from "@backstage/config";
import { FleetEntityProvider } from "./provider";
import { createEmptyBatch } from "./entityMapper";

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
// FleetEntityProvider.fromConfig Tests
// ============================================================================

describe("FleetEntityProvider.fromConfig", () => {
  it("should return empty array when no fleet config", () => {
    const config = new ConfigReader({});
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "No Fleet provider configuration found",
    );
  });

  it("should create provider from named config", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              token: "test-token",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
    expect(providers[0].getProviderName()).toBe("fleet:default");
  });

  it("should create provider with schedule config", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            production: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
              schedule: {
                frequency: { minutes: 5 },
                timeout: { minutes: 2 },
                initialDelay: { seconds: 30 },
              },
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
    const schedule = providers[0].getSchedule();
    expect(schedule.frequency).toBeDefined();
    expect(schedule.timeout).toBeDefined();
    expect(schedule.initialDelay).toBeDefined();
  });

  it("should use default schedule values", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    const schedule = providers[0].getSchedule();
    expect(schedule.frequency).toBeDefined();
    expect(schedule.timeout).toBeDefined();
    expect(schedule.initialDelay).toBeDefined();
  });

  it("should create multiple providers from named config", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            production: {
              name: "prod-cluster",
              url: "https://rancher-prod.example.com",
              namespaces: ["fleet-default"],
            },
            staging: {
              name: "staging-cluster",
              url: "https://rancher-staging.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.getProviderName()).sort()).toEqual([
      "fleet:production",
      "fleet:staging",
    ]);
  });

  it("should create provider with clusters array", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            production: {
              clusters: [
                {
                  name: "us-east",
                  url: "https://rancher-us.example.com",
                  namespaces: ["fleet-default"],
                },
                {
                  name: "eu-west",
                  url: "https://rancher-eu.example.com",
                  namespaces: ["fleet-default"],
                },
              ],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle string array namespaces", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default", "fleet-local"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should use default namespace when none specified", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle gitRepoSelector config", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
              gitRepoSelector: {
                matchLabels: {
                  discover: "true",
                },
                matchExpressions: [
                  {
                    key: "tier",
                    operator: "In",
                    values: ["frontend", "backend"],
                  },
                ],
              },
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle all boolean options", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
              includeBundles: false,
              includeBundleDeployments: true,
              generateApis: true,
              fetchFleetYaml: true,
              skipTLSVerify: true,
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle alternative config key names", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              clusterName: "test-cluster",
              apiServer: "https://rancher.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should use default cluster name and url", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });
});

// ============================================================================
// FleetEntityProvider Instance Tests
// ============================================================================

describe("FleetEntityProvider", () => {
  const mockConnection = {
    applyMutation: jest.fn(),
    refresh: jest.fn(),
  };

  const mockCluster = {
    name: "test-cluster",
    url: "https://rancher.example.com",
    namespaces: [{ name: "fleet-default" }],
  } as any;

  const createOptions = (overrides: any = {}) => ({
    id: "test",
    clusters: overrides.clusters ?? [mockCluster],
    schedule: {
      frequency: { minutes: 10 },
      timeout: { minutes: 5 },
      initialDelay: { seconds: 15 },
    },
    logger: createMockLogger() as any,
    concurrency: 1,
    k8sLocator: overrides.k8sLocator,
  });

  const connection: any = mockConnection;

  beforeEach(() => {
    mockConnection.applyMutation.mockReset();
    mockConnection.refresh.mockReset();
  });

  it("should return provider name", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            myProvider: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers[0].getProviderName()).toBe("fleet:myProvider");
  });

  it("should throw if run called before connect", async () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    await expect(providers[0].run()).rejects.toThrow(
      "FleetEntityProvider is not connected",
    );
  });

  it("should connect without error", async () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    const mockConnection = {
      applyMutation: jest.fn(),
      refresh: jest.fn(),
    };

    await expect(
      providers[0].connect(mockConnection as any),
    ).resolves.not.toThrow();
  });

  it("uses cluster namespace from Rancher as primary workspace", async () => {
    const emitted: any[] = [];
    const provider = new FleetEntityProvider(
      createOptions({
        k8sLocator: {
          listRancherClusterDetails: async () => [
            {
              id: "c-1",
              name: "c-1",
              namespace: "fleet-foo",
              labels: {},
            } as any,
          ],
          listClusterNodesDetailed: async () => [],
          listClusterMachineDeployments: async () => [],
          listClusterVersions: async () => [],
          listHarvesterVirtualMachines: async () => [],
        } as any,
      }),
    );

    await provider.connect({
      applyMutation: async (m: any) => {
        const batch = m.entities.map((e: any) => e.entity);
        emitted.push(...batch);
      },
    } as any);

    await provider.run();

    const clusters = emitted.filter((e) =>
      e?.metadata?.tags?.includes("kubernetes-cluster"),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].metadata?.namespace).toBe("fleet-foo");
  });

  it("falls back to fleet-default when Rancher namespace is missing", async () => {
    const emitted: any[] = [];
    const provider = new FleetEntityProvider(
      createOptions({
        k8sLocator: {
          listRancherClusterDetails: async () => [
            {
              id: "c-1",
              name: "c-1",
              labels: {},
            } as any,
          ],
          listClusterNodesDetailed: async () => [],
          listClusterMachineDeployments: async () => [],
          listClusterVersions: async () => [],
          listHarvesterVirtualMachines: async () => [],
        } as any,
      }),
    );

    await provider.connect({
      applyMutation: async (m: any) => {
        const batch = m.entities.map((e: any) => e.entity);
        emitted.push(...batch);
      },
    } as any);

    await provider.run();

    const clusters = emitted.filter((e) =>
      e?.metadata?.tags?.includes("kubernetes-cluster"),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].metadata?.namespace).toBe("fleet-default");
  });
});

// ============================================================================
// Configuration Edge Cases
// ============================================================================

describe("FleetEntityProvider configuration edge cases", () => {
  it("should handle empty namespaces array", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: [],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle caData config", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              caData: "base64-encoded-ca-cert",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle concurrency config", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
              concurrency: 5,
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle clusterUrl alternative key", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              clusterUrl: "https://rancher.example.com",
              namespaces: ["fleet-default"],
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });

  it("should handle empty matchLabels in selector", () => {
    const config = new ConfigReader({
      catalog: {
        providers: {
          fleet: {
            default: {
              name: "test-cluster",
              url: "https://rancher.example.com",
              namespaces: ["fleet-default"],
              gitRepoSelector: {
                matchLabels: {},
              },
            },
          },
        },
      },
    });
    const logger = createMockLogger();

    const providers = FleetEntityProvider.fromConfig(config, {
      logger: logger as any,
    });

    expect(providers).toHaveLength(1);
  });
});
