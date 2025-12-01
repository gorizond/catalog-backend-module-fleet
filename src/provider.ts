/**
 * Fleet Entity Provider
 * Provides Backstage Catalog entities from Rancher Fleet GitOps resources
 *
 * Entity Mapping:
 * - Fleet Cluster (config) → Domain
 * - GitRepo → System
 * - Bundle → Component (type: service)
 * - BundleDeployment → Resource (type: fleet-deployment)
 */

import { Duration } from "luxon";
import {
  LoggerService,
  SchedulerServiceTaskScheduleDefinition,
} from "@backstage/backend-plugin-api";
import { Config } from "@backstage/config";
import {
  EntityProvider,
  EntityProviderConnection,
} from "@backstage/plugin-catalog-node";
import { stringifyEntityRef } from "@backstage/catalog-model";
import pLimit from "p-limit";
import fetch from "node-fetch";
import https from "https";

import {
  FleetGitRepo,
  FleetBundle,
  FleetYaml,
  FleetClusterConfig,
  FleetNamespaceConfig,
  LabelSelector,
} from "./types";

import {
  FleetClient,
  selectorToString,
  createFleetClient,
} from "./FleetClient";

import {
  mapFleetClusterToDomain,
  mapGitRepoToSystem,
  mapBundleToComponent,
  mapBundleDeploymentToResource,
  mapApiDefinitionToApi,
  MapperContext,
  EntityBatch,
  createEmptyBatch,
  flattenBatch,
  mapClusterToResource,
  mapNodeToResource,
  mapMachineDeploymentToResource,
  mapVirtualMachineToResource,
  extractWorkspaceNamespaceFromBundleDeploymentNamespace,
} from "./entityMapper";
import { Entity } from "@backstage/catalog-model";
import type { FleetK8sLocator } from "./k8sLocator";

