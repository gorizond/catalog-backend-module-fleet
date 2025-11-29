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
import fetch from "node-fetch";

type ClusterLocatorEntry = {
  name: string;
  url: string;
  authProvider: "serviceAccount";
  serviceAccountToken: string;
  caData?: string;
  skipTLSVerify?: boolean;
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

  private constructor(opts: {
    logger: LoggerService;
    rancherUrl: string;
    rancherToken: string;
    skipTLSVerify: boolean;
    includeLocal: boolean;
  }) {
    this.logger = opts.logger.child({ module: "fleet-k8s-locator" });
    this.rancherUrl = opts.rancherUrl.replace(/\/$/, "");
    this.rancherToken = opts.rancherToken;
    this.skipTLSVerify = opts.skipTLSVerify;
    this.includeLocal = opts.includeLocal;
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

    return new FleetK8sLocator({
      logger,
      rancherUrl,
      rancherToken,
      skipTLSVerify,
      includeLocal,
    });
  }

  /**
   * Returns cluster locator entries suitable for Backstage kubernetes plugin
   * (type: config).
   */
  async listClusters(): Promise<ClusterLocatorEntry[]> {
    const clusters = await this.fetchRancherClusters();
    const entries: ClusterLocatorEntry[] = [];

    for (const c of clusters) {
      if (c.id === "local" && !this.includeLocal) continue;

      const apiUrl = `${this.rancherUrl}/k8s/clusters/${c.id}`;
      entries.push({
        name: c.name || c.id,
        url: apiUrl,
        authProvider: "serviceAccount",
        serviceAccountToken: this.rancherToken,
        caData: c.caCert,
        skipTLSVerify: this.skipTLSVerify,
      });
    }

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
    return data.data ?? [];
  }
}
