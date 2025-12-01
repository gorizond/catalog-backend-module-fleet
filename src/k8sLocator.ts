/**
 * Fleet Kubernetes Locator
 *
 * Dynamically discovers Rancher downstream clusters and exposes them as
 * Backstage Kubernetes cluster definitions. Uses a single Rancher token that
 * has access to all downstream clusters; does not mint per-cluster service
 * accounts. Include `local` management cluster as well.
 */

import { Config } from "@backstage/config";
import { LoggerService } from "@backstage/backend-plugin-api";
import { CustomResourceMatcher } from "@backstage/plugin-kubernetes-common";
import fetch from "node-fetch";
import https from "https";
import type { V1Node } from "@kubernetes/client-node";

type ClusterLocatorEntry = {
  name: string;
  url: string;
  authProvider: "serviceAccount";
  serviceAccountToken: string;
  caData?: string;
  skipTLSVerify?: boolean;
  customResources?: CustomResourceMatcher[];
};

type RancherCluster = {
  id: string;
  name?: string;
  namespace?: string;
  links?: Record<string, string>;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  driver?: string;
  provider?: string;
  caCert?: string;
  clusterCIDR?: string;
  state?: string;
  transitioning?: string;
  transitioningMessage?: string;
  conditions?: Array<{
    type?: string;
    status?: string;
    message?: string;
    reason?: string;
    lastUpdateTime?: string;
    lastTransitionTime?: string;
  }>;
  rancherKubernetesEngineConfig?: {
    kubernetesVersion?: string;
    services?: {
      etcd?: {
        backupConfig?: Record<string, unknown>;
      };
    };
  };
};

type HarvesterVirtualMachine = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    runStrategy?: string;
    template?: {
      spec?: {
        domain?: {
          cpu?: { cores?: number };
          resources?: {
            requests?: Record<string, string>;
            limits?: Record<string, string>;
          };
        };
      };
    };
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
    conditions?: Array<Record<string, unknown>>;
  };
};

type RancherNode = {
  id?: string;
  nodeName?: string;
  hostname?: string;
  name?: string;
};

type MachineDeployment = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { labels?: Record<string, string> };
    };
  };
  status?: {
    availableReplicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
  };
};

export interface FleetK8sLocatorOptions {
  logger: LoggerService;
  config: Config;
}

/**
 * Discover Rancher downstream clusters using a single Rancher token.
 */
export class FleetK8sLocator {
  private readonly logger: LoggerService;
  private readonly rancherUrl: string;
  private readonly rancherToken: string;
  private readonly skipTLSVerify: boolean;
  private readonly includeLocal: boolean;
  private readonly fleetNamespaces: string[];

  private constructor(opts: {
    logger: LoggerService;
    rancherUrl: string;
    rancherToken: string;
    skipTLSVerify: boolean;
    includeLocal: boolean;
    fleetNamespaces: string[];
  }) {
    this.logger = opts.logger.child({ module: "fleet-k8s-locator" });
    this.rancherUrl = opts.rancherUrl.replace(/\/$/, "");
    this.rancherToken = opts.rancherToken;
    this.skipTLSVerify = opts.skipTLSVerify;
    this.includeLocal = opts.includeLocal;
    this.fleetNamespaces = opts.fleetNamespaces;
  }

  static fromConfig({
    logger,
    config,
  }: FleetK8sLocatorOptions): FleetK8sLocator | undefined {
    const enabled = config.getOptionalBoolean(
      "catalog.providers.fleetK8sLocator.enabled",
    );
    if (enabled === false) {
      logger.info("FleetK8sLocator disabled via config");
      return undefined;
    }

    const rancherUrl = config.getOptionalString(
      "catalog.providers.fleetK8sLocator.rancherUrl",
    );
    const rancherToken = config.getOptionalString(
      "catalog.providers.fleetK8sLocator.rancherToken",
    );

    if (!rancherUrl || !rancherToken) {
      logger.warn(
        "FleetK8sLocator: missing rancherUrl or rancherToken; locator disabled",
      );
      return undefined;
    }

    const skipTLSVerify =
      config.getOptionalBoolean(
        "catalog.providers.fleetK8sLocator.skipTLSVerify",
      ) ?? false;
    const includeLocal =
      config.getOptionalBoolean(
        "catalog.providers.fleetK8sLocator.includeLocal",
      ) ?? true;
    const fleetNamespaces = config.getOptionalStringArray(
      "catalog.providers.fleetK8sLocator.fleetNamespaces",
    ) ?? ["fleet-default", "fleet-local"];

    return new FleetK8sLocator({
      logger,
      rancherUrl,
      rancherToken,
      skipTLSVerify,
      includeLocal,
      fleetNamespaces,
    });
  }

