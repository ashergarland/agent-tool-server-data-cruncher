param location string
param workspaceName string
param insightsName string

@description('Email address that receives operational alerts; leave blank to skip alerting.')
param alertEmailAddress string = ''

@description('Failed requests in five minutes before the alert fires.')
@minValue(1)
param failedRequestAlertThreshold int = 20

param tags object

var alertsEnabled = !empty(alertEmailAddress)

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (alertsEnabled) {
  name: '${insightsName}-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'atsalerts'
    enabled: true
    emailReceivers: [
      {
        name: 'operations'
        emailAddress: alertsEnabled ? alertEmailAddress : 'unused@example.invalid'
        useCommonAlertSchema: true
      }
    ]
  }
}

resource failedRequests 'Microsoft.Insights/metricAlerts@2018-03-01' = if (alertsEnabled) {
  name: '${insightsName}-failed-requests'
  location: 'global'
  tags: tags
  properties: {
    description: 'Server responses that failed in the last five minutes.'
    severity: 2
    enabled: true
    scopes: [
      insights.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failed-requests'
          metricNamespace: 'microsoft.insights/components'
          metricName: 'requests/failed'
          operator: 'GreaterThan'
          threshold: failedRequestAlertThreshold
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: alertsEnabled ? alertGroup!.id : ''
      }
    ]
  }
}

output workspaceCustomerId string = workspace.properties.customerId
@secure()
output workspaceSharedKey string = workspace.listKeys().primarySharedKey
@secure()
output applicationInsightsConnectionString string = insights.properties.ConnectionString
