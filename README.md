# @gorizond/catalog-backend-module-fleet

Backstage Catalog Backend Module for Rancher Fleet GitOps.

This module provides an EntityProvider that synchronizes Rancher Fleet GitOps resources into the Backstage Software Catalog.

## Entity Mapping

| Fleet Resource | Backstage Entity | Type | Description |
|----------------|------------------|------|-------------|
| Fleet Cluster (config) | **System** | - | Rancher Fleet management cluster |
| GitRepo | **Component** | `service` | Git repository managed by Fleet |
| Bundle | **Resource** | `fleet-bundle` | Deployed bundle from GitRepo |
| BundleDeployment | **Resource** | `fleet-deployment` | Per-cluster deployment status |

### Entity Hierarchy

```
System (rancher-prod)                    <- Fleet management cluster
  └── Component (my-app)                 <- GitRepo
        └── Resource (my-app-bundle)     <- Bundle
              └── Resource (my-app-bundle-prod)  <- BundleDeployment
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

### Simple Configuration

```yaml
catalog:
  providers:
    fleet:
      name: rancher-prod
      url: https://rancher.example.com/k8s/clusters/local
      token: ${FLEET_TOKEN}
      namespaces:
        - fleet-default
      schedule:
        frequency:
          minutes: 10
        timeout:
          minutes: 5
```

### Full Configuration

```yaml
catalog:
  providers:
    fleet:
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
| `backstage.io/kubernetes-id` | Kubernetes plugin integration |

### Resource (Bundle) Annotations

| Annotation | Description |
|------------|-------------|
| `fleet.cattle.io/repo-name` | Parent GitRepo name |
| `fleet.cattle.io/bundle-path` | Path within GitRepo |
| `fleet.cattle.io/status` | Bundle status |
| `backstage.io/kubernetes-id` | Kubernetes plugin integration |
| `backstage.io/kubernetes-namespace` | Target namespace |
| `backstage.io/kubernetes-label-selector` | Helm release label selector |

## Kubernetes Plugin Integration

Entities are automatically annotated for the Backstage Kubernetes plugin:

- `backstage.io/kubernetes-id`: Links to the Fleet cluster
- `backstage.io/kubernetes-namespace`: Target deployment namespace
- `backstage.io/kubernetes-label-selector`: Helm release selector

This enables the Kubernetes tab in Backstage to show pods, deployments, and other resources for Fleet-managed applications.

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
