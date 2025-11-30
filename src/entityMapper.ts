/**
 * Entity Mapper
 * Converts Fleet Custom Resources to Backstage Catalog Entities
 *
 * Mapping:
 * - Fleet Rancher Cluster (config) → Domain
 * - GitRepo → System
 * - Bundle → Component (type: service)
 * - BundleDeployment → Resource (type: fleet-deployment)
 */

import {
  Entity,
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  ANNOTATION_SOURCE_LOCATION,
  stringifyEntityRef,
} from "@backstage/catalog-model";
import type { JsonObject } from "@backstage/types";

import {
  FleetGitRepo,
  FleetBundle,
  FleetBundleDeployment,
  FleetYaml,
  FleetYamlApiDefinition,
  FleetClusterConfig,
  BundleDependsOn,
  statusToLifecycle,
} from "./types";
import { URL } from "url";

// ============================================================================
// Constants
// ============================================================================

const FLEET_ANNOTATION_PREFIX = "fleet.cattle.io";

export const ANNOTATION_FLEET_REPO = `${FLEET_ANNOTATION_PREFIX}/repo`;
export const ANNOTATION_FLEET_BRANCH = `${FLEET_ANNOTATION_PREFIX}/branch`;
export const ANNOTATION_FLEET_NAMESPACE = `${FLEET_ANNOTATION_PREFIX}/namespace`;
export const ANNOTATION_FLEET_TARGETS = `${FLEET_ANNOTATION_PREFIX}/targets`;
export const ANNOTATION_FLEET_REPO_NAME = `${FLEET_ANNOTATION_PREFIX}/repo-name`;
export const ANNOTATION_FLEET_BUNDLE_PATH = `${FLEET_ANNOTATION_PREFIX}/bundle-path`;
export const ANNOTATION_FLEET_STATUS = `${FLEET_ANNOTATION_PREFIX}/status`;
export const ANNOTATION_FLEET_READY_CLUSTERS = `${FLEET_ANNOTATION_PREFIX}/ready-clusters`;
export const ANNOTATION_FLEET_CLUSTER = `${FLEET_ANNOTATION_PREFIX}/cluster`;
export const ANNOTATION_FLEET_SOURCE_GITREPO = `${FLEET_ANNOTATION_PREFIX}/source-gitrepo`;
export const ANNOTATION_FLEET_SOURCE_BUNDLE = `${FLEET_ANNOTATION_PREFIX}/source-bundle`;

// Backstage Kubernetes integration annotations
export const ANNOTATION_KUBERNETES_ID = "backstage.io/kubernetes-id";
export const ANNOTATION_KUBERNETES_NAMESPACE =
  "backstage.io/kubernetes-namespace";
export const ANNOTATION_KUBERNETES_LABEL_SELECTOR =
  "backstage.io/kubernetes-label-selector";
export const ANNOTATION_TECHDOCS_ENTITY = "backstage.io/techdocs-entity";

// ============================================================================
// Entity Naming
// ============================================================================

import { createHash } from "crypto";

/**
 * Convert a name to Backstage-safe entity name
 * Must match: [a-z0-9]+(-[a-z0-9]+)*
 */
const MAX_ENTITY_NAME_LENGTH = 63;

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function toBackstageName(value: string): string {
  const clean = sanitizeName(value);
  const trimmed = clean.slice(0, MAX_ENTITY_NAME_LENGTH).replace(/-+$/, "");
  return trimmed || "fleet-entity";
}

/**
 * Convert a name to Backstage-safe entity name with truncation + hash
 * to keep it short while preserving uniqueness and ending rules.
 */
export function toStableBackstageName(
  value: string,
  maxLength: number = MAX_ENTITY_NAME_LENGTH,
): string {
  const clean = sanitizeName(value);
  const fallback = "fleet-entity";

  if (!clean) return fallback;
  if (clean.length <= maxLength) return clean;

  const hash = createHash("sha1").update(clean).digest("hex").slice(0, 6);
  const base = clean
    .slice(0, Math.max(1, maxLength - hash.length - 1))
    .replace(/-+$/, "");
  const result = `${base}-${hash}`.replace(/-+$/, "");

  return result || `${fallback}-${hash}`;
}

/**
 * Create entity namespace from Fleet namespace
 */
export function toEntityNamespace(fleetNamespace: string): string {
  return toBackstageName(fleetNamespace);
}

