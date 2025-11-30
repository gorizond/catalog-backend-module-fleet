# @gorizond/catalog-backend-module-fleet

[![npm version](https://img.shields.io/npm/v/@gorizond/catalog-backend-module-fleet.svg)](https://www.npmjs.com/package/@gorizond/catalog-backend-module-fleet)
[![npm downloads](https://img.shields.io/npm/dm/@gorizond/catalog-backend-module-fleet.svg)](https://www.npmjs.com/package/@gorizond/catalog-backend-module-fleet)

Backstage Catalog Backend Module for Rancher Fleet GitOps.

This module provides an EntityProvider that synchronizes Rancher Fleet GitOps resources into the Backstage Software Catalog.

## Entity Mapping

| Fleet Resource | Backstage Entity | Type | Description |
|----------------|------------------|------|-------------|
| Fleet Cluster (config) | **Domain** | - | Rancher Fleet management cluster |
| Downstream Cluster (target) | **Resource** | `kubernetes-cluster` | Discovered Rancher downstream cluster |
| GitRepo | **System** | - | Git repository managed by Fleet |
| Bundle | **Component** | `service` | Deployed application/service from GitRepo |
| BundleDeployment | **Resource** | `fleet-deployment` | Per-cluster deployment status |

### Relations

- Component → System via `spec.system` (parent GitRepo)
- Component → dependsOn → BundleDeployment Resources (per-cluster deployments)
- BundleDeployment Resource → dependsOn → Component (logical bundle)
- BundleDeployment Resource → dependsOn → Cluster Resource (target cluster)

### Entity Hierarchy

```
Domain (galileosky)                          <- Fleet management cluster
  └── System (external-dns)                  <- GitRepo
        ├── Component (external-dns-operator)      <- Bundle (Helm chart)
        │     └── Resource (external-dns-operator-staging-000)  <- BundleDeployment
        │           ↳ dependsOn → Resource (staging-000)         <- Cluster
        ├── Component (external-dns-secret)        <- Bundle (Secrets)
        │     └── Resource (external-dns-secret-staging-000)    <- BundleDeployment
        │           ↳ dependsOn → Resource (staging-000)         <- Cluster
        └── Component (external-dns-internal-ingress)  <- Bundle (Ingress)
              └── Resource (external-dns-internal-ingress-staging-000)  <- BundleDeployment
                    ↳ dependsOn → Resource (staging-000)                 <- Cluster
```

## Installation

```bash
# npm
npm install @gorizond/catalog-backend-module-fleet

# yarn
yarn add @gorizond/catalog-backend-module-fleet
```

## Usage

### New Backend System (Recommended)

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@gorizond/catalog-backend-module-fleet'));

backend.start();
```

### Legacy Backend

```typescript
// packages/backend/src/plugins/catalog.ts
import { FleetEntityProvider } from '@gorizond/catalog-backend-module-fleet';

export default async function createPlugin(env: PluginEnvironment) {
  const builder = CatalogBuilder.create(env);

  const fleetProviders = FleetEntityProvider.fromConfig(env.config, {
    logger: env.logger,
  });

  for (const provider of fleetProviders) {
    builder.addEntityProvider(provider);
  }

  // ... rest of catalog setup
}
```

## Configuration

Add to your `app-config.yaml`:

### Configuration (single cluster)

```yaml
catalog:
  providers:
    fleet:
      production:
        name: rancher-prod
        url: https://rancher.example.com/k8s/clusters/local
        token: ${FLEET_TOKEN}
        caData: ${FLEET_CA_DATA}        # Optional: CA certificate
        skipTLSVerify: false            # Optional: Skip TLS verification
        namespaces:
          - fleet-default
          - fleet-local
        includeBundles: true            # Include Bundle entities (default: true)
        includeBundleDeployments: false # Include per-cluster deployments (default: false)
        generateApis: false             # Generate API entities from fleet.yaml (default: false)
        fetchFleetYaml: false           # Fetch fleet.yaml from Git (default: false)
        autoTechdocsRef: true           # Auto-set backstage.io/techdocs-ref: dir:. (default: true)
        gitRepoSelector:                # Optional: Filter GitRepos by labels
          matchLabels:
            backstage.io/discover: "true"
        schedule:
          frequency:
            minutes: 10
          timeout:
            minutes: 5
          initialDelay:
            seconds: 15
```

### Multi-Cluster Configuration

```yaml
catalog:
  providers:
    fleet:
      production:
        clusters:
          - name: rancher-us
            url: https://rancher-us.example.com/k8s/clusters/local
            token: ${FLEET_US_TOKEN}
            namespaces:
              - fleet-default
          - name: rancher-eu
            url: https://rancher-eu.example.com/k8s/clusters/local
            token: ${FLEET_EU_TOKEN}
            namespaces:
              - fleet-default
        schedule:
          frequency:
            minutes: 10
          timeout:
            minutes: 5
```

`fetchFleetYaml: true` — дополнительно скачивает `fleet.yaml` из GitRepo (используя repo URL/branch) и применяет секцию `backstage` для обогащения метаданных (owner, type, description, tags, relations, providesApis/consumesApis). Без этого флага провайдер создаёт сущности только из CRD-данных Fleet.
`autoTechdocsRef: true` — ставит `backstage.io/techdocs-ref: dir:.` автоматически, если в аннотациях нет явного значения.

## fleet.yaml Integration

You can customize Backstage entity metadata via a `backstage` section in your `fleet.yaml`:

```yaml
# fleet.yaml in your GitRepo
defaultNamespace: my-app

helm:
  releaseName: my-app
  chart: ./charts/my-app

# Backstage integration (ignored by Fleet)
backstage:
  type: service                    # Component type (default: service)
  description: "My application"
  owner: team-platform
  tags:
    - production
    - critical
  dependsOn:
    - component:default/database
  providesApis:
    - name: my-app-api
      type: openapi
      definition: |
        openapi: 3.0.0
        info:
          title: My App API
          version: 1.0.0
  consumesApis:
    - api:default/auth-api
  annotations:
    pagerduty.com/integration-key: "abc123"
dependsOn:
  - name: db                       # Fleet native dependsOn (optional)
```

## Annotations

Entities are annotated with Fleet metadata for integration with other Backstage plugins:

### Component (GitRepo) Annotations

| Annotation | Description |
|------------|-------------|
| `fleet.cattle.io/repo` | Git repository URL |
| `fleet.cattle.io/branch` | Git branch |
| `fleet.cattle.io/namespace` | Fleet namespace |
| `fleet.cattle.io/cluster` | Fleet management cluster name |
| `fleet.cattle.io/status` | Current status (Ready, NotReady, etc.) |
| `fleet.cattle.io/ready-clusters` | Ready clusters count (e.g., "3/3") |
| `backstage.io/techdocs-ref` | Auto set to repo tree URL (`url:<repo>/-/tree/<branch>`) when available; fallback `dir:.` (can be overridden) |
| `backstage.io/techdocs-entity` | Points to parent System for shared TechDocs |
| `backstage.io/kubernetes-id` | Kubernetes plugin integration |
| `backstage.io/kubernetes-namespace` | Target namespace (from fleet.yaml or GitRepo namespace) |
| `backstage.io/kubernetes-label-selector` | Helm release selector (`app.kubernetes.io/instance=...`) |

### Resource (Bundle) Annotations

| Annotation | Description |
|------------|-------------|
| `fleet.cattle.io/repo-name` | Parent GitRepo name |
| `fleet.cattle.io/bundle-path` | Path within GitRepo |
| `fleet.cattle.io/status` | Bundle status |
| `backstage.io/techdocs-entity` | Points to parent System for shared TechDocs |
| `backstage.io/kubernetes-id` | Kubernetes plugin integration |
| `backstage.io/kubernetes-namespace` | Target namespace |
| `backstage.io/kubernetes-label-selector` | Helm release label selector |

## Kubernetes Plugin Integration

Entities are automatically annotated for the Backstage Kubernetes plugin:

- `backstage.io/kubernetes-id`: Links to the Fleet cluster
- `backstage.io/kubernetes-namespace`: Target deployment namespace
- `backstage.io/kubernetes-label-selector`: Helm release selector (`System: app.kubernetes.io/name=<gitrepo>; Component: app.kubernetes.io/instance=<release>`)
- Downstream clusters are discovered automatically (via Rancher `/v3/clusters`, friendly names preserved) and emitted as `Resource` `kubernetes-cluster`; BundleDeployments depend on the target cluster resource.
- CustomResources per cluster are pulled dynamically from BundleDeployment `status.resources` so `kubernetes.clusterLocatorMethods[].customResources` stays in sync with Fleet.

This enables the Kubernetes tab in Backstage to show pods, deployments, and other resources for Fleet-managed applications.

Behavior defaults
- Description: from GitRepo annotation `description`; if `fetchFleetYaml` and `backstage.description` are present, the latter overrides.
- Owner: from `backstage.owner`; otherwise derived from repo URL (`group:default/<owner>`); fallback `group:default/default`.
- TechDocs: `backstage.io/techdocs-ref` auto `url:<repo>/-/tree/<branch>` when repo/branch known, otherwise `dir:.` (disable via `autoTechdocsRef: false`). `backstage.io/techdocs-entity` is set on Component/Resource to the parent System.
- Kubernetes annotations: `kubernetes-id` comes from targets/targetCustomizations clusterName/name (otherwise Fleet cluster name); namespace — `defaultNamespace/namespace` from `fleet.yaml` or GitRepo namespace; selector — `helm.releaseName` or GitRepo name.
- Relations: System spec.dependsOn derived from fleet.yaml dependsOn; Component spec.system points to parent System; Component spec.dependsOn includes BundleDeployment Resources; BundleDeployment spec.dependsOn points to the Bundle Component; Component/Resource carry `backstage.io/techdocs-entity` pointing to the parent System for shared TechDocs.

### Kubernetes Cluster Locator (Automatic Discovery)

The module automatically discovers all Rancher downstream clusters and makes them available to the Kubernetes backend.

#### Configuration

Add FleetK8sLocator config to enable automatic cluster discovery:

```yaml
catalog:
  providers:
    fleet:
      production:
        url: https://rancher.example.com/k8s/clusters/local
        token: ${FLEET_TOKEN}
        namespaces:
          - fleet-default
        includeBundles: true
        includeBundleDeployments: true
        fetchFleetYaml: true

    # Add this section for automatic K8s cluster discovery
    fleetK8sLocator:
      enabled: true
      rancherUrl: https://rancher.example.com
      rancherToken: ${RANCHER_TOKEN}   # Token with access to all downstream clusters
      skipTLSVerify: false
      includeLocal: true               # Include local management cluster
      fleetNamespaces:                 # Namespaces to scan BundleDeployments for CRDs (default: [fleet-default, fleet-local])
        - fleet-default
        - fleet-local
```

**That's it!** When enabled, the module will:
- ✅ Discover all Rancher clusters via `/v3/clusters` API
- ✅ Automatically inject them into `kubernetes.clusterLocatorMethods`
- ✅ Pull customResources per cluster from Fleet BundleDeployments (CRDs detected in `status.resources`)
- ✅ Update config at backend startup
- ✅ Use single Rancher token for all clusters

#### How It Works

1. At backend startup, FleetK8sLocator queries Rancher API
2. Fetches list of all clusters you have access to
3. Converts them to Kubernetes backend format
4. Injects into config dynamically

No manual cluster configuration needed!

#### Hot reload without backend restarts

If you want the Kubernetes backend to pick up Rancher clusters on the fly (without restarting Backstage), wire FleetK8sLocator into the Kubernetes cluster supplier extension point. An example module (see `packages/backend/src/modules/fleetKubernetesClusterSupplier.ts` in the sample app) looks like:

```typescript
// packages/backend/src/modules/fleetKubernetesClusterSupplier.ts
import { ANNOTATION_KUBERNETES_AUTH_PROVIDER } from '@backstage/plugin-kubernetes-common';
import {
  KubernetesClustersSupplier,
  KubernetesServiceLocator,
  kubernetesClusterSupplierExtensionPoint,
  kubernetesServiceLocatorExtensionPoint,
} from '@backstage/plugin-kubernetes-node';
import { Duration } from 'luxon';
import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { FleetK8sLocator } from '@gorizond/catalog-backend-module-fleet';

export const kubernetesFleetClusterSupplierModule = createBackendModule({
  pluginId: 'kubernetes',
  moduleId: 'fleet-cluster-supplier',
  register(env) {
    env.registerInit({
      deps: {
        clusterSupplier: kubernetesClusterSupplierExtensionPoint,
        serviceLocator: kubernetesServiceLocatorExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
      },
      async init({ clusterSupplier, serviceLocator, config, logger, scheduler }) {
        const locator = FleetK8sLocator.fromConfig({ config, logger });
        if (!locator) return;

        let cache: KubernetesClustersSupplier['getClusters'] extends () => Promise<
          infer T
        >
          ? T
          : [] = [];

        const refresh = async () => {
          const clusters = await locator.listClusters();
          cache = clusters.map(c => ({
            name: c.name,
            url: c.url,
            caData: c.caData,
            skipTLSVerify: c.skipTLSVerify,
            authMetadata: {
              [ANNOTATION_KUBERNETES_AUTH_PROVIDER]: c.authProvider ?? 'serviceAccount',
              ...(c.serviceAccountToken ? { serviceAccountToken: c.serviceAccountToken } : {}),
            },
          }));
        };

        const supplier: KubernetesClustersSupplier = {
          async getClusters() {
            if (!cache.length) await refresh();
            return cache;
          },
        };

        clusterSupplier.addClusterSupplier(async () => {
          await refresh();
          return supplier;
        });

        // Provide a default multi-tenant service locator so kubernetes plugin
        // does not require kubernetes.serviceLocatorMethod config.
        const multiTenantLocator: KubernetesServiceLocator = {
          async getClustersByEntity() {
            const clusters = await supplier.getClusters();
            return { clusters };
          },
        };
        serviceLocator.addServiceLocator(multiTenantLocator);

        const rawInterval = config.getOptionalString(
          'catalog.providers.fleetK8sLocator.refreshInterval',
        );
        const frequency = rawInterval
          ? Duration.fromISO(rawInterval)
          : Duration.fromObject({ minutes: 5 });
        const safeFrequency = frequency.isValid
          ? frequency
          : Duration.fromObject({ minutes: 5 });

        await scheduler.scheduleTask({
          id: 'fleet:k8sLocator:refresh',
          frequency: safeFrequency,
          timeout: Duration.fromObject({ minutes: 2 }),
          initialDelay: Duration.fromObject({ seconds: 15 }),
          fn: refresh,
        });
      },
    });
  },
});
```

Then register the module alongside the Kubernetes backend:

```typescript
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-kubernetes-backend'));
backend.add(import('./modules/fleetKubernetesClusterSupplier'));
```

This keeps `kubernetes.clusterLocatorMethods` valid for startup while refreshing the cluster list from Rancher on a schedule.
The module also injects default `kubernetes.serviceLocatorMethod.type=multiTenant` and an empty `clusterLocatorMethods` if they are missing, so Kubernetes plugin can start even with minimal config. The optional `catalog.providers.fleetK8sLocator.refreshInterval` accepts an ISO-8601 duration string (e.g. `PT5M`); default is 5 minutes if omitted or invalid.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## License

Apache-2.0

## Contributing

Contributions are welcome! Please open an issue or pull request on GitHub.
