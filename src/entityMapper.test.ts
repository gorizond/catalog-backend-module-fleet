import { Entity } from "@backstage/catalog-model";
import {
  mapFleetClusterToSystem,
  mapGitRepoToComponent,
  mapBundleToResource,
  mapBundleDeploymentToResource,
  mapApiDefinitionToApi,
  toBackstageName,
  toEntityNamespace,
  createEmptyBatch,
  flattenBatch,
  extractBundleMetadata,
  MapperContext,
  ANNOTATION_FLEET_REPO,
  ANNOTATION_FLEET_BRANCH,
  ANNOTATION_FLEET_STATUS,
  ANNOTATION_FLEET_CLUSTER,
  ANNOTATION_FLEET_NAMESPACE,
  ANNOTATION_KUBERNETES_ID,
} from "./entityMapper";
import {
  FleetGitRepo,
  FleetBundle,
  FleetBundleDeployment,
  FleetClusterConfig,
  FleetYaml,
} from "./types";

// Helper to safely access entity spec
function getSpec(entity: Entity): Record<string, unknown> {
  return entity.spec as Record<string, unknown>;
}

// ============================================================================
// Test Fixtures
// ============================================================================

const createMockClusterConfig = (
  overrides: Partial<FleetClusterConfig> = {},
): FleetClusterConfig => ({
  name: "test-cluster",
  url: "https://rancher.example.com",
  namespaces: [{ name: "fleet-default" }],
  ...overrides,
});

const createMockContext = (
  overrides: Partial<MapperContext> = {},
): MapperContext => ({
  cluster: createMockClusterConfig(),
  locationKey: "fleet:test",
  autoTechdocsRef: true,
  ...overrides,
});

const createMockGitRepo = (
  overrides: Partial<FleetGitRepo> = {},
): FleetGitRepo => ({
  apiVersion: "fleet.cattle.io/v1alpha1",
  kind: "GitRepo",
  metadata: {
    name: "my-app",
    namespace: "fleet-default",
    uid: "123-456",
    labels: {},
    annotations: {},
  },
  spec: {
    repo: "https://github.com/example/my-app",
    branch: "main",
    paths: ["./"],
    targets: [{ name: "production" }],
  },
  status: {
    display: {
      state: "Ready",
      readyClusters: "3/3",
    },
  },
  ...overrides,
});

const createMockBundle = (
  overrides: Partial<FleetBundle> = {},
): FleetBundle => ({
  apiVersion: "fleet.cattle.io/v1alpha1",
  kind: "Bundle",
  metadata: {
    name: "my-app-main",
    namespace: "fleet-default",
    uid: "789-012",
    labels: {
      "fleet.cattle.io/repo-name": "my-app",
      "fleet.cattle.io/bundle-path": ".",
      "fleet.cattle.io/commit": "abc123",
    },
    annotations: {},
  },
  spec: {
    targets: [{ name: "production" }],
  },
  status: {
    display: {
      state: "Ready",
      readyClusters: "3/3",
    },
  },
  ...overrides,
});

const createMockBundleDeployment = (
  overrides: Partial<FleetBundleDeployment> = {},
): FleetBundleDeployment => ({
  apiVersion: "fleet.cattle.io/v1alpha1",
  kind: "BundleDeployment",
  metadata: {
    name: "my-app-main",
    namespace: "cluster-fleet-default-prod-cluster",
    uid: "345-678",
    labels: {
      "fleet.cattle.io/bundle-name": "my-app-main",
    },
    annotations: {},
  },
  status: {
    display: {
      state: "Ready",
      message: "Deployed successfully",
    },
    ready: true,
  },
  ...overrides,
});

const createMockFleetYaml = (
  overrides: Partial<FleetYaml> = {},
): FleetYaml => ({
  defaultNamespace: "my-app",
  helm: {
    releaseName: "my-app-release",
  },
  backstage: {
    type: "service",
    description: "My application",
    owner: "team-platform",
    tags: ["production"],
  },
  ...overrides,
});

