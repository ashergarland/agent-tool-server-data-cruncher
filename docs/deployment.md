# Azure Container Apps deployment example

This example is replaceable hosting scaffolding. It contains no account-specific values: every
name, region and identifier is a parameter, and nothing binds this public repository to a
particular Azure subscription or GitHub account.

## Prerequisites

- Azure CLI with the Bicep CLI installed
- Docker
- permission to create subscription deployments, a resource group, role assignments, and the
  included resources
- a signed-in human user that can be granted Key Vault Secrets Officer during bootstrap
- a selected subscription (`az account set --subscription ...`)

Do not place subscription IDs, tenant IDs, credentials, or generated deployment names in tracked
files.

## What gets deployed

| Resource                     | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| User-assigned identity       | Pulls images, reads the API key, reads and writes assets          |
| Container registry           | Holds immutable images                                            |
| Key Vault                    | Holds the API key                                                 |
| Storage account              | Private blob container for uploaded assets, with lifecycle expiry |
| Log Analytics + App Insights | Logs, metrics and optional alerts                                 |
| Container App                | The tool server, scale-to-zero capable                            |

The storage account disables public blob access and shared key access, requires TLS 1.2, and grants
the app identity only Storage Blob Data Contributor **on the assets container**. Assets are deleted
by a lifecycle rule after `assetRetentionHours`, and the server independently refuses expired
assets.

## Safe two-pass provisioning

```bash
./scripts/bootstrap/provision.sh dev eastus
```

The script:

1. validates and deploys shared resources with `deployApp=false`;
2. prompts for or generates an API key and writes it directly to Key Vault;
3. signs in to the created registry, builds and pushes the image;
4. deploys again with `deployApp=true`.

The first pass prevents Container Apps from repeatedly starting with a missing Key Vault secret.
The second pass adds the app, probes, scale rules, storage configuration and monitoring after its
prerequisites exist.

## Sizing and concurrency

`jq` parses a whole document in memory, so the defaults are deliberately larger than a template
default:

| Parameter         | Default | Guidance                                                      |
| ----------------- | ------- | ------------------------------------------------------------- |
| `cpu`             | `1.0`   | Do not drop to 0.25 vCPU; jq parsing will starve              |
| `memory`          | `2Gi`   | At least ~4x `maxFileBytes` for comfortable headroom          |
| `httpConcurrency` | `6`     | Scale-out trigger; keep close to tool concurrency             |
| `toolConcurrency` | `2`     | Concurrent jq/ripgrep processes per replica                   |
| `toolQueueLimit`  | `32`    | Queued executions before callers get a retryable `busy` error |
| `maxFileBytes`    | 64 MiB  | Largest accepted upload or read                               |
| `minReplicas`     | `0`     | Keep zero for scale-to-zero; set 1 to remove cold starts      |

Probes are split: `/health` for startup and liveness, `/ready` for readiness. Readiness fails while
the app is draining, when jq or ripgrep cannot be resolved, when scratch space is not writable, or
when the asset container is unreachable, so a broken replica stops receiving traffic without being
restarted in a loop.

## Networking

`storagePublicNetworkAccess` defaults to `true` for a simple first deployment. Set it to `false`
and add private endpoints plus a VNet-integrated Container Apps environment for a fully private
deployment; the parameter exists so that change does not require editing templates.

## Identity and secrets

The Container App uses a user-assigned managed identity to pull from ACR, read the Key Vault secret
and access blobs. No registry password, storage account key, SAS token or API key is embedded in
Bicep or in the image.

The interactive bootstrap user receives Key Vault Secrets Officer so it can seed and rotate the
secret. Remove that assignment after handoff if a separate deployment identity manages rotation.

Rotate the API key by adding the replacement to `API_KEYS`, deploying, moving clients, then removing
the old key. Principals are derived from a hash of the key, so an existing key keeps its assets when
the list changes. Key Vault references are versionless; create a new revision or restart replicas
after rotation.

## Per-fork deployment and OIDC

Nothing in this repository is wired to a specific account. To deploy your own fork:

1. Create an Entra application (or user-assigned identity) in **your** tenant and add a federated
   credential for `repo:<your-org>/<your-fork>:ref:refs/heads/main` (and one per environment you
   deploy from).
2. Grant it Contributor plus User Access Administrator on the target subscription or resource group.
3. Add repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`, and use
   `azure/login@v2` with `federated-token: true` in your own deployment workflow.
4. Never commit those values; they are configuration for your fork, not for this repository.

This repository intentionally ships no deployment workflow, because a shared public workflow that
targets one owner's subscription is exactly the coupling to avoid.

## Immutable image releases

Tag images with the commit SHA and deploy by digest:

```bash
IMAGE="$REGISTRY/agent-tool-server-data-cruncher:$(git rev-parse --short HEAD)"
docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg SERVICE_VERSION="$(node -p "require('./package.json').version")" \
  -t "$IMAGE" .
docker push "$IMAGE"
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE")
az deployment sub create --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam deployApp=true containerImage="$DIGEST"
```

Never deploy `latest` to production. `/version` reports the git SHA, service version and the jq and
ripgrep versions in the running image.

## Operations

Configure `alertEmailAddress` to create an action group and a failed-request metric alert; leave it
blank to skip alerting entirely rather than committing a personal address.

Logs contain request ids, tool names, durations, byte counts and queue depth. They never contain
file contents, filters, patterns, matches, jq output, credentials, asset ids' underlying storage
paths, or raw child stderr.

On `SIGTERM` the server stops accepting work, aborts running child processes, drains in-flight
responses for `SHUTDOWN_GRACE_MS`, then removes its scratch directory.

Destroy the example by deleting its generated resource group after confirming it contains no
shared resources.
