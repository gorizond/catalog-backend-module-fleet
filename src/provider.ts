/**
 * Fleet Entity Provider
 * Provides Backstage Catalog entities from Rancher Fleet GitOps resources
 *
 * Entity Mapping:
 * - Fleet Cluster (config) → System (rancher.example.com)
 * - GitRepo → Component (type: service)
 * - Bundle → Resource (type: fleet-bundle)
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
import pLimit from "p-limit";

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
  mapFleetClusterToSystem,
  mapGitRepoToComponent,
  mapBundleToResource,
  mapBundleDeploymentToResource,
  mapApiDefinitionToApi,
  MapperContext,
  EntityBatch,
  createEmptyBatch,
  flattenBatch,
} from "./entityMapper";

// ============================================================================
// Configuration Types
// ============================================================================

export interface FleetProviderFactoryOptions {
  logger: LoggerService;
}

export interface FleetProviderOptions {
  id: string;
  clusters: FleetClusterConfig[];
  schedule: SchedulerServiceTaskScheduleDefinition;
  logger: LoggerService;
  concurrency?: number;
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
  private connection?: EntityProviderConnection;

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
    });
  }

  constructor(options: FleetProviderOptions) {
    this.logger = options.logger.child({ plugin: "fleet-entity-provider" });
    this.clusters = options.clusters;
    this.schedule = options.schedule;
    this.locationKey = `fleet:${options.id}`;
    this.concurrency = options.concurrency ?? 3;
  }

  getProviderName(): string {
    return this.locationKey;
  }

  getSchedule(): SchedulerServiceTaskScheduleDefinition {
    return this.schedule;
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
      await Promise.all(
        this.clusters.map((cluster) =>
          limit(async () => {
            const clusterBatch = await this.fetchCluster(cluster);
            batch.systems.push(...clusterBatch.systems);
            batch.components.push(...clusterBatch.components);
            batch.resources.push(...clusterBatch.resources);
            batch.apis.push(...clusterBatch.apis);
          }),
        ),
      );

      const entities = flattenBatch(batch);

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
          `${batch.systems.length} systems, ${batch.components.length} components, ` +
          `${batch.resources.length} resources, ${batch.apis.length} APIs`,
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
    };

    // Create System entity for the Fleet Rancher Cluster itself
    const systemEntity = mapFleetClusterToSystem(context);
    batch.systems.push(systemEntity);

    // Fetch GitRepos and Bundles from each namespace
    for (const nsConfig of cluster.namespaces) {
      const nsBatch = await this.fetchNamespace(client, cluster, nsConfig);
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
    };

    // Create Component entity for GitRepo
    const componentEntity = mapGitRepoToComponent(gitRepo, context);
    batch.components.push(componentEntity);

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
    };

    // Create Resource entity for Bundle
    const resourceEntity = mapBundleToResource(bundle, context);
    batch.resources.push(resourceEntity);

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
          const bdResourceEntity = mapBundleDeploymentToResource(
            bd,
            clusterId,
            context,
          );
          batch.resources.push(bdResourceEntity);
        }
      }
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