function deriveOwnerFromRepo(repo?: string): string | undefined {
  if (!repo) return undefined;
  try {
    const url = new URL(repo);
    const segments = url.pathname.split("/").filter(Boolean);
    const ownerSegment = segments[0];
    if (!ownerSegment) return undefined;
    return `group:default/${toBackstageName(ownerSegment)}`;
  } catch {
    return undefined;
  }
}

function deriveKubernetesNamespace(fleetYaml?: FleetYaml, fallback?: string) {
  return (
    fleetYaml?.defaultNamespace ?? fleetYaml?.namespace ?? fallback ?? "default"
  );
}

function deriveNamespaceFromStatus(gitRepo: FleetGitRepo): string | undefined {
  const resources = gitRepo.status?.resources ?? [];
  for (const r of resources) {
    if (r.namespace) return r.namespace;
  }
  return undefined;
}

// ============================================================================
// Mapper Context
// ============================================================================

export interface MapperContext {
  cluster: FleetClusterConfig;
  locationKey: string;
  fleetYaml?: FleetYaml;
  autoTechdocsRef?: boolean;
}

// ============================================================================
// Fleet Cluster (config) → Domain
// Represents the Rancher Fleet management cluster (e.g., rancher.example.com)
// ============================================================================

export function mapFleetClusterToDomain(
  context: MapperContext,
  entityNamespace: string = "default",
): Entity {
  const cluster = context.cluster;
  const name = toBackstageName(cluster.name);

  // Extract hostname from URL for description
  let hostname = cluster.url;
  try {
    hostname = new URL(cluster.url).hostname;
  } catch {
    // Keep original URL if parsing fails
  }

  const description = `Fleet Rancher Cluster: ${hostname}`;

  const annotations: Record<string, string> = {
    [ANNOTATION_LOCATION]: context.locationKey,
    [ANNOTATION_ORIGIN_LOCATION]: context.locationKey,
    [ANNOTATION_FLEET_CLUSTER]: cluster.name,
    [`${FLEET_ANNOTATION_PREFIX}/url`]: cluster.url,
  };

  // Add namespace list
  const namespaceNames = cluster.namespaces.map((ns) => ns.name);
  annotations[`${FLEET_ANNOTATION_PREFIX}/namespaces`] =
    namespaceNames.join(",");

  const tags = ["fleet", "rancher", "gitops"];

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Domain",
    metadata: {
      name,
      namespace: entityNamespace,
      description,
      annotations,
      tags,
      links: [{ url: cluster.url, title: "Rancher Fleet" }],
    },
    spec: {
      owner: "platform-team",
    },
  };
}

// ============================================================================
// Cluster (downstream) → Resource (type: kubernetes-cluster)
// ============================================================================

export function mapClusterToResource(
  clusterId: string,
  clusterName: string | undefined,
  namespace: string,
  context: MapperContext,
): Entity {
  const safeName = toBackstageName(clusterName ?? clusterId);
  const entityNamespace = toEntityNamespace(namespace);
  const annotations: Record<string, string> = {
    [ANNOTATION_LOCATION]: context.locationKey,
    [ANNOTATION_ORIGIN_LOCATION]: context.locationKey,
    [ANNOTATION_FLEET_CLUSTER]: clusterId,
    [ANNOTATION_KUBERNETES_ID]: clusterId,
  };

  const description = `Downstream Kubernetes cluster: ${
    clusterName ?? clusterId
  }`;

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Resource",
    metadata: {
      name: safeName,
      namespace: entityNamespace,
      description,
      annotations,
      tags: ["fleet", "kubernetes-cluster"],
    },
    spec: {
      type: "kubernetes-cluster",
      owner: "platform-team",
    },
  };
}

// ============================================================================
// GitRepo → System
// ============================================================================