// ============================================================================
// toBackstageName Tests
// ============================================================================

describe("toBackstageName", () => {
  it("should convert uppercase to lowercase", () => {
    expect(toBackstageName("MyApp")).toBe("myapp");
  });

  it("should replace invalid characters with hyphens", () => {
    expect(toBackstageName("my_app.name")).toBe("my-app-name");
  });

  it("should collapse multiple hyphens", () => {
    expect(toBackstageName("my---app")).toBe("my-app");
  });

  it("should remove leading and trailing hyphens", () => {
    expect(toBackstageName("-my-app-")).toBe("my-app");
  });

  it("should handle empty string", () => {
    expect(toBackstageName("")).toBe("fleet-entity");
  });

  it("should truncate to 63 characters", () => {
    const longName = "a".repeat(100);
    expect(toBackstageName(longName).length).toBe(63);
  });

  it("should handle special characters", () => {
    expect(toBackstageName("my@app#name!")).toBe("my-app-name");
  });

  it("should handle numbers", () => {
    expect(toBackstageName("app123")).toBe("app123");
  });
});

// ============================================================================
// toEntityNamespace Tests
// ============================================================================

describe("toEntityNamespace", () => {
  it("should convert fleet namespace to entity namespace", () => {
    expect(toEntityNamespace("fleet-default")).toBe("fleet-default");
  });

  it("should handle uppercase", () => {
    expect(toEntityNamespace("Fleet-Default")).toBe("fleet-default");
  });

  it("should handle special characters", () => {
    expect(toEntityNamespace("fleet_local")).toBe("fleet-local");
  });
});

// ============================================================================
// mapFleetClusterToSystem Tests
// ============================================================================

describe("mapFleetClusterToSystem", () => {
  it("should create a System entity from cluster config", () => {
    const context = createMockContext();
    const entity = mapFleetClusterToSystem(context);

    expect(entity.kind).toBe("System");
    expect(entity.metadata.name).toBe("test-cluster");
    expect(entity.metadata.namespace).toBe("default");
    expect(getSpec(entity).owner).toBe("platform-team");
  });

  it("should extract hostname from URL for description", () => {
    const context = createMockContext({
      cluster: createMockClusterConfig({
        url: "https://rancher.example.com/k8s/clusters/local",
      }),
    });
    const entity = mapFleetClusterToSystem(context);

    expect(entity.metadata.description).toContain("rancher.example.com");
  });

  it("should include Fleet annotations", () => {
    const context = createMockContext();
    const entity = mapFleetClusterToSystem(context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations[ANNOTATION_FLEET_CLUSTER]).toBe("test-cluster");
    expect(annotations["fleet.cattle.io/url"]).toBe(
      "https://rancher.example.com",
    );
  });

  it("should include namespace list in annotations", () => {
    const context = createMockContext({
      cluster: createMockClusterConfig({
        namespaces: [{ name: "fleet-default" }, { name: "fleet-local" }],
      }),
    });
    const entity = mapFleetClusterToSystem(context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["fleet.cattle.io/namespaces"]).toBe(
      "fleet-default,fleet-local",
    );
  });

  it("should include links to Rancher", () => {
    const context = createMockContext();
    const entity = mapFleetClusterToSystem(context);

    expect(entity.metadata.links).toContainEqual({
      url: "https://rancher.example.com",
      title: "Rancher Fleet",
    });
  });

  it("should use custom entity namespace when provided", () => {
    const context = createMockContext();
    const entity = mapFleetClusterToSystem(context, "custom-namespace");

    expect(entity.metadata.namespace).toBe("custom-namespace");
  });

  it("should handle invalid URL gracefully", () => {
    const context = createMockContext({
      cluster: createMockClusterConfig({
        url: "not-a-valid-url",
      }),
    });
    const entity = mapFleetClusterToSystem(context);

    expect(entity.metadata.description).toContain("not-a-valid-url");
  });
});

// ============================================================================
// mapGitRepoToComponent Tests
// ============================================================================

