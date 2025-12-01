/**
 * Backstage Catalog Backend Module for Rancher Fleet
 *
 * This module provides an EntityProvider that synchronizes Rancher Fleet
 * GitOps resources (GitRepo, Bundle, BundleDeployment) into the Backstage
 * Software Catalog.
 *
 * ## Entity Mapping
 *
 * - **Fleet Cluster (config) → System**: The Rancher Fleet cluster (rancher.example.com)
 * - **GitRepo → Component**: Maps Fleet GitRepos to Component entities (type: service)
 * - **Bundle → Resource**: Maps Fleet Bundles to Resource entities (type: fleet-bundle)
 * - **BundleDeployment → Resource**: Maps per-cluster deployments to Resource entities
 * - **API Generation**: Creates API entities from fleet.yaml providesApis/consumesApis
 * - **Dependencies**: Supports Fleet dependsOn and Backstage relations
 * - **Multi-cluster**: Supports multiple Fleet management clusters
 * - **Kubernetes Integration**: Annotates entities for Backstage K8s plugin
 *
 * ## Installation
 *
 * ```bash
 * yarn add @gorizond/catalog-backend-module-fleet
 * ```
 *
 * ## Usage
 *
 * Add to your backend in `packages/backend/src/index.ts`:
 *
 * ```typescript
 * import { createBackend } from '@backstage/backend-defaults';
 *
 * const backend = createBackend();
 * backend.add(import('@backstage/plugin-catalog-backend'));
 * backend.add(import('@gorizond/catalog-backend-module-fleet'));
 * // For kubernetes cluster discovery:
 * backend.add(import('@backstage/plugin-kubernetes-backend'));
 * backend.add(import('@gorizond/catalog-backend-module-fleet/kubernetes'));
 * backend.start();
 * ```
 *
 * ## Configuration
 *
 * Add to your `app-config.yaml`:
 *
 * ```yaml
 * catalog:
 *   providers:
 *     fleet:
 *       name: rancher-prod
 *       url: https://rancher.example.com/k8s/clusters/local
 *       token: ${FLEET_CLUSTER_TOKEN}
 *       namespaces:
 *         - fleet-default
 *         - fleet-local
 *       includeBundles: true
 *       includeBundleDeployments: false
 *       generateApis: true
 *       fetchFleetYaml: true
 *       schedule:
 *         frequency:
 *           minutes: 10
 *         timeout:
 *           minutes: 5
 * ```
 *
 * @packageDocumentation
 */

// Main module export
export { catalogModuleFleet, default } from "./module";

// Kubernetes cluster supplier module
export { kubernetesModuleFleetClusterSupplier } from "./kubernetesModule";

// Provider class for advanced usage
export { FleetEntityProvider } from "./provider";
export type {
  FleetProviderFactoryOptions,
  FleetProviderOptions,
} from "./provider";

// Fleet Kubernetes client
export {
  FleetClient,
  createFleetClient,
  selectorToString,
} from "./FleetClient";
export type { FleetClientOptions, ListOptions } from "./FleetClient";

// Entity mapping utilities
export {
  mapFleetClusterToDomain,
  mapGitRepoToSystem,
  mapBundleToComponent,
  mapBundleDeploymentToResource,
  mapMachineDeploymentToResource,
  mapVirtualMachineToResource,
  mapApiDefinitionToApi,
  toBackstageName,
  toEntityNamespace,
  createEmptyBatch,
  flattenBatch,
  // Annotation constants
  ANNOTATION_FLEET_REPO,
  ANNOTATION_FLEET_BRANCH,
  ANNOTATION_FLEET_NAMESPACE,
  ANNOTATION_FLEET_TARGETS,
  ANNOTATION_FLEET_REPO_NAME,
  ANNOTATION_FLEET_BUNDLE_PATH,
  ANNOTATION_FLEET_STATUS,
  ANNOTATION_FLEET_READY_CLUSTERS,
  ANNOTATION_FLEET_CLUSTER,
  ANNOTATION_FLEET_SOURCE_GITREPO,
  ANNOTATION_FLEET_SOURCE_BUNDLE,
  ANNOTATION_KUBERNETES_ID,
  ANNOTATION_KUBERNETES_NAMESPACE,
  ANNOTATION_KUBERNETES_LABEL_SELECTOR,
} from "./entityMapper";
export type { MapperContext, EntityBatch } from "./entityMapper";

// Type exports
export type {
  // Kubernetes common types
  KubeMetadata,
  LabelSelector,
  Condition,
  // GitRepo types
  FleetGitRepo,
  GitRepoTarget,
  GitRepoTargetCustomization,
  GitRepoSpec,
  GitRepoStatus,
  // Bundle types
  FleetBundle,
  BundleDependsOn,
  BundleSpec,
  BundleStatus,
  // BundleDeployment types
  FleetBundleDeployment,
  BundleDeploymentState,
  BundleDeploymentStatus,
  // Cluster types
  FleetCluster,
  FleetClusterGroup,
  // fleet.yaml types
  FleetYaml,
  FleetYamlBackstage,
  FleetYamlApiDefinition,
  // Configuration types
  FleetNamespaceConfig,
  FleetClusterConfig,
  FleetProviderConfig,
  // Entity generation types
  GeneratedEntity,
  EntityGenerationContext,
} from "./types";

// Utility exports
export {
  FLEET_STATUS_PRIORITY,
  getWorstStatus,
  statusToLifecycle,
} from "./types";

// Kubernetes locator (for advanced usage)
export { FleetK8sLocator } from "./k8sLocator";
export type { FleetK8sLocatorOptions } from "./k8sLocator";