export function mapGitRepoToSystem(
  gitRepo: FleetGitRepo,
  context: MapperContext,
): Entity {
  const name = toBackstageName(gitRepo.metadata?.name ?? "fleet-gitrepo");
  const namespace = toEntityNamespace(
    gitRepo.metadata?.namespace ?? "fleet-default",
  );
  const fleetYaml = context.fleetYaml;

  const targets =
    gitRepo.spec?.targets?.map((t) => t.name).filter(Boolean) ?? [];
  const status = gitRepo.status?.display?.state ?? "Unknown";

  const descriptionFromRepo =
    gitRepo.metadata?.annotations?.["field.cattle.io/description"] ??
    gitRepo.metadata?.annotations?.["description"] ??
    `Fleet GitRepo: ${gitRepo.spec?.repo ?? "unknown"}`;
  const description = fleetYaml?.backstage?.description ?? descriptionFromRepo;

  const annotations: Record<string, string> = {
    [ANNOTATION_LOCATION]: context.locationKey,
    [ANNOTATION_ORIGIN_LOCATION]: context.locationKey,
    [ANNOTATION_FLEET_REPO]: gitRepo.spec?.repo ?? "",
    [ANNOTATION_FLEET_BRANCH]: gitRepo.spec?.branch ?? "main",
    [ANNOTATION_FLEET_NAMESPACE]: gitRepo.metadata?.namespace ?? "",
    [ANNOTATION_FLEET_CLUSTER]: context.cluster.name,
    [ANNOTATION_FLEET_STATUS]: status,
  };

  if (targets.length > 0) {
    annotations[ANNOTATION_FLEET_TARGETS] = JSON.stringify(targets);
  }

  if (gitRepo.spec?.repo) {
    annotations[ANNOTATION_SOURCE_LOCATION] = `url:${gitRepo.spec.repo}`;
  }

  if (gitRepo.status?.display?.readyClusters) {
    annotations[ANNOTATION_FLEET_READY_CLUSTERS] =
      gitRepo.status.display.readyClusters;
  }

  const kubeNamespace =
    deriveNamespaceFromStatus(gitRepo) ??
    deriveKubernetesNamespace(fleetYaml, gitRepo.metadata?.namespace);
  const gitRepoName = gitRepo.metadata?.name;

  if (kubeNamespace) {
    annotations[ANNOTATION_KUBERNETES_NAMESPACE] = kubeNamespace;
  }
  if (gitRepoName) {
    annotations[ANNOTATION_KUBERNETES_LABEL_SELECTOR] =
      `app.kubernetes.io/name=${gitRepoName}`;
  }

  // Merge custom annotations from fleet.yaml
  if (fleetYaml?.annotations) {
    Object.assign(annotations, fleetYaml.annotations);
  }
  if (fleetYaml?.backstage?.annotations) {
    Object.assign(annotations, fleetYaml.backstage.annotations);
  }

  if (
    context.autoTechdocsRef !== false &&
    gitRepo.spec?.repo &&
    !annotations["backstage.io/techdocs-ref"]
  ) {
    const repo = gitRepo.spec.repo.replace(/\/$/, "");
    const branch = gitRepo.spec.branch ?? "main";
    annotations["backstage.io/techdocs-ref"] = `url:${repo}/-/tree/${branch}`;
  }

  const tags = ["fleet", "gitops", ...(fleetYaml?.backstage?.tags ?? [])];

  const links: Array<{ url: string; title: string }> = [];
  if (gitRepo.spec?.repo) {
    links.push({ url: gitRepo.spec.repo, title: "Git Repository" });
  }

  // Build dependsOn relations from fleet.yaml
  const dependsOn: string[] = [];
  if (fleetYaml?.backstage?.dependsOn) {
    dependsOn.push(...fleetYaml.backstage.dependsOn);
  }
  if (fleetYaml?.dependsOn) {
    dependsOn.push(...mapFleetDependsOn(fleetYaml.dependsOn, namespace));
  }

  // Build API relations
  const providesApis: string[] = [];
  const consumesApis: string[] = [];

  if (fleetYaml?.backstage?.providesApis) {
    for (const api of fleetYaml.backstage.providesApis) {
      const apiRef = stringifyEntityRef({
        kind: "API",
        namespace,
        name: toBackstageName(api.name),
      });
      providesApis.push(apiRef);
    }
  }

  if (fleetYaml?.backstage?.consumesApis) {
    consumesApis.push(...fleetYaml.backstage.consumesApis);
  }

  // Domain relation to parent Fleet Cluster
  const domain = stringifyEntityRef({
    kind: "Domain",
    namespace: "default",
    name: toBackstageName(context.cluster.name),
  });

  const derivedOwner =
    fleetYaml?.backstage?.owner ??
    deriveOwnerFromRepo(gitRepo.spec?.repo) ??
    "group:default/default";

  const spec: JsonObject = {
    lifecycle: statusToLifecycle(status),
    owner: derivedOwner,
    domain,
  };

  if (dependsOn.length > 0) {
    spec.dependsOn = [...new Set(dependsOn)];
  }
  if (providesApis.length > 0) {
    spec.providesApis = providesApis;
  }
  if (consumesApis.length > 0) {
    spec.consumesApis = consumesApis;
  }

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "System",
    metadata: {
      name,
      namespace,
      description,
      annotations,
      tags: [...new Set(tags)],
      links,
    },
    spec,
  };
}