describe("mapGitRepoToComponent", () => {
  it("should create a Component entity from GitRepo", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(entity.kind).toBe("Component");
    expect(entity.metadata.name).toBe("my-app");
    expect(entity.metadata.namespace).toBe("fleet-default");
  });

  it("should set type to service by default", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).type).toBe("service");
  });

  it("should include Fleet annotations", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations[ANNOTATION_FLEET_REPO]).toBe(
      "https://github.com/example/my-app",
    );
    expect(annotations[ANNOTATION_FLEET_BRANCH]).toBe("main");
    expect(annotations[ANNOTATION_FLEET_STATUS]).toBe("Ready");
    expect(annotations[ANNOTATION_FLEET_CLUSTER]).toBe("test-cluster");
    expect(annotations[ANNOTATION_FLEET_NAMESPACE]).toBe("fleet-default");
  });

  it("should include Kubernetes annotations", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations[ANNOTATION_KUBERNETES_ID]).toBe("test-cluster");
  });

  it("should include source location annotation", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["backstage.io/source-location"]).toBe(
      "url:https://github.com/example/my-app",
    );
  });

  it("should set system reference to parent cluster", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).system).toBe("system:default/test-cluster");
  });

  it("should set lifecycle based on status", () => {
    const gitRepo = createMockGitRepo({
      status: { display: { state: "Ready" } },
    });
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).lifecycle).toBe("production");
  });

  it("should set lifecycle to deprecated for error states", () => {
    const gitRepo = createMockGitRepo({
      status: { display: { state: "ErrApplied" } },
    });
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).lifecycle).toBe("deprecated");
  });

  it("should include links to Git repository", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(entity.metadata.links).toContainEqual({
      url: "https://github.com/example/my-app",
      title: "Git Repository",
    });
  });

  it("should use fleet.yaml description when available", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml();
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(entity.metadata.description).toBe("My application");
  });

  it("should use fleet.yaml owner when available", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml();
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).owner).toBe("team-platform");
  });

  it("should derive owner from repo when fleet.yaml owner is missing", () => {
    const gitRepo = createMockGitRepo({
      metadata: {
        name: "my-app",
        namespace: "fleet-default",
        annotations: {},
      },
      status: { display: { state: "Ready" } },
    });
    const context = createMockContext({ fleetYaml: undefined });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).owner).toBe("group:default/example");
  });

  it("should add techdocs ref annotation when enabled", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["backstage.io/techdocs-ref"]).toBe(
      "url:https://github.com/example/my-app",
    );
  });

  it("should use gitrepo description when fleet.yaml is missing", () => {
    const gitRepo = createMockGitRepo({
      metadata: {
        name: "my-app",
        namespace: "fleet-default",
        annotations: { description: "Description from GitRepo" },
      },
    });
    const context = createMockContext({ fleetYaml: undefined });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(entity.metadata.description).toBe("Description from GitRepo");
  });

  it("should use fleet.yaml type when available", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml({
      backstage: { type: "website" },
    });
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).type).toBe("website");
  });

  it("should include fleet.yaml tags", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml();
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(entity.metadata.tags).toContain("production");
    expect(entity.metadata.tags).toContain("fleet");
  });

  it("should include fleet.yaml dependsOn", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml({
      backstage: {
        dependsOn: ["component:default/database"],
      },
    });
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).dependsOn).toContain("component:default/database");
  });

  it("should include fleet.yaml providesApis references", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml({
      backstage: {
        providesApis: [{ name: "my-api", type: "openapi" }],
      },
    });
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).providesApis).toContain("api:fleet-default/my-api");
  });

  it("should include fleet.yaml consumesApis", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml({
      backstage: {
        consumesApis: ["api:default/auth-api"],
      },
    });
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).consumesApis).toContain("api:default/auth-api");
  });

  it("should merge custom annotations from fleet.yaml", () => {
    const gitRepo = createMockGitRepo();
    const fleetYaml = createMockFleetYaml({
      backstage: {
        annotations: {
          "pagerduty.com/integration-key": "abc123",
        },
      },
    });
    const context = createMockContext({ fleetYaml });
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["pagerduty.com/integration-key"]).toBe("abc123");
  });

  it("should handle missing metadata gracefully", () => {
    const gitRepo: FleetGitRepo = {
      spec: { repo: "https://github.com/test/repo" },
    };
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(entity.metadata.name).toBe("fleet-gitrepo");
    expect(entity.metadata.namespace).toBe("fleet-default");
  });

  it("should handle missing status gracefully", () => {
    const gitRepo = createMockGitRepo({ status: undefined });
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);

    expect(getSpec(entity).lifecycle).toBe("production");
  });

  it("should include ready clusters in annotations", () => {
    const gitRepo = createMockGitRepo();
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["fleet.cattle.io/ready-clusters"]).toBe("3/3");
  });

  it("should include targets in annotations", () => {
    const gitRepo = createMockGitRepo({
      spec: {
        repo: "https://github.com/test/repo",
        targets: [{ name: "prod" }, { name: "staging" }],
      },
    });
    const context = createMockContext();
    const entity = mapGitRepoToComponent(gitRepo, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["fleet.cattle.io/targets"]).toBe('["prod","staging"]');
  });
});

