param location string
param environmentName string
param appName string
param containerImage string
param registryServer string
param identityId string
param identityClientId string
param apiKeySecretUri string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
@secure()
param applicationInsightsConnectionString string
param minReplicas int
param maxReplicas int

@description('vCPU per replica. jq parses whole documents, so keep at least 1.0 for concurrent use.')
param cpu string

@description('Memory per replica, for example 2Gi.')
param memory string

@description('Concurrent HTTP requests per replica before scaling out.')
param httpConcurrency int

@description('Concurrent jq/ripgrep executions per replica.')
param toolConcurrency int

@description('Queued tool executions per replica before callers receive a retryable busy error.')
param toolQueueLimit int

@description('Storage account holding uploaded assets.')
param storageAccountName string

@description('Private blob container holding uploaded assets.')
param storageContainerName string

@description('Seconds an uploaded asset remains readable.')
param assetTtlSeconds int

@description('Maximum bytes accepted for a single upload or read.')
param maxFileBytes int

@description('Enable local filesystem paths. Hosted deployments should use assets instead.')
param localPathsEnabled bool

@description('Directory inside the image that local paths are restricted to.')
param dataRoot string

param tags object

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'api-key'
          keyVaultUrl: apiKeySecretUri
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'tool-server'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'AUTH_MODE'
              value: 'api-key'
            }
            {
              name: 'API_KEYS'
              secretRef: 'api-key'
            }
            {
              name: 'LOCAL_PATHS_ENABLED'
              value: string(localPathsEnabled)
            }
            {
              // Container Apps ingress always fronts the app, so X-Forwarded-For is the only way
              // to tell callers apart for the per-address abuse budget.
              name: 'TRUST_PROXY'
              value: 'true'
            }
            {
              name: 'DATA_ROOT'
              value: dataRoot
            }
            {
              name: 'ASSET_STORE'
              value: 'azure-blob'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT'
              value: storageAccountName
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: storageContainerName
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identityClientId
            }
            {
              name: 'ASSET_TTL_SECONDS'
              value: string(assetTtlSeconds)
            }
            {
              name: 'MAX_FILE_BYTES'
              value: string(maxFileBytes)
            }
            {
              name: 'TOOL_CONCURRENCY'
              value: string(toolConcurrency)
            }
            {
              name: 'TOOL_QUEUE_LIMIT'
              value: string(toolQueueLimit)
            }
            {
              name: 'TEMP_DIR'
              value: '/tmp/data-cruncher'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: applicationInsightsConnectionString
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 3
              periodSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(httpConcurrency)
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