  /**
   * Returns cluster locator entries suitable for Backstage kubernetes plugin
   * (type: config).
   */
  async listClusters(): Promise<ClusterLocatorEntry[]> {
    const clusters = await this.fetchRancherClusters();
    const bundleDeployments = await this.fetchBundleDeployments();
    const customResourcesByCluster =
      this.buildCustomResourcesByCluster(bundleDeployments);
    const entries: ClusterLocatorEntry[] = [];

    for (const c of clusters) {
      if (c.id === "local" && !this.includeLocal) continue;

      const apiUrl = `${this.rancherUrl}/k8s/clusters/${c.id}`;
      const clusterName = c.name || c.id;
      const cr =
        customResourcesByCluster.get(clusterName) ??
        customResourcesByCluster.get(c.id) ??
        [];
      entries.push({
        name: clusterName,
        url: apiUrl,
        authProvider: "serviceAccount",
        serviceAccountToken: this.rancherToken,
        caData: c.caCert,
        skipTLSVerify: this.skipTLSVerify,
        customResources: cr.length > 0 ? cr : undefined,
      });
    }

    this.logger.debug(
      `FleetK8sLocator returning ${entries.length} clusters: ${entries
        .map((c) => `${c.name} -> ${c.url}`)
        .join(", ")}`,
    );

    return entries;
  }

  /**
   * Returns lightweight cluster summaries (id + friendly name) without CRD scanning.
   */
  async listClusterSummaries(): Promise<Array<{ id: string; name?: string }>> {
    const clusters = await this.fetchRancherClusters();
    return clusters
      .filter((c) => (this.includeLocal ? true : c.id !== "local"))
      .map((c) => ({ id: c.id, name: c.name }));
  }

  async listRancherClusterDetails(): Promise<RancherCluster[]> {
    const clusters = await this.fetchRancherClusters();
    return clusters.filter((c) =>
      this.includeLocal ? true : c.id !== "local",
    );
  }

  /**
   * Return Rancher nodes grouped by cluster for use in catalog sync.
   */
  async listClusterNodes(): Promise<
    Array<{
      clusterId: string;
      clusterName?: string;
      nodes: RancherNode[];
    }>
  > {
    const clusters = await this.fetchRancherClusters();
    const agent = this.buildAgent();

    const results: Array<{
      clusterId: string;
      clusterName?: string;
      nodes: RancherNode[];
    }> = [];

    for (const cluster of clusters) {
      if (!cluster.id) continue;
      if (cluster.id === "local" && !this.includeLocal) continue;
      try {
        const nodes = await this.fetchClusterNodes(cluster.id, agent);
        results.push({
          clusterId: cluster.id,
          clusterName: cluster.name,
          nodes,
        });
      } catch (e) {
        this.logger.debug(
          `FleetK8sLocator failed to fetch nodes for cluster ${cluster.id}: ${e}`,
        );
      }
    }

    return results;
  }

  /**
   * Return detailed Kubernetes nodes grouped by cluster (full Node objects).
   */
  async listClusterNodesDetailed(): Promise<
    Array<{ clusterId: string; clusterName?: string; nodes: V1Node[] }>
  > {
    const clusters = await this.fetchRancherClusters();
    const results: Array<{
      clusterId: string;
      clusterName?: string;
      nodes: V1Node[];
    }> = [];

    for (const cluster of clusters) {
      if (!cluster.id) continue;
      if (cluster.id === "local" && !this.includeLocal) continue;
      const agent = this.buildAgent(cluster.caCert);
      const base = `${this.rancherUrl}/k8s/clusters/${cluster.id}`;
      try {
        const data = await this.fetchJson<{ items?: V1Node[] }>(
          `${base}/api/v1/nodes?limit=500`,
          agent,
        );
        results.push({
          clusterId: cluster.id,
          clusterName: cluster.name,
          nodes: data?.items ?? [],
        });
      } catch (e) {
        this.logger.debug(
          `FleetK8sLocator failed to fetch detailed nodes for cluster ${cluster.id}: ${e}`,
        );
      }
    }

    return results;
  }

  /**
   * Return MachineDeployments grouped by cluster (if Cluster API is installed).
   */
  async listClusterMachineDeployments(): Promise<
    Array<{
      clusterId: string;
      clusterName?: string;
      items: MachineDeployment[];
    }>
  > {
    const clusters = await this.fetchRancherClusters();
    const results: Array<{
      clusterId: string;
      clusterName?: string;
      items: MachineDeployment[];
    }> = [];

    for (const cluster of clusters) {
      if (!cluster.id) continue;
      if (cluster.id === "local" && !this.includeLocal) continue;
      const agent = this.buildAgent(cluster.caCert);
      const base = `${this.rancherUrl}/k8s/clusters/${cluster.id}`;
      try {
        const data = await this.fetchJson<{ items?: MachineDeployment[] }>(
          `${base}/apis/cluster.x-k8s.io/v1beta1/machinedeployments?limit=500`,
          agent,
        );
        if (data?.items?.length) {
          results.push({
            clusterId: cluster.id,
            clusterName: cluster.name,
            items: data.items,
          });
        }
      } catch (e) {
        this.logger.debug(
          `FleetK8sLocator failed to fetch MachineDeployments for cluster ${cluster.id}: ${e}`,
        );
      }
    }

    return results;
  }