// ============================================================================
// mapBundleToResource Tests
// ============================================================================

describe("mapBundleToResource", () => {
  it("should create a Resource entity from Bundle", () => {
    const bundle = createMockBundle();
    const context = createMockContext();
    const entity = mapBundleToResource(bundle, context);

    expect(entity.kind).toBe("Resource");
    expect(entity.metadata.name).toBe("my-app-main");
    expect(entity.metadata.namespace).toBe("fleet-default");
  });

  it("should set type to fleet-bundle", () => {
    const bundle = createMockBundle();
    const context = createMockContext();
    const entity = mapBundleToResource(bundle, context);

    expect(getSpec(entity).type).toBe("fleet-bundle");
  });

  it("should include Fleet annotations", () => {
    const bundle = createMockBundle();
    const context = createMockContext();
    const entity = mapBundleToResource(bundle, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations[ANNOTATION_FLEET_STATUS]).toBe("Ready");
    expect(annotations[ANNOTATION_FLEET_CLUSTER]).toBe("test-cluster");
    expect(annotations["fleet.cattle.io/repo-name"]).toBe("my-app");
    expect(annotations["fleet.cattle.io/bundle-path"]).toBe(".");
  });

  it("should include Kubernetes annotations", () => {
    const bundle = createMockBundle();
    const fleetYaml = createMockFleetYaml();
    const context = createMockContext({ fleetYaml });
    const entity = mapBundleToResource(bundle, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations[ANNOTATION_KUBERNETES_ID]).toBe("test-cluster");
    expect(annotations["backstage.io/kubernetes-namespace"]).toBe("my-app");
    expect(annotations["backstage.io/kubernetes-label-selector"]).toBe(
      "app.kubernetes.io/instance=my-app-release",
    );
  });

  it("should depend on parent GitRepo Component", () => {
    const bundle = createMockBundle();
    const context = createMockContext();
    const entity = mapBundleToResource(bundle, context);

    expect(getSpec(entity).dependsOn).toContain(
      "component:fleet-default/my-app",
    );
  });

  it("should include fleet.yaml tags", () => {
    const bundle = createMockBundle();
    const fleetYaml = createMockFleetYaml();
    const context = createMockContext({ fleetYaml });
    const entity = mapBundleToResource(bundle, context);

    expect(entity.metadata.tags).toContain("production");
    expect(entity.metadata.tags).toContain("fleet-bundle");
  });

  it("should use fleet.yaml owner when available", () => {
    const bundle = createMockBundle();
    const fleetYaml = createMockFleetYaml();
    const context = createMockContext({ fleetYaml });
    const entity = mapBundleToResource(bundle, context);

    expect(getSpec(entity).owner).toBe("team-platform");
  });

  it("should handle missing labels gracefully", () => {
    const bundle = createMockBundle({
      metadata: {
        name: "orphan-bundle",
        namespace: "fleet-default",
        labels: {},
      },
    });
    const context = createMockContext();
    const entity = mapBundleToResource(bundle, context);

    expect(entity.metadata.name).toBe("orphan-bundle");
    expect(getSpec(entity).dependsOn).toBeUndefined();
  });

  it("should include bundle dependsOn as Resource references", () => {
    const bundle = createMockBundle({
      spec: {
        dependsOn: [{ name: "cert-manager-bundle" }],
      },
    });
    const context = createMockContext();
    const entity = mapBundleToResource(bundle, context);

    expect(getSpec(entity).dependsOn).toContain(
      "resource:fleet-default/cert-manager-bundle",
    );
  });

  it("should merge custom annotations from fleet.yaml", () => {
    const bundle = createMockBundle();
    const fleetYaml = createMockFleetYaml({
      annotations: {
        "custom.io/key": "value",
      },
    });
    const context = createMockContext({ fleetYaml });
    const entity = mapBundleToResource(bundle, context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["custom.io/key"]).toBe("value");
  });
});

