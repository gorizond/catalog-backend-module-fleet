/**
 * Fleet Custom Resource Types
 * Based on fleet.cattle.io/v1alpha1
 */

// ============================================================================
// Kubernetes Common Types
// ============================================================================

export interface KubeMetadata {
  name?: string;
  namespace?: string;
  uid?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  creationTimestamp?: string;
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{
    key: string;
    operator: "In" | "NotIn" | "Exists" | "DoesNotExist";
    values?: string[];
  }>;
}

export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

// ============================================================================
// GitRepo Types
// ============================================================================

export interface GitRepoTarget {
  name?: string;
  clusterName?: string;
  clusterSelector?: LabelSelector;
  clusterGroup?: string;
}

export interface GitRepoTargetCustomization {
  name?: string;
  clusterName?: string;
  clusterSelector?: LabelSelector;
  clusterGroup?: string;
  helm?: {
    values?: Record<string, unknown>;
    valuesFiles?: string[];
  };
  kustomize?: {
    dir?: string;
  };
  yaml?: {
    overlays?: string[];
  };
}

export interface GitRepoSpec {
  repo?: string;
  branch?: string;
  revision?: string;
  paths?: string[];
  targets?: GitRepoTarget[];
  targetCustomizations?: GitRepoTargetCustomization[];
  pollingInterval?: string;
  insecureSkipTLSVerify?: boolean;
  clientSecretName?: string;
  helmSecretName?: string;
  caBundle?: string;
  forceSyncGeneration?: number;
  imageScanInterval?: string;
  helmRepoURLRegex?: string;
}

export interface GitRepoStatus {
  display?: {
    readyClusters?: string;
    state?: string;
    message?: string;
    error?: boolean;
  };
  summary?: {
    ready?: number;
    desiredReady?: number;
    notReady?: number;
    waitApplied?: number;
    errApplied?: number;
    outOfSync?: number;
    modified?: number;
    pending?: number;
  };
  conditions?: Condition[];
  resourceCounts?: {
    ready?: number;
    desiredReady?: number;
    waitApplied?: number;
    modified?: number;
    orphaned?: number;
    missing?: number;
    unknown?: number;
    notReady?: number;
  };
  gitJobStatus?: string;
  commit?: string;
  lastSyncedImageScanTime?: string;
  observedGeneration?: number;
}

export interface FleetGitRepo {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata;
  spec?: GitRepoSpec;
  status?: GitRepoStatus;
}

// ============================================================================
// Bundle Types
// ============================================================================

export interface BundleDependsOn {
  name?: string;
  selector?: LabelSelector;
}

export interface BundleSpec {
  targets?: GitRepoTarget[];
  dependsOn?: BundleDependsOn[];
  helm?: {
    chart?: string;
    repo?: string;
    version?: string;
    releaseName?: string;
    values?: Record<string, unknown>;
    valuesFiles?: string[];
  };
  kustomize?: {
    dir?: string;
  };
  resources?: Array<{
    name?: string;
    content?: string;
  }>;
  rolloutStrategy?: {
    maxUnavailable?: string | number;
    maxUnavailablePartitions?: string | number;
    autoPartitionSize?: string | number;
    partitions?: Array<{
      name?: string;
      maxUnavailable?: string | number;
      clusterSelector?: LabelSelector;
      clusterGroup?: string;
      clusterGroupSelector?: LabelSelector;
    }>;
  };
  defaultNamespace?: string;
  targetNamespace?: string;
  namespace?: string;
  serviceAccount?: string;
  paused?: boolean;
  correctDrift?: {
    enabled?: boolean;
    force?: boolean;
    keepFailHistory?: boolean;
  };
}