  async listClusterVersions(): Promise<
    Array<{ clusterId: string; clusterName?: string; version?: string }>
  > {
    const clusters = await this.fetchRancherClusters();
    const results: Array<{
      clusterId: string;
      clusterName?: string;
      version?: string;
    }> = [];

    for (const cluster of clusters) {
      if (!cluster.id) continue;
      if (cluster.id === "local" && !this.includeLocal) continue;
      const agent = this.buildAgent(cluster.caCert);
      const base = `${this.rancherUrl}/k8s/clusters/${cluster.id}`;
      try {
        const data = await this.fetchJson<{ gitVersion?: string }>(
          `${base}/version`,
          agent,
        );
        results.push({
          clusterId: cluster.id,
          clusterName: cluster.name,
          version: data?.gitVersion,
        });
      } catch (e) {
        this.logger.debug(
          `FleetK8sLocator failed to fetch version for cluster ${cluster.id}: ${e}`,
        );
      }
    }

    return results;
  }

  async listHarvesterVirtualMachines(): Promise<
    Array<{
      clusterId: string;
      clusterName?: string;
      items: HarvesterVirtualMachine[];
    }>
  > {
    const clusters = await this.fetchRancherClusters();
    const harvesterClusters = clusters.filter(
      (c) =>
        c.labels?.["provider.cattle.io"] === "harvester" ||
        c.provider === "harvester" ||
        c.driver === "harvester",
    );
    const results: Array<{
      clusterId: string;
      clusterName?: string;
      items: HarvesterVirtualMachine[];
    }> = [];

    for (const cluster of harvesterClusters) {
      if (!cluster.id) continue;
      if (cluster.id === "local" && !this.includeLocal) continue;
      const agent = this.buildAgent(cluster.caCert);
      const base = `${this.rancherUrl}/k8s/clusters/${cluster.id}`;
      try {
        const data = await this.fetchJson<{
          items?: HarvesterVirtualMachine[];
        }>(`${base}/apis/kubevirt.io/v1/virtualmachines?limit=500`, agent);
        if (data?.items?.length) {
          results.push({
            clusterId: cluster.id,
            clusterName: cluster.name,
            items: data.items,
          });
        }
      } catch (e) {
        this.logger.debug(
          `FleetK8sLocator failed to fetch Harvester VMs for cluster ${cluster.id}: ${e}`,
        );
      }
    }

    return results;
  }

  /**
   * Convert to Backstage kubernetes.clusterLocatorMethods (type: config).
   */
  async asClusterLocatorMethods(): Promise<
    Array<{
      type: "config";
      clusters: ClusterLocatorEntry[];
    }>
  > {
    const clusters = await this.listClusters();
    return [
      {
        type: "config",
        clusters,
      },
    ];
  }

