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
  links?: Record<string, string>;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  caCert?: string;
  clusterCIDR?: string;
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
