/**
 * Backstage Backend Module for Fleet Entity Provider
 *
 * This module registers the FleetEntityProvider with the Backstage catalog.
 * It fetches Fleet GitOps resources (GitRepo, Bundle, BundleDeployment) from
 * Kubernetes clusters and creates corresponding Backstage catalog entities.
 *
 * @packageDocumentation
 */

import {
  coreServices,
  createBackendModule,
} from "@backstage/backend-plugin-api";
import { catalogProcessingExtensionPoint } from "@backstage/plugin-catalog-node/alpha";
import { FleetEntityProvider } from "./provider";
import { FleetK8sLocator } from "./k8sLocator";

/**
 * Catalog backend module that provides Fleet entities.
 *
 * @example
 * ```ts
 * // In packages/backend/src/index.ts
 * import { createBackend } from '@backstage/backend-defaults';
 *
 * const backend = createBackend();
 * backend.add(import('@backstage/plugin-catalog-backend'));
 * backend.add(import('@gorizond/catalog-backend-module-fleet'));
 * backend.start();
 * ```
 *
 * @example
 * Configuration in app-config.yaml:
 * ```yaml
 * catalog:
 *   providers:
 *     fleet:
 *       # Single cluster configuration
 *       name: rancher-prod
 *       url: https://rancher.example.com/k8s/clusters/local
 *       token: ${FLEET_CLUSTER_TOKEN}
 *       namespaces:
 *         - fleet-default
 *       includeBundles: true
 *       includeBundleDeployments: false
 *       generateApis: false
 *       fetchFleetYaml: false
 *       schedule:
 *         frequency:
 *           minutes: 10
 *         timeout:
 *           minutes: 5
 *
 *       # Optional: filter GitRepos by labels
 *       gitRepoSelector:
 *         matchLabels:
 *           backstage.io/discover: "true"
 * ```
 *
 * @example
 * Multi-cluster configuration:
 * ```yaml
 * catalog:
 *   providers:
 *     fleet:
 *       production:
 *         clusters:
 *           - name: local
 *             url: https://rancher.example.com/k8s/clusters/local
 *             token: ${FLEET_LOCAL_TOKEN}
 *             namespaces:
 *               - fleet-default
 *           - name: staging
 *             url: https://rancher-staging.example.com/k8s/clusters/local
 *             token: ${FLEET_STAGING_TOKEN}
 *             namespaces:
 *               - fleet-default
 *         schedule:
 *           frequency:
 *             minutes: 5
 * ```
 *
 * @public
 */
export const catalogModuleFleet = createBackendModule({
  pluginId: "catalog",
  moduleId: "fleet-entity-provider",
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
      },
      async init({ catalog, config, logger, scheduler }) {
        const providers = FleetEntityProvider.fromConfig(config, { logger });
        const k8sLocator = FleetK8sLocator.fromConfig({ config, logger });

        if (providers.length === 0) {
          logger.info(
            "No Fleet entity providers configured. " +
              "Add catalog.providers.fleet to your app-config.yaml to enable.",
          );
          return;
        }

        for (const provider of providers) {
          // Register the provider with the catalog
          catalog.addEntityProvider(provider);

          // Schedule the provider to run periodically
          const schedule = provider.getSchedule();

          await scheduler.scheduleTask({
            id: provider.getProviderName(),
            frequency: schedule.frequency,
            timeout: schedule.timeout,
            initialDelay: schedule.initialDelay,
            fn: async () => {
              await provider.run();
            },
          });

          logger.info(
            `Registered Fleet entity provider: ${provider.getProviderName()}`,
          );
        }

        if (k8sLocator) {
          try {
            const clusters = await k8sLocator.listClusters();
            logger.info(
              `FleetK8sLocator discovered ${clusters.length} Kubernetes clusters`,
            );
            logger.debug(
              `FleetK8sLocator clusters: ${JSON.stringify(clusters, null, 2)}`,
            );
          } catch (error) {
            logger.warn(`FleetK8sLocator failed: ${error}`);
          }
        }
      },
    });
  },
});

/**
 * Default export for convenience
 * @public
 */
export default catalogModuleFleet;
