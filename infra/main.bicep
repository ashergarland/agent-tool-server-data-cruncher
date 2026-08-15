targetScope = 'subscription'

@description('Short environment suffix such as dev, test, or prod.')
@minLength(2)
@maxLength(12)
param environmentName string

@description('Azure region for all resources.')
param location string = deployment().location

@description('Immutable container image reference used on the second pass.')
param containerImage string = 'replace.invalid/agent-tool-server:replace-me'

@description('False for the prerequisite pass; true only after the Key Vault secret and image exist.')
param deployApp bool = false

@description('Existing Key Vault secret name used by the application.')
param apiKeySecretName string = 'tool-server-api-key'

@description('Object ID allowed to seed the Key Vault secret during bootstrap; leave blank outside bootstrap.')
param bootstrapPrincipalObjectId string = ''

@description('Minimum replicas. Keep zero for scale-to-zero.')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

@description('vCPU per replica. jq parses whole documents, so 0.25 vCPU is unsafe for concurrent use.')
param cpu string = '1.0'

@description('Memory per replica. Must be large enough for the biggest accepted input.')
param memory string = '2Gi'

@description('Concurrent HTTP requests per replica before scaling out.')
@minValue(1)
@maxValue(100)
param httpConcurrency int = 6

@description('Concurrent jq/ripgrep executions per replica.')
@minValue(1)
@maxValue(16)
param toolConcurrency int = 2

@description('Queued tool executions per replica before callers receive a retryable busy error.')
@minValue(0)
@maxValue(512)
param toolQueueLimit int = 32

@description('Hours an uploaded asset remains readable before it is deleted.')
@minValue(1)
@maxValue(168)
param assetRetentionHours int = 24

@description('Maximum bytes accepted for a single upload or read.')
@minValue(1048576)
param maxFileBytes int = 67108864

@description('Set false to keep storage off public networks; requires private endpoints.')
param storagePublicNetworkAccess bool = true

@description('Enable local filesystem paths. Hosted deployments should keep this false and use assets.')
param localPathsEnabled bool = false

@description('Directory in the container image that local paths are restricted to when enabled.')
param dataRoot string = '/data'

@description('Email address that receives operational alerts; leave blank to skip alerting.')
param alertEmailAddress string = ''

@description('Failed requests in five minutes before the alert fires.')
@minValue(1)
param failedRequestAlertThreshold int = 20

var suffix = uniqueString(subscription().id, environmentName)
var resourceGroupName = 'rg-ats-${environmentName}-${suffix}'
var assetRetentionDays = max(1, assetRetentionHours / 24)

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    application: 'agent-tool-server'
    environment: environmentName
    managedBy: 'bicep'
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: resourceGroup
  params: {
    location: location
    name: 'id-ats-${environmentName}-${suffix}'
    tags: resourceGroup.tags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: resourceGroup
  params: {
    location: location
    name: 'crats${suffix}'
    pullPrincipalId: identity.outputs.principalId
    tags: resourceGroup.tags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: resourceGroup
  params: {
    location: location
    name: 'kv-ats-${suffix}'
    accessPrincipalObjectId: identity.outputs.principalId
    bootstrapPrincipalObjectId: bootstrapPrincipalObjectId
    tags: resourceGroup.tags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: resourceGroup
  params: {
    location: location
    name: 'stats${suffix}'
    containerName: 'assets'
    assetPrincipalId: identity.outputs.principalId
    retentionDays: assetRetentionDays
    allowPublicNetworkAccess: storagePublicNetworkAccess
    tags: resourceGroup.tags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  scope: resourceGroup
  params: {
    location: location
    workspaceName: 'log-ats-${environmentName}-${suffix}'
    insightsName: 'appi-ats-${environmentName}-${suffix}'
    alertEmailAddress: alertEmailAddress
    failedRequestAlertThreshold: failedRequestAlertThreshold
    tags: resourceGroup.tags
  }
}

module app 'modules/container-app.bicep' = if (deployApp) {
  name: 'container-app'
  scope: resourceGroup
  params: {
    location: location
    environmentName: 'cae-ats-${environmentName}-${suffix}'
    appName: 'ca-ats-${environmentName}-${suffix}'
    containerImage: containerImage
    registryServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    apiKeySecretUri: '${keyVault.outputs.vaultUri}secrets/${apiKeySecretName}'
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    logAnalyticsSharedKey: observability.outputs.workspaceSharedKey
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    cpu: cpu
    memory: memory
    httpConcurrency: httpConcurrency
    toolConcurrency: toolConcurrency
    toolQueueLimit: toolQueueLimit
    storageAccountName: storage.outputs.accountName
    storageContainerName: storage.outputs.containerName
    assetTtlSeconds: assetRetentionHours * 3600
    maxFileBytes: maxFileBytes
    localPathsEnabled: localPathsEnabled
    dataRoot: dataRoot
    tags: resourceGroup.tags
  }
}

output resourceGroupName string = resourceGroupName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output storageAccountName string = storage.outputs.accountName
output managedIdentityClientId string = identity.outputs.clientId
output applicationUrl string = deployApp ? 'https://${app!.outputs.fqdn}' : ''