// ============================================================================
// Bundle → Component (type: service)
// ============================================================================

export function mapBundleToComponent(
  bundle: FleetBundle,
  context: MapperContext,
): Entity {
  const name = toBackstageName(bundle.metadata?.name ?? "fleet-bundle");
  const namespace = toEntityNamespace(
    bundle.metadata?.namespace ?? "fleet-default",
  );
  const fleetYaml = context.fleetYaml;

  const gitRepoName = bundle.metadata?.labels?.["fleet.cattle.io/repo-name"];
  const bundlePath = bundle.metadata?.labels?.["fleet.cattle.io/bundle-path"];
  const status = bundle.status?.display?.state ?? "Unknown";
  const systemRef = gitRepoName
    ? stringifyEntityRef({
        kind: "System",
        namespace,
        name: toBackstageName(gitRepoName),
      })
    : undefined;

  const description =
    fleetYaml?.backstage?.description ??
    `Fleet Bundle: ${bundle.metadata?.name ?? "unknown"}`;

  const annotations: Record<string, string> = {
    [ANNOTATION_LOCATION]: context.locationKey,
    [ANNOTATION_ORIGIN_LOCATION]: context.locationKey,
    [ANNOTATION_FLEET_STATUS]: status,
    [ANNOTATION_FLEET_CLUSTER]: context.cluster.name,
  };

  if (gitRepoName) {
    annotations[ANNOTATION_FLEET_REPO_NAME] = gitRepoName;
    annotations[ANNOTATION_FLEET_SOURCE_GITREPO] = gitRepoName;
  }
  if (bundlePath) {
    annotations[ANNOTATION_FLEET_BUNDLE_PATH] = bundlePath;
  }
  if (bundle.status?.display?.readyClusters) {
    annotations[ANNOTATION_FLEET_READY_CLUSTERS] =
      bundle.status.display.readyClusters;
  }

  // Kubernetes integration annotations for Backstage K8s plugin
  // Determine the target namespace where resources will be deployed
  const targetNamespace =
    bundle.spec?.targetNamespace ??
    bundle.spec?.defaultNamespace ??
    bundle.spec?.namespace ??
    fleetYaml?.targetNamespace ??
    fleetYaml?.defaultNamespace ??
    fleetYaml?.namespace ??
    "default";
  const helmReleaseName = fleetYaml?.helm?.releaseName ?? bundle.metadata?.name;
  const objectsetHash =
    bundle.metadata?.labels?.["objectset.rio.cattle.io/hash"];

  annotations[ANNOTATION_KUBERNETES_NAMESPACE] = targetNamespace;

  // Prefer helm release name for Helm-based bundles (standard Helm label)
  if (helmReleaseName) {
    annotations[ANNOTATION_KUBERNETES_LABEL_SELECTOR] =
      `app.kubernetes.io/instance=${helmReleaseName}`;
  } else if (objectsetHash) {
    // Fallback to objectset hash, but this may select too many resources
    annotations[ANNOTATION_KUBERNETES_LABEL_SELECTOR] =
      `objectset.rio.cattle.io/hash=${objectsetHash}`;
  }

  // Merge custom annotations from fleet.yaml
  if (fleetYaml?.annotations) {
    Object.assign(annotations, fleetYaml.annotations);
  }
  if (fleetYaml?.backstage?.annotations) {
    Object.assign(annotations, fleetYaml.backstage.annotations);
  }

  const tags = ["fleet", "fleet-bundle", ...(fleetYaml?.backstage?.tags ?? [])];

  // Build dependsOn relations - Bundle depends on its parent GitRepo (System)
  const dependsOn: string[] = [];

  // From Fleet bundle dependsOn
  if (bundle.spec?.dependsOn) {
    dependsOn.push(
      ...mapFleetDependsOnToResource(bundle.spec.dependsOn, namespace),
    );
  }

  // From fleet.yaml dependsOn (Fleet native)
  if (fleetYaml?.dependsOn) {
    dependsOn.push(
      ...mapFleetDependsOnToResource(fleetYaml.dependsOn, namespace),
    );
  }

  const spec: JsonObject = {
    type: fleetYaml?.backstage?.type ?? "service",
    lifecycle: fleetYaml?.backstage?.lifecycle ?? "production",
    owner: fleetYaml?.backstage?.owner ?? "unknown",
    system: systemRef,
  };

  if (dependsOn.length > 0) {
    spec.dependsOn = [...new Set(dependsOn)];
  }

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Component",
    metadata: {
      name,
      namespace,
      description,
      annotations: {
        ...annotations,
        ...(systemRef
          ? { [ANNOTATION_TECHDOCS_ENTITY]: systemRef }
          : undefined),
      },
      tags: [...new Set(tags)],
    },
    spec,
  };
}