function deriveFriendlyClusterName(clusterId: string): string | undefined {
  // Fleet appends a random suffix to downstream cluster IDs (e.g., staging-000-edd3151847f4)
  const match = clusterId.match(/^(.*?)-[a-f0-9]{12}$/);
  return match ? match[1] : undefined;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface FleetProviderFactoryOptions {
  logger: LoggerService;
  k8sLocator?: FleetK8sLocator;
}

export interface FleetProviderOptions {
  id: string;
  clusters: FleetClusterConfig[];
  schedule: SchedulerServiceTaskScheduleDefinition;
  logger: LoggerService;
  concurrency?: number;
  k8sLocator?: FleetK8sLocator;
}

// ============================================================================
// Fleet Entity Provider
// ============================================================================

export class FleetEntityProvider implements EntityProvider {
  private readonly logger: LoggerService;
  private readonly clusters: FleetClusterConfig[];
  private readonly schedule: SchedulerServiceTaskScheduleDefinition;
  private readonly locationKey: string;
  private readonly concurrency: number;
  private readonly k8sLocator?: FleetK8sLocator;
  private connection?: EntityProviderConnection;
  private clusterNameMap?: Map<string, string>;
  private readonly clusterWorkspaces: Map<string, Set<string>> = new Map();
  private clusterStats?: Map<
    string,
    {
      version?: string;
      nodeCount?: number;
      readyNodeCount?: number;
      machineDeploymentCount?: number;
      vmCount?: number;
      state?: string;
      transitioning?: string;
      transitioningMessage?: string;
      conditions?: Array<Record<string, unknown>>;
      etcdBackupConfig?: Record<string, unknown>;
      driver?: string;
    }
  >;

  private addDiscoveredClustersToBatch(batch: EntityBatch): void {
    if (!this.clusterNameMap || this.clusterNameMap.size === 0) {
      return;
    }
    const cluster = this.clusters[0];
    if (!cluster) return;
    const context: MapperContext = {
      cluster,
      locationKey: this.locationKey,
      autoTechdocsRef: cluster.autoTechdocsRef,
    };
    for (const [clusterId, clusterName] of this.clusterNameMap.entries()) {
      const stats = this.clusterStats?.get(clusterId);
      const workspaceNamespace = this.getPrimaryWorkspace(clusterId);
      const entity = mapClusterToResource(
        clusterId,
        clusterName,
        workspaceNamespace,
        context,
        stats,
      );
      batch.resources.push(entity);
    }
  }

  private async addNodesViaRancher(batch: EntityBatch): Promise<void> {
    if (!this.clusterNameMap || this.clusterNameMap.size === 0) return;
    const cfg = this.clusters[0];
    if (!cfg?.url || !cfg?.token) return;

    const rancherBase = cfg.url.replace(/\/k8s\/clusters\/.+$/, "");
    const agent = new https.Agent({
      rejectUnauthorized: cfg.skipTLSVerify === true ? false : true,
    });

    for (const [clusterId, clusterName] of this.clusterNameMap.entries()) {
      try {
        const res = await fetch(
          `${rancherBase}/v3/clusters/${clusterId}/nodes`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${cfg.token}`,
              Accept: "application/json",
            },
            agent,
          },
        );
        if (!res.ok) {
          this.logger.debug(
            `Failed to fetch nodes for cluster ${clusterId}: ${res.status} ${res.statusText}`,
          );
          continue;
        }
        const data = (await res.json()) as {
          data?: Array<{
            id?: string;
            nodeName?: string;
            hostname?: string;
            name?: string;
          }>;
        };
        const nodes = data.data ?? [];
        if (nodes.length === 0) continue;

        const cluster = this.clusters[0];
        const context: MapperContext = {
          cluster,
          locationKey: this.locationKey,
          autoTechdocsRef: cluster.autoTechdocsRef,
        };
        const workspaceNamespace = this.getPrimaryWorkspace(clusterId);

        for (const node of nodes) {
          const nodeId = node.id ?? node.nodeName ?? node.name;
          if (!nodeId) continue;
          const nodeName = node.nodeName ?? node.hostname ?? node.name;
          const entity = mapNodeToResource({
            nodeId,
            nodeName,
            clusterId,
            clusterName,
            workspaceNamespace,
            context,
          });
          batch.resources.push(entity);
        }

        const stats = this.clusterStats?.get(clusterId) ?? {};
        stats.nodeCount = nodes.length;
        this.clusterStats?.set(clusterId, stats);
      } catch (e) {
        this.logger.debug(`Failed to load nodes for ${clusterId}: ${e}`);
      }
    }
  }

  /**
   * Create FleetEntityProvider instances from configuration
   */
  static fromConfig(
    config: Config,
    options: FleetProviderFactoryOptions,
  ): FleetEntityProvider[] {
    const providersConfig = config.getOptionalConfig("catalog.providers.fleet");
    if (!providersConfig) {
      options.logger.info("No Fleet provider configuration found");
      return [];
    }

    // Check if it's an array of providers or a single provider
    const providerKeys = providersConfig.keys();

    // If keys look like array indices or provider IDs
    const isMultiProvider = providerKeys.some(
      (key: string) =>
        providersConfig.getOptionalConfig(key)?.has("clusters") ||
        providersConfig.getOptionalConfig(key)?.has("namespaces"),
    );

    if (isMultiProvider) {
      // Multiple named providers
      return providerKeys.map((key: string) => {
        const providerConfig = providersConfig.getConfig(key);
        return FleetEntityProvider.createFromConfig(
          key,
          providerConfig,
          options,
        );
      });
    }

    // Single provider configuration
    return [
      FleetEntityProvider.createFromConfig("default", providersConfig, options),
    ];
  }

  private static createFromConfig(
    id: string,
    config: Config,
    options: FleetProviderFactoryOptions,
  ): FleetEntityProvider {
    const clusters = readClusters(config);
    const schedule = readSchedule(config.getOptionalConfig("schedule"));
    const concurrency = config.getOptionalNumber("concurrency") ?? 3;

    options.logger.info(
      `Creating FleetEntityProvider[${id}] with ${clusters.length} cluster(s)`,
    );

    return new FleetEntityProvider({
      id,
      clusters,
      schedule,
      logger: options.logger,
      concurrency,
      k8sLocator: options.k8sLocator,
    });
  }

  constructor(options: FleetProviderOptions) {
    this.logger = options.logger.child({ plugin: "fleet-entity-provider" });
    this.clusters = options.clusters;
    this.schedule = options.schedule;
    this.locationKey = `fleet:${options.id}`;
    this.concurrency = options.concurrency ?? 3;
    this.k8sLocator = options.k8sLocator;
  }

  getProviderName(): string {
    return this.locationKey;
  }

  getSchedule(): SchedulerServiceTaskScheduleDefinition {
    return this.schedule;
  }

  private dedupeEntities(entities: Entity[]): Entity[] {
    const seen = new Set<string>();
    const result: Entity[] = [];
    for (const entity of entities) {
      const ns = entity.metadata?.namespace ?? "default";
      const key = `${entity.kind}:${ns}:${entity.metadata?.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entity);
    }
    return result;
  }

  private recordWorkspaceNamespace(clusterId: string, workspace: string): void {
    const trimmed = workspace || "default";
    const set = this.clusterWorkspaces.get(clusterId) ?? new Set<string>();
    set.add(trimmed);
    this.clusterWorkspaces.set(clusterId, set);
  }

  private getPrimaryWorkspace(clusterId: string): string {
    const set = this.clusterWorkspaces.get(clusterId);
    if (set && set.size > 0) {
      if (set.has("fleet-default")) return "fleet-default";
      return Array.from(set.values())[0];
    }
    const fallback = "fleet-default";
    this.clusterWorkspaces.set(clusterId, new Set([fallback]));
    return fallback;
  }

  private async populateClusterNameMap(): Promise<void> {
    this.clusterStats = new Map();
    this.clusterWorkspaces.clear();
    if (this.k8sLocator) {
      try {
        const clusters = await this.k8sLocator.listRancherClusterDetails();
        if (clusters?.length) {
          this.clusterNameMap = new Map(
            clusters
              .filter((c) => c.id)
              .map((c) => [c.id, c.name ?? c.id]),
          );

          for (const c of clusters) {
            if (!c.id) continue;
            const stats = this.clusterStats?.get(c.id) ?? {};
            stats.state = c.state;
            stats.transitioning = c.transitioning;
            stats.transitioningMessage = c.transitioningMessage;
            stats.conditions = c.conditions;
            stats.etcdBackupConfig =
              c.rancherKubernetesEngineConfig?.services?.etcd?.backupConfig;
            stats.version =
              stats.version ?? c.rancherKubernetesEngineConfig?.kubernetesVersion;
            stats.driver = c.driver ?? c.labels?.["provider.cattle.io"];
            this.clusterStats?.set(c.id, stats);
          }

          this.logger.debug(
            `Loaded ${this.clusterNameMap.size} cluster names from FleetK8sLocator`,
          );
          return;
        }
      } catch (e) {
        this.logger.warn(`Failed to load cluster names via FleetK8sLocator: ${e}`);
      }
    }

    try {
      const cfg = this.clusters[0];
      if (!cfg?.url || !cfg?.token) return;
      const rancherBase = cfg.url.replace(/\/k8s\/clusters\/.+$/, "");
      const agent = new https.Agent({
        rejectUnauthorized: cfg.skipTLSVerify === true ? false : true,
      });
      const res = await fetch(`${rancherBase}/v3/clusters`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/json",
        },
        agent,
      });
      if (!res.ok) {
        this.logger.warn(
          `Failed to fetch Rancher clusters for names: ${res.status} ${res.statusText}`,
        );
        return;
      }
      const data = (await res.json()) as {
        data?: Array<{
          id?: string;
          name?: string;
          displayName?: string;
          labels?: Record<string, string>;
          annotations?: Record<string, string>;
          driver?: string;
        }>;
      };
      const entries = data.data ?? [];
      this.clusterNameMap = new Map(
        entries
          .filter((c) => c.id)
          .map((c) => {
            const isHarvester =
              c.labels?.["provider.cattle.io"] === "harvester";
            const harvesterDisplay =
              c.annotations?.[
                "provisioning.cattle.io/management-cluster-display-name"
              ];
            const displayName =
              c.displayName ??
              c.annotations?.["field.cattle.io/displayName"] ??
              c.name;
            const friendly = isHarvester
              ? (harvesterDisplay ?? displayName ?? (c.id as string))
              : (displayName ?? (c.id as string));
            return [c.id as string, friendly];
          }),
      );
      for (const c of entries) {
        if (!c.id) continue;
        const stats = this.clusterStats?.get(c.id) ?? {};
        stats.driver = c.driver ?? c.labels?.["provider.cattle.io"];
        this.clusterStats?.set(c.id, stats);
      }
      this.logger.debug(
        `Loaded ${this.clusterNameMap.size} cluster names from Rancher`,
      );
    } catch (e) {
      this.logger.warn(`Failed to load Rancher cluster names: ${e}`);
    }
  }

  private async collectClusterTopology(batch: EntityBatch): Promise<void> {
    if (!this.k8sLocator) {
      await this.addNodesViaRancher(batch);
      return;
    }

    const cluster = this.clusters[0];
    if (!cluster) return;

    const context: MapperContext = {
      cluster,
      locationKey: this.locationKey,
      autoTechdocsRef: cluster.autoTechdocsRef,
    };

    try {
      const [nodeGroups, mdGroups, versions, vmGroups] = await Promise.all([
        this.k8sLocator.listClusterNodesDetailed(),
        this.k8sLocator.listClusterMachineDeployments(),
        this.k8sLocator.listClusterVersions(),
        this.k8sLocator.listHarvesterVirtualMachines(),
      ]);

      const versionMap = new Map<string, string | undefined>(
        versions.map((v) => [v.clusterId, v.version]),
      );

      for (const group of nodeGroups) {
        const clusterId = group.clusterId;
        const clusterName =
          this.clusterNameMap?.get(clusterId) ?? group.clusterName ?? clusterId;
        const workspaceNamespace = this.getPrimaryWorkspace(clusterId);
        const nodes = group.nodes ?? [];

        let readyCount = 0;
        for (const node of nodes) {
          const nodeId =
            node.metadata?.uid ?? node.metadata?.name ?? node.spec?.providerID;
          const nodeName = node.metadata?.name ?? nodeId;
          if (!nodeId || !nodeName) continue;
          const addresses = node.status?.addresses as
            | Array<Record<string, unknown>>
            | undefined;
          const taints = node.spec?.taints as
            | Array<Record<string, unknown>>
            | undefined;
          const isReady = (node.status?.conditions ?? []).some(
            (c) => c?.type === "Ready" && c?.status === "True",
          );
          if (isReady) readyCount += 1;

          const entity = mapNodeToResource({
            nodeId,
            nodeName,
            clusterId,
            clusterName,
            workspaceNamespace,
            context,
            details: {
              labels: node.metadata?.labels ?? undefined,
              capacity: node.status?.capacity ?? undefined,
              allocatable: node.status?.allocatable ?? undefined,
              taints,
              addresses,
              providerId: node.spec?.providerID,
              kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
              osImage: node.status?.nodeInfo?.osImage,
              containerRuntime:
                node.status?.nodeInfo?.containerRuntimeVersion,
              architecture: node.status?.nodeInfo?.architecture,
            },
          });
          batch.resources.push(entity);
        }

        const stats = this.clusterStats?.get(clusterId) ?? {};
        stats.nodeCount = nodes.length;
        stats.readyNodeCount = readyCount;
        stats.version = versionMap.get(clusterId) ?? stats.version;
        this.clusterStats?.set(clusterId, stats);
      }

      for (const group of mdGroups) {
        const clusterId = group.clusterId;
        const clusterName =
          this.clusterNameMap?.get(clusterId) ?? group.clusterName ?? clusterId;
        const workspaceNamespace = this.getPrimaryWorkspace(clusterId);
        const items = group.items ?? [];
        for (const md of items) {
          const mdName = md.metadata?.name;
          if (!mdName) continue;
          const selector = md.spec?.selector?.matchLabels ?? {};
          const labels = md.metadata?.labels ?? md.spec?.template?.metadata?.labels;
          const entity = mapMachineDeploymentToResource({
            mdName,
            clusterId,
            clusterName,
            workspaceNamespace,
            context,
            details: {
              namespace: md.metadata?.namespace,
              labels: labels && Object.keys(labels).length ? labels : undefined,
              selector: Object.keys(selector).length ? selector : undefined,
              replicas: md.spec?.replicas,
              availableReplicas: md.status?.availableReplicas,
              readyReplicas: md.status?.readyReplicas,
              updatedReplicas: md.status?.updatedReplicas,
            },
          });
          batch.resources.push(entity);
        }

        const stats = this.clusterStats?.get(clusterId) ?? {};
        stats.machineDeploymentCount = items.length;
        stats.version = stats.version ?? versionMap.get(clusterId);
        this.clusterStats?.set(clusterId, stats);
      }

      for (const group of vmGroups) {
        const clusterId = group.clusterId;
        const clusterName =
          this.clusterNameMap?.get(clusterId) ?? group.clusterName ?? clusterId;
        const workspaceNamespace = this.getPrimaryWorkspace(clusterId);
        const items = group.items ?? [];
        for (const vm of items) {
          const vmName = vm.metadata?.name;
          if (!vmName) continue;
          const requests = vm.spec?.template?.spec?.domain?.resources?.requests;
          const limits = vm.spec?.template?.spec?.domain?.resources?.limits;
          const entity = mapVirtualMachineToResource({
            vmName,
            clusterId,
            clusterName,
            workspaceNamespace,
            context,
            details: {
              namespace: vm.metadata?.namespace,
              labels: vm.metadata?.labels,
              requests: requests && Object.keys(requests).length ? requests : undefined,
              limits: limits && Object.keys(limits).length ? limits : undefined,
              runStrategy: vm.spec?.runStrategy,
              printableStatus: vm.status?.printableStatus,
              ready: vm.status?.ready,
            },
          });
          batch.resources.push(entity);
        }

        const stats = this.clusterStats?.get(clusterId) ?? {};
        stats.vmCount = items.length;
        this.clusterStats?.set(clusterId, stats);
      }

      for (const v of versions) {
        const stats = this.clusterStats?.get(v.clusterId) ?? {};
        stats.version = v.version ?? stats.version;
        this.clusterStats?.set(v.clusterId, stats);
      }
    } catch (e) {
      this.logger.debug(`Failed to collect cluster topology via k8s locator: ${e}`);
      await this.addNodesViaRancher(batch);
    }
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    this.logger.info(`Connected FleetEntityProvider[${this.locationKey}]`);
  }

  /**
   * Main run method - fetches all Fleet resources and emits entities
   */
  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error("FleetEntityProvider is not connected");
    }

    const startTime = Date.now();
    this.logger.info(`FleetEntityProvider[${this.locationKey}] starting sync`);

    const limit = pLimit(this.concurrency);
    const batch = createEmptyBatch();

    try {
      await this.populateClusterNameMap();
      await this.collectClusterTopology(batch);
      this.addDiscoveredClustersToBatch(batch);

      await Promise.all(
        this.clusters.map((cluster) =>
          limit(async () => {
            const clusterBatch = await this.fetchCluster(cluster);
            batch.domains.push(...clusterBatch.domains);
            batch.systems.push(...clusterBatch.systems);
            batch.components.push(...clusterBatch.components);
            batch.resources.push(...clusterBatch.resources);
            batch.apis.push(...clusterBatch.apis);
          }),
        ),
      );

      const entities = this.dedupeEntities(flattenBatch(batch));

      await this.connection.applyMutation({
        type: "full",
        entities: entities.map((entity) => ({
          entity,
          locationKey: this.locationKey,
        })),
      });

      const duration = Date.now() - startTime;
      this.logger.info(
        `FleetEntityProvider[${this.locationKey}] sync completed in ${duration}ms: ` +
          `${batch.domains.length} domains, ${batch.systems.length} systems, ` +
          `${batch.components.length} components, ${batch.resources.length} resources, ` +
          `${batch.apis.length} APIs`,
      );
    } catch (error) {
      this.logger.error(
        `FleetEntityProvider[${this.locationKey}] sync failed: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Fetch all Fleet resources from a single cluster
   */
  private async fetchCluster(
    cluster: FleetClusterConfig,
  ): Promise<EntityBatch> {
    const client = createFleetClient(cluster, this.logger);
    const batch = createEmptyBatch();

    this.logger.debug(`Fetching Fleet resources from cluster ${cluster.name}`);

    const context: MapperContext = {
      cluster,
      locationKey: this.locationKey,
      autoTechdocsRef: cluster.autoTechdocsRef,
    };

    // Create Domain entity for the Fleet Rancher Cluster itself
    const domainEntity = mapFleetClusterToDomain(context);
    batch.domains.push(domainEntity);

    // Fetch GitRepos and Bundles from each namespace
    for (const nsConfig of cluster.namespaces) {
      const nsBatch = await this.fetchNamespace(client, cluster, nsConfig);
      batch.systems.push(...nsBatch.systems);
      batch.components.push(...nsBatch.components);
      batch.resources.push(...nsBatch.resources);
      batch.apis.push(...nsBatch.apis);
    }

    return batch;
  }

  /**
   * Fetch all Fleet resources from a single namespace
   */
  private async fetchNamespace(
    client: FleetClient,
    cluster: FleetClusterConfig,
    nsConfig: FleetNamespaceConfig,
  ): Promise<EntityBatch> {
    const batch = createEmptyBatch();
    const namespace = nsConfig.name;

    // Build label selector
    const labelSelector = selectorToString(
      cluster.gitRepoSelector ?? nsConfig.labelSelector,
    );

    this.logger.debug(
      `Fetching GitRepos from ${cluster.name}/${namespace} ` +
        `(selector: ${labelSelector ?? "none"})`,
    );

    // Fetch GitRepos
    const gitRepos = await client.listGitRepos({ namespace, labelSelector });
    this.logger.debug(`Found ${gitRepos.length} GitRepos in ${namespace}`);

    // Process each GitRepo
    for (const gitRepo of gitRepos) {
      const gitRepoBatch = await this.processGitRepo(client, cluster, gitRepo);
      batch.systems.push(...gitRepoBatch.systems);
      batch.components.push(...gitRepoBatch.components);
      batch.resources.push(...gitRepoBatch.resources);
      batch.apis.push(...gitRepoBatch.apis);
    }

    return batch;
  }

  /**
   * Process a single GitRepo and its related resources
   */
  private async processGitRepo(
    client: FleetClient,
    cluster: FleetClusterConfig,
    gitRepo: FleetGitRepo,
  ): Promise<EntityBatch> {
    const batch = createEmptyBatch();
    const gitRepoName = gitRepo.metadata?.name ?? "unknown";
    const namespace = gitRepo.metadata?.namespace ?? "fleet-default";

    // Fetch fleet.yaml if configured
    let fleetYaml: FleetYaml | undefined;
    if (cluster.fetchFleetYaml) {
      fleetYaml = await this.fetchFleetYaml(gitRepo);
    }

    const context: MapperContext = {
      cluster,
      locationKey: this.locationKey,
      fleetYaml,
      autoTechdocsRef: cluster.autoTechdocsRef,
    };

    // Create System entity for GitRepo
    const systemEntity = mapGitRepoToSystem(gitRepo, context);
    batch.systems.push(systemEntity);

    // Create API entities from fleet.yaml providesApis
    if (cluster.generateApis && fleetYaml?.backstage?.providesApis) {
      for (const apiDef of fleetYaml.backstage.providesApis) {
        const apiEntity = mapApiDefinitionToApi(apiDef, gitRepoName, context);
        batch.apis.push(apiEntity);
      }
    }

    // Fetch and process Bundles
    if (cluster.includeBundles !== false) {
      const bundles = await client.listBundlesForGitRepo(
        namespace,
        gitRepoName,
      );
      this.logger.debug(
        `Found ${bundles.length} Bundles for GitRepo ${gitRepoName}`,
      );

      for (const bundle of bundles) {
        const bundleBatch = await this.processBundle(
          client,
          cluster,
          bundle,
          fleetYaml,
        );
        batch.components.push(...bundleBatch.components);
        batch.resources.push(...bundleBatch.resources);
      }
    }

    return batch;
  }

  /**
   * Process a single Bundle and its related resources
   */
  private async processBundle(
    client: FleetClient,
    cluster: FleetClusterConfig,
    bundle: FleetBundle,
    fleetYaml?: FleetYaml,
  ): Promise<EntityBatch> {
    const batch: EntityBatch = {
      domains: [],
      systems: [],
      components: [],
      resources: [],
      apis: [],
    };

    const bundleName = bundle.metadata?.name ?? "unknown";

    const context: MapperContext = {
      cluster,
      locationKey: this.locationKey,
      fleetYaml,
      autoTechdocsRef: cluster.autoTechdocsRef,
    };

    // Create Component entity for Bundle
    const componentEntity = mapBundleToComponent(bundle, context);
    batch.components.push(componentEntity);
    const resourceRefs: string[] = [];
    const parentSystemRef =
      typeof componentEntity.spec === "object"
        ? (componentEntity.spec as { system?: string }).system
        : undefined;

    // Fetch and process BundleDeployments (per-cluster status)
    if (cluster.includeBundleDeployments) {
      const deployments =
        await client.listBundleDeploymentsForBundle(bundleName);
      this.logger.debug(
        `Found ${deployments.length} BundleDeployments for Bundle ${bundleName}`,
      );

      for (const bd of deployments) {
        const clusterId = FleetClient.extractClusterIdFromNamespace(
          bd.metadata?.namespace ?? "",
        );
        if (clusterId) {
        const workspaceNamespace =
          extractWorkspaceNamespaceFromBundleDeploymentNamespace(
            bd.metadata?.namespace ?? "",
          ) ?? "fleet-default";
        this.recordWorkspaceNamespace(clusterId, workspaceNamespace);
        // Cluster entity
          // Try to find friendly name from Rancher clusters if available
          const derivedClusterId = deriveFriendlyClusterName(clusterId);
          const clusterFriendlyName =
            this.clusterNameMap?.get(clusterId) ??
            (derivedClusterId
              ? this.clusterNameMap?.get(derivedClusterId)
              : undefined) ??
            derivedClusterId ??
            clusterId;
          const clusterDetails = this.clusterStats?.get(clusterId);
          const clusterResource = mapClusterToResource(
            clusterId,
            clusterFriendlyName,
            workspaceNamespace,
            context,
            clusterDetails,
          );
          batch.resources.push(clusterResource);

          const bdResourceEntity = mapBundleDeploymentToResource(
            bd,
            clusterId,
            context,
            parentSystemRef,
            clusterFriendlyName,
          );
          batch.resources.push(bdResourceEntity);
          resourceRefs.push(
            stringifyEntityRef({
              kind: "Resource",
              namespace: bdResourceEntity.metadata.namespace ?? "default",
              name: bdResourceEntity.metadata.name,
            }),
          );
        }
      }
    }

    if (resourceRefs.length > 0) {
      const spec = (componentEntity.spec ?? {}) as {
        dependsOn?: string[];
      };
      const existingDependsOn = Array.isArray(spec.dependsOn)
        ? spec.dependsOn
        : [];
      spec.dependsOn = [...new Set([...existingDependsOn, ...resourceRefs])];
      componentEntity.spec = spec;
    }

    return batch;
  }

  /**
   * Fetch fleet.yaml from Git repository
   * Note: This is a placeholder - actual implementation would need Git access
   */
  private async fetchFleetYaml(
    gitRepo: FleetGitRepo,
  ): Promise<FleetYaml | undefined> {
    // TODO: Implement actual fleet.yaml fetching from Git
    // This would require:
    // 1. Git credentials from Fleet secrets or separate config
    // 2. Clone or fetch raw file from repo
    // 3. Parse YAML

    // For now, try to extract from annotations if available
    const annotations = gitRepo.metadata?.annotations ?? {};
    const fleetYamlRaw = annotations["fleet.cattle.io/fleet-yaml"];

    if (fleetYamlRaw) {
      try {
        return JSON.parse(fleetYamlRaw) as FleetYaml;
      } catch {
        this.logger.warn(
          `Failed to parse fleet.yaml annotation for ${gitRepo.metadata?.name}`,
        );
      }
    }

    return undefined;
  }
}

// ============================================================================
// Configuration Readers
// ============================================================================

function readClusters(config: Config): FleetClusterConfig[] {
  // Check for explicit clusters array
  if (config.has("clusters")) {
    const clustersConfig = config.getConfigArray("clusters");
    return clustersConfig.map((clusterConfig: Config) =>
      buildClusterConfig(clusterConfig),
    );
  }

  // Legacy/simple form: single cluster with properties at root level
  return [buildClusterConfig(config)];
}

function buildClusterConfig(config: Config): FleetClusterConfig {
  const name =
    config.getOptionalString("name") ??
    config.getOptionalString("clusterName") ??
    "local";

  const url =
    config.getOptionalString("url") ??
    config.getOptionalString("apiServer") ??
    config.getOptionalString("clusterUrl") ??
    "https://kubernetes.default.svc";

  const namespaces = readNamespaces(config);

  return {
    name,
    url,
    token: config.getOptionalString("token"),
    caData: config.getOptionalString("caData"),
    skipTLSVerify: config.getOptionalBoolean("skipTLSVerify") ?? false,
    namespaces,
    includeBundles: config.getOptionalBoolean("includeBundles") ?? true,
    includeBundleDeployments:
      config.getOptionalBoolean("includeBundleDeployments") ?? false,
    generateApis: config.getOptionalBoolean("generateApis") ?? false,
    fetchFleetYaml: config.getOptionalBoolean("fetchFleetYaml") ?? false,
    gitRepoSelector: readSelector(config.getOptionalConfig("gitRepoSelector")),
    autoTechdocsRef: config.getOptionalBoolean("autoTechdocsRef") ?? true,
  };
}

function readNamespaces(config: Config): FleetNamespaceConfig[] {
  // Simple string array
  const asStrings = config.getOptionalStringArray("namespaces");
  if (asStrings) {
    return asStrings.map((ns: string) => ({ name: ns }));
  }

  // Config array with optional selectors
  const asConfigs = config.getOptionalConfigArray("namespaces");
  if (asConfigs) {
    return asConfigs.map((nsConfig: Config) => ({
      name: nsConfig.getString("name"),
      labelSelector: readSelector(nsConfig.getOptionalConfig("selector")),
    }));
  }

  // Default namespace
  return [{ name: "fleet-default" }];
}

function readSelector(config?: Config): LabelSelector | undefined {
  if (!config) {
    return undefined;
  }

  const matchLabelsConfig = config.getOptionalConfig("matchLabels");
  const matchExpressions = config.getOptionalConfigArray("matchExpressions");

  if (!matchLabelsConfig && !matchExpressions) {
    return undefined;
  }

  const selector: LabelSelector = {};

  if (matchLabelsConfig) {
    const matchLabels: Record<string, string> = {};
    for (const key of matchLabelsConfig.keys()) {
      matchLabels[key] = matchLabelsConfig.getString(key);
    }
    if (Object.keys(matchLabels).length > 0) {
      selector.matchLabels = matchLabels;
    }
  }

  if (matchExpressions) {
    selector.matchExpressions = matchExpressions.map((expr: Config) => ({
      key: expr.getString("key"),
      operator: expr.getString("operator") as
        | "In"
        | "NotIn"
        | "Exists"
        | "DoesNotExist",
      values: expr.getOptionalStringArray("values"),
    }));
  }

  return Object.keys(selector).length > 0 ? selector : undefined;
}

function readSchedule(config?: Config): SchedulerServiceTaskScheduleDefinition {
  const frequencyMinutes = config?.getOptionalNumber("frequency.minutes") ?? 10;
  const timeoutMinutes = config?.getOptionalNumber("timeout.minutes") ?? 5;
  const initialDelaySeconds =
    config?.getOptionalNumber("initialDelay.seconds") ?? 15;

  return {
    frequency: Duration.fromObject({ minutes: frequencyMinutes }),
    timeout: Duration.fromObject({ minutes: timeoutMinutes }),
    initialDelay: Duration.fromObject({ seconds: initialDelaySeconds }),
  };
}

// ============================================================================
// Re-exports for backward compatibility
// ============================================================================

export type {
  FleetNamespaceConfig,
  LabelSelector,
  FleetClusterConfig,
} from "./types";
