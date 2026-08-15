using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param deployApp = false
param containerImage = 'replace.invalid/agent-tool-server:replace-me'
param minReplicas = 0
param maxReplicas = 3
param cpu = '1.0'
param memory = '2Gi'
param httpConcurrency = 6
param toolConcurrency = 2
param toolQueueLimit = 32
param assetRetentionHours = 24
param localPathsEnabled = false
param storagePublicNetworkAccess = true