// ============================================================================
// mapBundleDeploymentToResource Tests
// ============================================================================

describe("mapBundleDeploymentToResource", () => {
  it("should create a Resource entity from BundleDeployment", () => {
    const bd = createMockBundleDeployment();
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);

    expect(entity.kind).toBe("Resource");
    expect(entity.metadata.name).toBe("my-app-main-prod-cluster");
    // Namespace is converted from the BundleDeployment namespace
    expect(entity.metadata.namespace).toBe(
      "cluster-fleet-default-prod-cluster",
    );
  });

  it("should set type to fleet-deployment", () => {
    const bd = createMockBundleDeployment();
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);

    expect(getSpec(entity).type).toBe("fleet-deployment");
  });

  it("should include status annotations", () => {
    const bd = createMockBundleDeployment();
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations[ANNOTATION_FLEET_STATUS]).toBe("Ready");
    expect(annotations[ANNOTATION_FLEET_CLUSTER]).toBe("prod-cluster");
  });

  it("should include message in annotations", () => {
    const bd = createMockBundleDeployment();
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["fleet.cattle.io/message"]).toBe(
      "Deployed successfully",
    );
  });

  it("should depend on parent Bundle Resource", () => {
    const bd = createMockBundleDeployment();
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);

    expect(getSpec(entity).dependsOn).toContain(
      "resource:cluster-fleet-default-prod-cluster/my-app-main",
    );
  });

  it("should include cluster tag", () => {
    const bd = createMockBundleDeployment();
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);

    expect(entity.metadata.tags).toContain("cluster-prod-cluster");
  });

  it("should truncate long messages", () => {
    const longMessage = "x".repeat(600);
    const bd = createMockBundleDeployment({
      status: {
        display: {
          state: "Ready",
          message: longMessage,
        },
      },
    });
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod-cluster", context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["fleet.cattle.io/message"].length).toBe(500);
  });

  it("should handle missing bundle name label", () => {
    const bd = createMockBundleDeployment({
      metadata: {
        name: "orphan-deployment",
        namespace: "cluster-fleet-default-prod",
        labels: {},
      },
    });
    const context = createMockContext();
    const entity = mapBundleDeploymentToResource(bd, "prod", context);

    expect(getSpec(entity).dependsOn).toBeUndefined();
  });
});

// ============================================================================
// mapApiDefinitionToApi Tests
// ============================================================================

