/**
 * Fleet Kubernetes Client
 * Wrapper around @kubernetes/client-node for Fleet CRDs
 */

import {
  CustomObjectsApi,
  KubeConfig,
  CoreV1Api,
} from "@kubernetes/client-node";
import { LoggerService } from "@backstage/backend-plugin-api";
import {
  FleetGitRepo,
  FleetBundle,
  FleetBundleDeployment,
  FleetCluster,
  FleetClusterGroup,
  FleetClusterConfig,
  LabelSelector,
} from "./types";

const FLEET_API_GROUP = "fleet.cattle.io";
const FLEET_API_VERSION = "v1alpha1";

export interface FleetClientOptions {
  cluster: FleetClusterConfig;
  logger: LoggerService;
}

export interface ListOptions {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  continueToken?: string;
}

export class FleetClient {
  private readonly customApi: CustomObjectsApi;
  private readonly coreApi: CoreV1Api;
  private readonly logger: LoggerService;
  private readonly clusterName: string;

  constructor(options: FleetClientOptions) {
    const kc = this.createKubeConfig(options.cluster);
    this.customApi = kc.makeApiClient(CustomObjectsApi);
    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.logger = options.logger;
    this.clusterName = options.cluster.name;
  }

  private createKubeConfig(cluster: FleetClusterConfig): KubeConfig {
    const kc = new KubeConfig();

    kc.loadFromOptions({
      clusters: [
        {
          name: cluster.name,
          server: cluster.url,
          skipTLSVerify: cluster.skipTLSVerify,
          caData: cluster.caData,
        },
      ],
      users: [
        {
          name: `${cluster.name}-user`,
          token: cluster.token,
        },
      ],
      contexts: [
        {
          name: `${cluster.name}-context`,
          user: `${cluster.name}-user`,
          cluster: cluster.name,
        },
      ],
      currentContext: `${cluster.name}-context`,
    });

    return kc;
  }

  // ============================================================================
  // GitRepo Operations
  // ============================================================================