export interface BundleStatus {
  display?: {
    readyClusters?: string;
    state?: string;
  };
  summary?: {
    ready?: number;
    desiredReady?: number;
    notReady?: number;
    waitApplied?: number;
    errApplied?: number;
    outOfSync?: number;
    modified?: number;
    pending?: number;
  };
  conditions?: Condition[];
  resourceCounts?: {
    ready?: number;
    desiredReady?: number;
    waitApplied?: number;
    modified?: number;
    orphaned?: number;
    missing?: number;
    unknown?: number;
    notReady?: number;
  };
  partitions?: Array<{
    name?: string;
    count?: number;
    maxUnavailable?: number;
    unavailable?: number;
    summary?: {
      ready?: number;
      desiredReady?: number;
    };
  }>;
  observedGeneration?: number;
}

export interface FleetBundle {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata;
  spec?: BundleSpec;
  status?: BundleStatus;
}

// ============================================================================
// BundleDeployment Types
// ============================================================================

export type BundleDeploymentState =
  | "Ready"
  | "NotReady"
  | "Pending"
  | "OutOfSync"
  | "Modified"
  | "WaitApplied"
  | "ErrApplied";

export interface BundleDeploymentStatus {
  display?: {
    state?: BundleDeploymentState;
    message?: string;
    error?: boolean;
    modifiedStatus?: string;
  };
  conditions?: Condition[];
  ready?: boolean;
  appliedDeploymentID?: string;
  release?: string;
  resources?: Array<{
    kind?: string;
    apiVersion?: string;
    namespace?: string;
    name?: string;
    id?: string;
    state?: string;
    error?: boolean;
    message?: string;
  }>;
  syncGeneration?: number;
  nonReadyStatus?: Array<{
    uid?: string;
    name?: string;
    summary?: {
      state?: string;
      error?: boolean;
      transitioning?: boolean;
      message?: string[];
    };
  }>;
  modifiedStatus?: Array<{
    kind?: string;
    apiVersion?: string;
    namespace?: string;
    name?: string;
    delete?: boolean;
    create?: boolean;
    patch?: string;
  }>;
}

export interface FleetBundleDeployment {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata;
  spec?: {
    stagedOptions?: Record<string, unknown>;
    stagedDeploymentID?: string;
    options?: Record<string, unknown>;
    deploymentID?: string;
    dependsOn?: BundleDependsOn[];
  };
  status?: BundleDeploymentStatus;
}

// ============================================================================
// Cluster and ClusterGroup Types
// ============================================================================

export interface FleetCluster {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata;
  spec?: {
    kubeConfigSecret?: string;
    clientID?: string;
    redeployAgentGeneration?: number;
    agentEnvVars?: Array<{ name?: string; value?: string }>;
    agentNamespace?: string;
    privateRepoURL?: string;
    templateValues?: Record<string, string>;
    agentTolerations?: Array<Record<string, unknown>>;
    agentAffinity?: Record<string, unknown>;
    agentResources?: Record<string, unknown>;
  };
  status?: {
    display?: {
      state?: string;
      readyBundles?: string;
    };
    agent?: {
      lastSeen?: string;
      namespace?: string;
    };
    conditions?: Condition[];
    agentLastDeployed?: string;
    agentDeployedGeneration?: number;
    cattleNamespaceMigrated?: boolean;
  };
}

export interface FleetClusterGroup {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata;
  spec?: {
    selector?: LabelSelector;
  };
  status?: {
    display?: {
      readyBundles?: string;
      readyClusters?: string;
      state?: string;
    };
    clusterCount?: number;
    nonReadyClusterCount?: number;
    nonReadyClusters?: string[];
    conditions?: Condition[];
    summary?: {
      ready?: number;
      desiredReady?: number;
    };
  };
}

// ============================================================================
// fleet.yaml Types (from Git repository)
// ============================================================================

export interface FleetYamlApiDefinition {
  name: string;
  type?:
    | "openapi"
    | "asyncapi"
    | "graphql"
    | "grpc"
    | "database"
    | "prometheus"
    | string;
  description?: string;
  definition?: string;
  definitionUrl?: string;
}

export interface FleetYamlBackstage {
  /** Component type: 'service' (default), 'website', 'library', etc. */
  type?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  dependsOn?: string[];
  providesApis?: FleetYamlApiDefinition[];
  consumesApis?: string[];
  annotations?: Record<string, string>;
}