  private async fetchRancherClusters(): Promise<RancherCluster[]> {
    const url = `${this.rancherUrl}/v3/clusters`;
    this.logger.debug(`FleetK8sLocator fetching clusters from ${url}`);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.rancherToken}`,
        Accept: "application/json",
      },
      agent:
        this.skipTLSVerify === true
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
      // TLS verify controlled by global agent (set NODE_TLS_REJECT_UNAUTHORIZED if needed)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to fetch Rancher clusters: ${res.status} ${res.statusText} ${text}`,
      );
    }

    const data = (await res.json()) as { data?: RancherCluster[] };
    this.logger.debug(
      `FleetK8sLocator received ${data.data?.length ?? 0} clusters`,
    );
    return data.data ?? [];
  }

  private async fetchClusterNodes(
    clusterId: string,
    agent?: https.Agent,
  ): Promise<RancherNode[]> {
    const url = `${this.rancherUrl}/v3/clusters/${clusterId}/nodes`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.rancherToken}`,
        Accept: "application/json",
      },
      agent,
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.debug(
        `FleetK8sLocator failed to fetch nodes for ${clusterId}: ${res.status} ${res.statusText} ${text}`,
      );
      return [];
    }

    const data = (await res.json()) as { data?: RancherNode[] };
    return data.data ?? [];
  }

  private buildAgent(caData?: string): https.Agent | undefined {
    const agentOptions: https.AgentOptions = {
      rejectUnauthorized: this.skipTLSVerify ? false : true,
    };

    if (caData) {
      try {
        agentOptions.ca = Buffer.from(caData, "base64");
      } catch {
        agentOptions.ca = caData;
      }
    }

    return new https.Agent(agentOptions);
  }

  private async fetchJson<T>(
    url: string,
    agent?: https.Agent,
  ): Promise<T | undefined> {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.rancherToken}`,
        Accept: "application/json",
      },
      agent,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText} ${text}`);
    }

    return (await res.json()) as T;
  }

  private async fetchBundleDeployments(): Promise<
    Array<{
      metadata?: { namespace?: string; labels?: Record<string, string> };
      status?: {
        resources?: Array<{
          kind?: string;
          apiVersion?: string;
        }>;
      };
    }>
  > {
    const deployments: Array<{
      metadata?: { namespace?: string; labels?: Record<string, string> };
      status?: { resources?: Array<{ kind?: string; apiVersion?: string }> };
    }> = [];
    for (const ns of this.fleetNamespaces) {
      const url = `${this.rancherUrl}/k8s/clusters/local/apis/fleet.cattle.io/v1alpha1/namespaces/${ns}/bundledeployments?limit=500`;
      this.logger.debug(
        `FleetK8sLocator fetching BundleDeployments from ${ns} (${url})`,
      );
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.rancherToken}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(
          `FleetK8sLocator failed to fetch BundleDeployments from ${ns}: ${res.status} ${res.statusText} ${text}`,
        );
        continue;
      }

      const data = (await res.json()) as {
        items?: Array<{
          metadata?: { namespace?: string; labels?: Record<string, string> };
          status?: {
            resources?: Array<{ kind?: string; apiVersion?: string }>;
          };
        }>;
      };
      deployments.push(...(data.items ?? []));
    }
    return deployments;
  }

  private buildCustomResourcesByCluster(
    bundleDeployments: Array<{
      metadata?: { namespace?: string; labels?: Record<string, string> };
      status?: { resources?: Array<{ kind?: string; apiVersion?: string }> };
    }>,
  ): Map<string, CustomResourceMatcher[]> {
    const map = new Map<string, CustomResourceMatcher[]>();

    for (const bd of bundleDeployments) {
      const bdNamespace = bd?.metadata?.namespace ?? "";
      const clusterName =
        extractClusterNameFromBundleDeploymentNamespace(bdNamespace);
      const clusterId =
        bd?.metadata?.labels?.["fleet.cattle.io/cluster-name"] ?? clusterName;
      if (!clusterName && !clusterId) continue;

      const resources =
        bd?.status?.resources ??
        ([] as Array<{ kind?: string; apiVersion?: string }>);
      for (const r of resources) {
        const apiVersion = r?.apiVersion as string | undefined;
        const kind = r?.kind as string | undefined;
        if (!apiVersion || !kind) continue;

        const [group, version] = apiVersion.includes("/")
          ? apiVersion.split("/")
          : ["", apiVersion];

        // Skip core/built-in groups to avoid noise
        if (group === "" || BUILTIN_GROUPS.has(group)) continue;

        const plural = derivePluralFromKind(kind);
        const matcher: CustomResourceMatcher = {
          group,
          apiVersion: version,
          plural,
        };

        const listKey = clusterId ?? clusterName;
        const list = listKey ? (map.get(listKey) ?? []) : [];
        if (!list.find((cr) => isSameCustomResource(cr, matcher))) {
          list.push(matcher);
          if (listKey) {
            map.set(listKey, list);
          }
          if (clusterName && clusterId && clusterId !== clusterName) {
            // Keep both keys pointing to the same array to avoid duplication
            map.set(clusterName, list);
          }
        }
      }
    }

    return map;
  }
}

const BUILTIN_GROUPS = new Set([
  "apps",
  "batch",
  "extensions",
  "networking.k8s.io",
  "policy",
  "rbac.authorization.k8s.io",
  "autoscaling",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "apiextensions.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "certificates.k8s.io",
  "authentication.k8s.io",
  "authorization.k8s.io",
]);

function extractClusterNameFromBundleDeploymentNamespace(
  namespace: string,
): string | undefined {
  const match = namespace.match(/^cluster-fleet-(?:default|local)-(.+)$/);
  return match?.[1];
}

function derivePluralFromKind(kind: string): string {
  const base = kind.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (base.endsWith("s")) return base;
  if (base.endsWith("y")) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

function isSameCustomResource(
  a: CustomResourceMatcher,
  b: CustomResourceMatcher,
): boolean {
  return (
    a.group === b.group &&
    a.apiVersion === b.apiVersion &&
    a.plural === b.plural
  );
}