// ============================================================================
// BundleDeployment → Resource (per-cluster deployment status)
// ============================================================================

export function mapBundleDeploymentToResource(
  bundleDeployment: FleetBundleDeployment,
  clusterId: string,
  context: MapperContext,
  systemRef?: string,
  clusterName?: string,
): Entity {
  const bdName = bundleDeployment.metadata?.name ?? "fleet-bundle-deployment";
  const originalName = `${bdName}-${clusterId}`;
  const name = toStableBackstageName(originalName, 50);
  const namespace = toEntityNamespace(
    bundleDeployment.metadata?.namespace ?? "fleet-default",
  );

  const status = bundleDeployment.status?.display?.state ?? "Unknown";
  const clusterDisplayName = clusterName ?? clusterId;
  const clusterResourceName = toBackstageName(clusterDisplayName);

  const description = `Fleet deployment: ${bdName} on cluster ${clusterDisplayName}`;

  const annotations: Record<string, string> = {
    [ANNOTATION_LOCATION]: context.locationKey,
    [ANNOTATION_ORIGIN_LOCATION]: context.locationKey,
    [ANNOTATION_FLEET_STATUS]: status,
    [ANNOTATION_FLEET_CLUSTER]: clusterId,
    [`${FLEET_ANNOTATION_PREFIX}/bundle-deployment`]: bdName,
    [`${FLEET_ANNOTATION_PREFIX}/original-name`]: originalName,
    [`${FLEET_ANNOTATION_PREFIX}/target-cluster-id`]: clusterId,
  };

  if (bundleDeployment.status?.display?.message) {
    annotations[`${FLEET_ANNOTATION_PREFIX}/message`] =
      bundleDeployment.status.display.message.slice(0, 500);
  }

  // Extract bundle name from labels
  const bundleName =
    bundleDeployment.metadata?.labels?.["fleet.cattle.io/bundle-name"];
  if (bundleName) {
    annotations[ANNOTATION_FLEET_SOURCE_BUNDLE] = bundleName;
  }
  const clusterWorkspaceNamespace =
    extractWorkspaceNamespaceFromBundleDeploymentNamespace(
      bundleDeployment.metadata?.namespace ?? "",
    ) ?? "default";

  // BundleDeployment depends on the Bundle Component (logical workload)
  const dependsOn: string[] = [];
  if (bundleName) {
    const workspaceNamespace =
      extractWorkspaceNamespaceFromBundleDeploymentNamespace(
        bundleDeployment.metadata?.namespace ?? "",
      );
    dependsOn.push(
      stringifyEntityRef({
        kind: "Component",
        namespace: workspaceNamespace
          ? toEntityNamespace(workspaceNamespace)
          : toEntityNamespace(bundleDeployment.metadata?.namespace ?? ""),
        name: toBackstageName(bundleName),
      }),
    );
    if (systemRef) {
      annotations[ANNOTATION_TECHDOCS_ENTITY] = systemRef;
    }
  }
  // Also depend on Cluster entity
  dependsOn.push(
    stringifyEntityRef({
      kind: "Resource",
      namespace: clusterWorkspaceNamespace,
      name: clusterResourceName,
    }),
  );

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Resource",
    metadata: {
      name,
      namespace,
      description,
      annotations,
      tags: [
        "fleet",
        "fleet-deployment",
        `cluster-${clusterResourceName}`,
      ],
    },
    spec: {
      type: "fleet-deployment",
      owner: context.fleetYaml?.backstage?.owner ?? "unknown",
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    },
  };
}