export interface FleetYaml {
  defaultNamespace?: string;
  namespace?: string;
  targetNamespace?: string;

  helm?: {
    repo?: string;
    chart?: string;
    version?: string;
    releaseName?: string;
    values?: Record<string, unknown>;
    valuesFiles?: string[];
    force?: boolean;
    takeOwnership?: boolean;
    maxHistory?: number;
    timeoutSeconds?: number;
    waitForJobs?: boolean;
    atomic?: boolean;
    disablePreProcess?: boolean;
    disableDNS?: boolean;
  };

  kustomize?: {
    dir?: string;
  };

  yaml?: {
    overlays?: string[];
  };

  diff?: {
    comparePatches?: Array<{
      kind?: string;
      apiVersion?: string;
      namespace?: string;
      name?: string;
      operations?: Array<{
        op?: string;
        path?: string;
        value?: unknown;
      }>;
      jsonPointers?: string[];
    }>;
  };

  dependsOn?: BundleDependsOn[];

  targetCustomizations?: GitRepoTargetCustomization[];

  paused?: boolean;
  rolloutStrategy?: BundleSpec["rolloutStrategy"];
  correctDrift?: BundleSpec["correctDrift"];

  // Backstage integration (custom section, ignored by Fleet)
  backstage?: FleetYamlBackstage;

  // Custom annotations for Backstage integrations
  annotations?: Record<string, string>;
}

// ============================================================================
// Provider Configuration Types
// ============================================================================

export interface FleetNamespaceConfig {
  name: string;
  labelSelector?: LabelSelector;
}

export interface FleetClusterConfig {
  name: string;
  url: string;
  token?: string;
  caData?: string;
  skipTLSVerify?: boolean;
  namespaces: FleetNamespaceConfig[];
  /** Include Bundle entities (default: true) */
  includeBundles?: boolean;
  /** Include BundleDeployment entities for per-cluster status (default: false) */
  includeBundleDeployments?: boolean;
  /** Generate API entities from fleet.yaml providesApis (default: false) */
  generateApis?: boolean;
  /** Fetch fleet.yaml from Git repository (default: false) */
  fetchFleetYaml?: boolean;
  /** Automatically add techdocs ref annotation (default: true) */
  autoTechdocsRef?: boolean;
  /** Label selector to filter GitRepos */
  gitRepoSelector?: LabelSelector;
}

export interface FleetProviderConfig {
  id: string;
  clusters: FleetClusterConfig[];
  schedule: {
    frequency: { minutes: number };
    timeout: { minutes: number };
    initialDelay?: { seconds: number };
  };
}

// ============================================================================
// Entity Generation Types
// ============================================================================

export interface GeneratedEntity {
  entity: Record<string, unknown>;
  locationKey: string;
}

export interface EntityGenerationContext {
  cluster: FleetClusterConfig;
  namespace: string;
  fleetYaml?: FleetYaml;
  gitRepo?: FleetGitRepo;
  bundle?: FleetBundle;
  bundleDeployment?: FleetBundleDeployment;
}

// ============================================================================
// Fleet Status Utilities
// ============================================================================

export const FLEET_STATUS_PRIORITY: Record<string, number> = {
  Ready: 0,
  NotReady: 1,
  Pending: 2,
  OutOfSync: 3,
  Modified: 4,
  WaitApplied: 5,
  ErrApplied: 6,
};

export function getWorstStatus(statuses: (string | undefined)[]): string {
  let worst = "Ready";
  let worstPriority = 0;

  for (const status of statuses) {
    if (!status) continue;
    const priority = FLEET_STATUS_PRIORITY[status] ?? 99;
    if (priority > worstPriority) {
      worstPriority = priority;
      worst = status;
    }
  }

  return worst;
}

export function statusToLifecycle(status?: string): string {
  switch (status) {
    case "Ready":
      return "production";
    case "Pending":
    case "WaitApplied":
      return "experimental";
    case "NotReady":
    case "OutOfSync":
    case "Modified":
    case "ErrApplied":
      return "deprecated";
    default:
      return "production";
  }
}