  async listGitRepos(options: ListOptions = {}): Promise<FleetGitRepo[]> {
    const { namespace, labelSelector, limit, continueToken } = options;

    try {
      if (namespace) {
        const res = await this.customApi.listNamespacedCustomObject(
          FLEET_API_GROUP,
          FLEET_API_VERSION,
          namespace,
          "gitrepos",
          undefined, // pretty
          undefined, // allowWatchBookmarks
          continueToken,
          undefined, // fieldSelector
          labelSelector,
          limit,
        );
        const body = res.body as { items?: FleetGitRepo[] };
        return body.items ?? [];
      }

      // List across all namespaces
      const res = await this.customApi.listClusterCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        "gitrepos",
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit,
      );
      const body = res.body as { items?: FleetGitRepo[] };
      return body.items ?? [];
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list GitRepos in ${namespace ?? "all namespaces"}: ${error}`,
      );
      return [];
    }
  }

  async getGitRepo(
    namespace: string,
    name: string,
  ): Promise<FleetGitRepo | undefined> {
    try {
      const res = await this.customApi.getNamespacedCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        namespace,
        "gitrepos",
        name,
      );
      return res.body as FleetGitRepo;
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to get GitRepo ${namespace}/${name}: ${error}`,
      );
      return undefined;
    }
  }

  // ============================================================================
  // Bundle Operations
  // ============================================================================

  async listBundles(options: ListOptions = {}): Promise<FleetBundle[]> {
    const { namespace, labelSelector, limit, continueToken } = options;

    try {
      if (namespace) {
        const res = await this.customApi.listNamespacedCustomObject(
          FLEET_API_GROUP,
          FLEET_API_VERSION,
          namespace,
          "bundles",
          undefined,
          undefined,
          continueToken,
          undefined,
          labelSelector,
          limit,
        );
        const body = res.body as { items?: FleetBundle[] };
        return body.items ?? [];
      }

      const res = await this.customApi.listClusterCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        "bundles",
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit,
      );
      const body = res.body as { items?: FleetBundle[] };
      return body.items ?? [];
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list Bundles in ${namespace ?? "all namespaces"}: ${error}`,
      );
      return [];
    }
  }

  async getBundle(
    namespace: string,
    name: string,
  ): Promise<FleetBundle | undefined> {
    try {
      const res = await this.customApi.getNamespacedCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        namespace,
        "bundles",
        name,
      );
      return res.body as FleetBundle;
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to get Bundle ${namespace}/${name}: ${error}`,
      );
      return undefined;
    }
  }

  async listBundlesForGitRepo(
    namespace: string,
    gitRepoName: string,
  ): Promise<FleetBundle[]> {
    return this.listBundles({
      namespace,
      labelSelector: `fleet.cattle.io/repo-name=${gitRepoName}`,
    });
  }

  // ============================================================================
  // BundleDeployment Operations
  // ============================================================================

  async listBundleDeployments(
    options: ListOptions = {},
  ): Promise<FleetBundleDeployment[]> {
    const { namespace, labelSelector, limit, continueToken } = options;

    try {
      if (namespace) {
        const res = await this.customApi.listNamespacedCustomObject(
          FLEET_API_GROUP,
          FLEET_API_VERSION,
          namespace,
          "bundledeployments",
          undefined,
          undefined,
          continueToken,
          undefined,
          labelSelector,
          limit,
        );
        const body = res.body as { items?: FleetBundleDeployment[] };
        return body.items ?? [];
      }

      const res = await this.customApi.listClusterCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        "bundledeployments",
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit,
      );
      const body = res.body as { items?: FleetBundleDeployment[] };
      return body.items ?? [];
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list BundleDeployments in ${namespace ?? "all namespaces"}: ${error}`,
      );
      return [];
    }
  }

  async listBundleDeploymentsForBundle(
    bundleName: string,
  ): Promise<FleetBundleDeployment[]> {
    // BundleDeployments are in cluster-specific namespaces like:
    // cluster-fleet-default-<cluster-name>
    return this.listBundleDeployments({
      labelSelector: `fleet.cattle.io/bundle-name=${bundleName}`,
    });
  }

  async getBundleDeployment(
    namespace: string,
    name: string,
  ): Promise<FleetBundleDeployment | undefined> {
    try {
      const res = await this.customApi.getNamespacedCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        namespace,
        "bundledeployments",
        name,
      );
      return res.body as FleetBundleDeployment;
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to get BundleDeployment ${namespace}/${name}: ${error}`,
      );
      return undefined;
    }
  }

  // ============================================================================
  // Cluster Operations
  // ============================================================================

  async listClusters(options: ListOptions = {}): Promise<FleetCluster[]> {
    const { namespace, labelSelector, limit, continueToken } = options;

    try {
      if (namespace) {
        const res = await this.customApi.listNamespacedCustomObject(
          FLEET_API_GROUP,
          FLEET_API_VERSION,
          namespace,
          "clusters",
          undefined,
          undefined,
          continueToken,
          undefined,
          labelSelector,
          limit,
        );
        const body = res.body as { items?: FleetCluster[] };
        return body.items ?? [];
      }

      const res = await this.customApi.listClusterCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        "clusters",
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit,
      );
      const body = res.body as { items?: FleetCluster[] };
      return body.items ?? [];
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list Clusters: ${error}`,
      );
      return [];
    }
  }

  async getCluster(
    namespace: string,
    name: string,
  ): Promise<FleetCluster | undefined> {
    try {
      const res = await this.customApi.getNamespacedCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        namespace,
        "clusters",
        name,
      );
      return res.body as FleetCluster;
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to get Cluster ${namespace}/${name}: ${error}`,
      );
      return undefined;
    }
  }

  // ============================================================================
  // ClusterGroup Operations
  // ============================================================================

  async listClusterGroups(
    options: ListOptions = {},
  ): Promise<FleetClusterGroup[]> {
    const { namespace, labelSelector, limit, continueToken } = options;

    try {
      if (namespace) {
        const res = await this.customApi.listNamespacedCustomObject(
          FLEET_API_GROUP,
          FLEET_API_VERSION,
          namespace,
          "clustergroups",
          undefined,
          undefined,
          continueToken,
          undefined,
          labelSelector,
          limit,
        );
        const body = res.body as { items?: FleetClusterGroup[] };
        return body.items ?? [];
      }

      const res = await this.customApi.listClusterCustomObject(
        FLEET_API_GROUP,
        FLEET_API_VERSION,
        "clustergroups",
        undefined,
        undefined,
        continueToken,
        undefined,
        labelSelector,
        limit,
      );
      const body = res.body as { items?: FleetClusterGroup[] };
      return body.items ?? [];
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list ClusterGroups: ${error}`,
      );
      return [];
    }
  }

  // ============================================================================
  // Namespace Operations (for Fleet workspace discovery)
  // ============================================================================

  async listFleetNamespaces(): Promise<string[]> {
    try {
      const res = await this.coreApi.listNamespace(
        undefined,
        undefined,
        undefined,
        undefined,
        "fleet.cattle.io/managed=true",
      );
      return res.body.items
        .map((ns: { metadata?: { name?: string } }) => ns.metadata?.name)
        .filter((name: string | undefined): name is string => Boolean(name));
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list Fleet namespaces: ${error}`,
      );
      return [];
    }
  }

  async listNamespacesWithPattern(pattern: string): Promise<string[]> {
    try {
      const res = await this.coreApi.listNamespace();
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      return res.body.items
        .map((ns: { metadata?: { name?: string } }) => ns.metadata?.name)
        .filter((name: string | undefined): name is string => Boolean(name))
        .filter((name: string) => regex.test(name));
    } catch (error) {
      this.logger.warn(
        `[FleetClient:${this.clusterName}] Failed to list namespaces with pattern ${pattern}: ${error}`,
      );
      return [];
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Extract target cluster IDs from BundleDeployment namespaces
   * Namespace format: cluster-fleet-<workspace>-<cluster-id>
   */
  static extractClusterIdFromNamespace(namespace: string): string | undefined {
    const match = namespace.match(/^cluster-fleet-(?:default|local)-(.+)$/);
    return match ? match[1] : undefined;
  }

  /**
   * Get all target cluster IDs for a bundle by examining its BundleDeployments
   */
  async getTargetClusterIds(bundleName: string): Promise<string[]> {
    const deployments = await this.listBundleDeploymentsForBundle(bundleName);

    const clusterIds = deployments
      .map((bd) =>
        FleetClient.extractClusterIdFromNamespace(bd.metadata?.namespace ?? ""),
      )
      .filter((id): id is string => Boolean(id));

    return [...new Set(clusterIds)];
  }

  /**
   * Get deployment status per cluster for a bundle
   */
  async getBundleDeploymentStatusByCluster(
    bundleName: string,
  ): Promise<Map<string, FleetBundleDeployment>> {
    const deployments = await this.listBundleDeploymentsForBundle(bundleName);
    const statusMap = new Map<string, FleetBundleDeployment>();

    for (const bd of deployments) {
      const clusterId = FleetClient.extractClusterIdFromNamespace(
        bd.metadata?.namespace ?? "",
      );
      if (clusterId) {
        statusMap.set(clusterId, bd);
      }
    }

    return statusMap;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

export function selectorToString(selector?: LabelSelector): string | undefined {
  if (!selector?.matchLabels && !selector?.matchExpressions) {
    return undefined;
  }

  const parts: string[] = [];

  if (selector.matchLabels) {
    for (const [key, value] of Object.entries(selector.matchLabels)) {
      parts.push(`${key}=${value}`);
    }
  }

  if (selector.matchExpressions) {
    for (const expr of selector.matchExpressions) {
      switch (expr.operator) {
        case "In":
          parts.push(`${expr.key} in (${expr.values?.join(",") ?? ""})`);
          break;
        case "NotIn":
          parts.push(`${expr.key} notin (${expr.values?.join(",") ?? ""})`);
          break;
        case "Exists":
          parts.push(expr.key);
          break;
        case "DoesNotExist":
          parts.push(`!${expr.key}`);
          break;
      }
    }
  }

  return parts.length > 0 ? parts.join(",") : undefined;
}

export function createFleetClient(
  cluster: FleetClusterConfig,
  logger: LoggerService,
): FleetClient {
  return new FleetClient({ cluster, logger });
}