// ============================================================================
// API Entity Generation (from fleet.yaml providesApis)
// ============================================================================

export function mapApiDefinitionToApi(
  apiDef: FleetYamlApiDefinition,
  gitRepoName: string,
  context: MapperContext,
): Entity {
  const name = toBackstageName(apiDef.name);
  const namespace = toEntityNamespace(
    context.fleetYaml?.defaultNamespace ?? "fleet-default",
  );

  const description =
    apiDef.description ?? `API ${apiDef.name} provided by ${gitRepoName}`;

  const annotations: Record<string, string> = {
    [ANNOTATION_LOCATION]: context.locationKey,
    [ANNOTATION_ORIGIN_LOCATION]: context.locationKey,
    [ANNOTATION_FLEET_SOURCE_GITREPO]: gitRepoName,
  };

  if (apiDef.definitionUrl) {
    annotations[`${FLEET_ANNOTATION_PREFIX}/definition-url`] =
      apiDef.definitionUrl;
  }

  // Determine API definition
  let definition = apiDef.definition ?? "";
  if (!definition && apiDef.definitionUrl) {
    definition = `# API definition from: ${apiDef.definitionUrl}`;
  }
  if (!definition) {
    definition = `# No definition provided for ${apiDef.name}`;
  }

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "API",
    metadata: {
      name,
      namespace,
      description,
      annotations,
      tags: ["fleet", "fleet-api"],
    },
    spec: {
      type: apiDef.type ?? "openapi",
      lifecycle: statusToLifecycle(undefined),
      owner: context.fleetYaml?.backstage?.owner ?? "unknown",
      definition,
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractWorkspaceNamespaceFromBundleDeploymentNamespace(
  namespace: string,
): string | undefined {
  const match = namespace.match(/^cluster-fleet-([^-]+)-.+$/);
  if (!match) return undefined;
  return `fleet-${match[1]}`;
}

export { extractWorkspaceNamespaceFromBundleDeploymentNamespace };

/**
 * Map Fleet dependsOn to Backstage Component entity references
 */
function mapFleetDependsOn(
  fleetDependsOn: BundleDependsOn[],
  namespace: string,
): string[] {
  const refs: string[] = [];

  for (const dep of fleetDependsOn) {
    if (dep.name) {
      refs.push(
        stringifyEntityRef({
          kind: "Component",
          namespace,
          name: toBackstageName(dep.name),
        }),
      );
    }
  }

  return refs;
}

/**
 * Map Fleet dependsOn to Backstage Resource entity references (for Bundles)
 */
function mapFleetDependsOnToResource(
  fleetDependsOn: BundleDependsOn[],
  namespace: string,
): string[] {
  const refs: string[] = [];

  for (const dep of fleetDependsOn) {
    if (dep.name) {
      refs.push(
        stringifyEntityRef({
          kind: "Resource",
          namespace,
          name: toBackstageName(dep.name),
        }),
      );
    }
  }

  return refs;
}

/**
 * Extract entity metadata from bundle labels
 */
export function extractBundleMetadata(bundle: FleetBundle): {
  gitRepoName?: string;
  bundlePath?: string;
  commitId?: string;
} {
  const labels = bundle.metadata?.labels ?? {};
  return {
    gitRepoName: labels["fleet.cattle.io/repo-name"],
    bundlePath: labels["fleet.cattle.io/bundle-path"],
    commitId: labels["fleet.cattle.io/commit"],
  };
}

// ============================================================================
// Entity Generation Batch Functions
// ============================================================================

export interface EntityBatch {
  domains: Entity[];
  systems: Entity[];
  components: Entity[];
  resources: Entity[];
  apis: Entity[];
}

export function createEmptyBatch(): EntityBatch {
  return {
    domains: [],
    systems: [],
    components: [],
    resources: [],
    apis: [],
  };
}

export function flattenBatch(batch: EntityBatch): Entity[] {
  return [
    ...batch.domains,
    ...batch.systems,
    ...batch.components,
    ...batch.resources,
    ...batch.apis,
  ];
}