describe("mapApiDefinitionToApi", () => {
  it("should create an API entity", () => {
    const apiDef = { name: "my-api", type: "openapi" as const };
    const context = createMockContext({
      fleetYaml: createMockFleetYaml(),
    });
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(entity.kind).toBe("API");
    expect(entity.metadata.name).toBe("my-api");
  });

  it("should use default namespace from fleet.yaml", () => {
    const apiDef = { name: "my-api" };
    const context = createMockContext({
      fleetYaml: createMockFleetYaml({ defaultNamespace: "custom-ns" }),
    });
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(entity.metadata.namespace).toBe("custom-ns");
  });

  it("should set API type from definition", () => {
    const apiDef = { name: "my-api", type: "graphql" as const };
    const context = createMockContext();
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(getSpec(entity).type).toBe("graphql");
  });

  it("should use openapi as default type", () => {
    const apiDef = { name: "my-api" };
    const context = createMockContext();
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(getSpec(entity).type).toBe("openapi");
  });

  it("should include definition when provided", () => {
    const apiDef = {
      name: "my-api",
      definition: "openapi: 3.0.0\ninfo:\n  title: Test",
    };
    const context = createMockContext();
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(getSpec(entity).definition).toBe(
      "openapi: 3.0.0\ninfo:\n  title: Test",
    );
  });

  it("should reference definitionUrl when no definition", () => {
    const apiDef = {
      name: "my-api",
      definitionUrl: "https://example.com/api.yaml",
    };
    const context = createMockContext();
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(getSpec(entity).definition).toContain(
      "https://example.com/api.yaml",
    );
  });

  it("should include source GitRepo annotation", () => {
    const apiDef = { name: "my-api" };
    const context = createMockContext();
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);
    const annotations = entity.metadata.annotations as Record<string, string>;

    expect(annotations["fleet.cattle.io/source-gitrepo"]).toBe("my-app");
  });

  it("should use fleet.yaml owner", () => {
    const apiDef = { name: "my-api" };
    const context = createMockContext({
      fleetYaml: createMockFleetYaml(),
    });
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(getSpec(entity).owner).toBe("team-platform");
  });

  it("should include description from API definition", () => {
    const apiDef = { name: "my-api", description: "My custom API" };
    const context = createMockContext();
    const entity = mapApiDefinitionToApi(apiDef, "my-app", context);

    expect(entity.metadata.description).toBe("My custom API");
  });
});

// ============================================================================
// extractBundleMetadata Tests
// ============================================================================

describe("extractBundleMetadata", () => {
  it("should extract metadata from bundle labels", () => {
    const bundle = createMockBundle();
    const metadata = extractBundleMetadata(bundle);

    expect(metadata.gitRepoName).toBe("my-app");
    expect(metadata.bundlePath).toBe(".");
    expect(metadata.commitId).toBe("abc123");
  });

  it("should handle missing labels", () => {
    const bundle: FleetBundle = {
      metadata: { name: "test", labels: {} },
    };
    const metadata = extractBundleMetadata(bundle);

    expect(metadata.gitRepoName).toBeUndefined();
    expect(metadata.bundlePath).toBeUndefined();
    expect(metadata.commitId).toBeUndefined();
  });

  it("should handle missing metadata", () => {
    const bundle: FleetBundle = {};
    const metadata = extractBundleMetadata(bundle);

    expect(metadata.gitRepoName).toBeUndefined();
  });
});

// ============================================================================
// createEmptyBatch and flattenBatch Tests
// ============================================================================

describe("createEmptyBatch", () => {
  it("should create an empty batch", () => {
    const batch = createEmptyBatch();

    expect(batch.systems).toEqual([]);
    expect(batch.components).toEqual([]);
    expect(batch.resources).toEqual([]);
    expect(batch.apis).toEqual([]);
  });
});

describe("flattenBatch", () => {
  it("should flatten all entity arrays", () => {
    const batch = createEmptyBatch();
    batch.systems.push({ kind: "System" } as any);
    batch.components.push({ kind: "Component" } as any);
    batch.resources.push({ kind: "Resource" } as any);
    batch.apis.push({ kind: "API" } as any);

    const entities = flattenBatch(batch);

    expect(entities).toHaveLength(4);
    expect(entities[0].kind).toBe("System");
    expect(entities[1].kind).toBe("Component");
    expect(entities[2].kind).toBe("Resource");
    expect(entities[3].kind).toBe("API");
  });

  it("should return empty array for empty batch", () => {
    const batch = createEmptyBatch();
    const entities = flattenBatch(batch);

    expect(entities).toEqual([]);
  });
});
