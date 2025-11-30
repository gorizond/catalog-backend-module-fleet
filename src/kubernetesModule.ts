/**
 * Backstage Kubernetes Backend Module for Fleet K8s Cluster Supplier
 *
 * This module provides a KubernetesClustersSupplier that dynamically discovers
 * Rancher downstream clusters and injects them into the Kubernetes backend.
 *
 * @packageDocumentation
 */

import {
  coreServices,
  createBackendModule,
} from "@backstage/backend-plugin-api";
import { CustomResourceMatcher } from "@backstage/plugin-kubernetes-common";
import { kubernetesClusterSupplierExtensionPoint } from "@backstage/plugin-kubernetes-node";
import { FleetK8sLocator } from "./k8sLocator";
import type { ClusterDetails } from "@backstage/plugin-kubernetes-node";
import { Duration } from "luxon";

/**
 * Kubernetes backend module that provides Fleet-discovered clusters.
 *
 * @example
 * ```ts
 * // In packages/backend/src/index.ts
 * import { createBackend } from '@backstage/backend-defaults';
 *
 * const backend = createBackend();
 * backend.add(import('@backstage/plugin-kubernetes-backend'));
 * backend.add(import('@gorizond/catalog-backend-module-fleet/kubernetes'));
 * backend.start();
 * ```
 *
 * @public
 */
export const kubernetesModuleFleetClusterSupplier = createBackendModule({
  pluginId: "kubernetes",
  moduleId: "fleet-cluster-supplier",
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        clusterSupplier: kubernetesClusterSupplierExtensionPoint,
      },
      async init({ config, logger, scheduler, clusterSupplier }) {
        const k8sLocator = FleetK8sLocator.fromConfig({ config, logger });

        if (!k8sLocator) {
          logger.info(
            "FleetK8sLocator not configured. Skipping fleet cluster supplier.",
          );
          return;
        }

        // Cache for discovered clusters
        let cachedClusters: ClusterDetails[] = [];

        // Helper function to convert locator clusters to ClusterDetails
        const convertToClusterDetails = (
          clusters: Array<{
            name: string;
            url: string;
            authProvider: string;
            serviceAccountToken: string;
            caData?: string;
            skipTLSVerify?: boolean;
            customResources?: CustomResourceMatcher[];
          }>,
        ): ClusterDetails[] => {
          return clusters.map((c) => ({
            name: c.name,
            url: c.url,
            authMetadata: {
              // The serviceAccount auth provider expects the token in this format
              serviceAccountToken: c.serviceAccountToken,
            },
            caData: c.caData,
            skipTLSVerify: c.skipTLSVerify,
            skipMetricsLookup: false,
            customResources: c.customResources,
          }));
        };

        // Initial discovery
        try {
          const clusterMethods = await k8sLocator.asClusterLocatorMethods();
          const clusters = clusterMethods.flatMap((m) => m.clusters);
          cachedClusters = convertToClusterDetails(clusters);

          logger.info(
            `FleetK8sLocator initially discovered ${cachedClusters.length} Kubernetes clusters`,
          );
        } catch (error) {
          logger.warn(`FleetK8sLocator initial discovery failed: ${error}`);
        }

        // Get refresh interval from config or default to 5 minutes
        const refreshIntervalStr = config.getOptionalString(
          "catalog.providers.fleetK8sLocator.refreshInterval",
        );
        const refreshInterval = refreshIntervalStr
          ? Duration.fromISO(refreshIntervalStr)
          : Duration.fromObject({ minutes: 5 });

        // Schedule periodic refresh
        await scheduler.scheduleTask({
          id: "fleet:k8sLocator:refresh",
          frequency: refreshInterval,
          timeout: { minutes: 2 },
          initialDelay: { seconds: 15 },
          fn: async () => {
            try {
              const clusterMethods = await k8sLocator.asClusterLocatorMethods();
              const clusters = clusterMethods.flatMap((m) => m.clusters);
              cachedClusters = convertToClusterDetails(clusters);

              logger.info(
                `FleetK8sLocator refreshed ${cachedClusters.length} Kubernetes clusters for kubernetes backend`,
              );
            } catch (error) {
              logger.warn(`FleetK8sLocator refresh failed: ${error}`);
            }
          },
        });

        logger.info(
          `Scheduled FleetK8sLocator refresh every ${refreshInterval.toISO()} for kubernetes cluster supplier`,
        );

        // Register the cluster supplier with kubernetes backend
        clusterSupplier.addClusterSupplier({
          async getClusters() {
            logger.debug(
              `action=loadClusterDetails numOfClustersLoaded=${cachedClusters.length}`,
            );
            return cachedClusters;
          },
        });

        logger.info(
          `Registered FleetK8sLocator as kubernetes cluster supplier`,
        );
      },
    });
  },
});

export default kubernetesModuleFleetClusterSupplier;
