"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("@aws-cdk/core");
const events = require("@aws-cdk/aws-events");
const iam = require("@aws-cdk/aws-iam");
const aws_lambda_event_sources_1 = require("@aws-cdk/aws-lambda-event-sources");
const sns = require("@aws-cdk/aws-sns");
const snsSubscriptions = require("@aws-cdk/aws-sns-subscriptions");
const sqs = require("@aws-cdk/aws-sqs");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const lambda = require("@aws-cdk/aws-lambda");
const s3 = require("@aws-cdk/aws-s3");
const aws_events_targets_1 = require("@aws-cdk/aws-events-targets");
class TextractPipelineStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // The code that defines your stack goes here
        //**********SNS Topics******************************
        const jobCompletionTopic = new sns.Topic(this, 'JobCompletion');
        //**********IAM Roles******************************
        const textractServiceRole = new iam.Role(this, 'TextractServiceRole', {
            assumedBy: new iam.ServicePrincipal('textract.amazonaws.com')
        });
        textractServiceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [jobCompletionTopic.topicArn],
            actions: ["sns:Publish"]
        }));
        //**********S3 Batch Operations Role******************************
        const s3BatchOperationsRole = new iam.Role(this, 'S3BatchOperationsRole', {
            assumedBy: new iam.ServicePrincipal('batchoperations.s3.amazonaws.com')
        });
        //**********S3 Bucket******************************
        //S3 bucket for input documents and output
        const contentBucket = new s3.Bucket(this, 'DocumentsBucket', { versioned: false });
        const existingContentBucket = new s3.Bucket(this, 'ExistingDocumentsBucket', { versioned: false });
        existingContentBucket.grantReadWrite(s3BatchOperationsRole);
        const inventoryAndLogsBucket = new s3.Bucket(this, 'InventoryAndLogsBucket', { versioned: false });
        inventoryAndLogsBucket.grantReadWrite(s3BatchOperationsRole);
        //**********DynamoDB Table*************************
        //DynamoDB table with links to output in S3
        const outputTable = new dynamodb.Table(this, 'OutputTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'outputType', type: dynamodb.AttributeType.STRING }
        });
        //DynamoDB table with links to output in S3
        const documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_IMAGE
        });
        //**********SQS Queues*****************************
        //DLQ
        const dlq = new sqs.Queue(this, 'DLQ', {
            visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600)
        });
        //Input Queue for sync jobs
        const syncJobsQueue = new sqs.Queue(this, 'SyncJobs', {
            visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Input Queue for async jobs
        const asyncJobsQueue = new sqs.Queue(this, 'AsyncJobs', {
            visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Queue
        const jobResultsQueue = new sqs.Queue(this, 'JobResults', {
            visibilityTimeout: cdk.Duration.seconds(900), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Trigger
        //jobCompletionTopic.subscribeQueue(jobResultsQueue);
        jobCompletionTopic.addSubscription(new snsSubscriptions.SqsSubscription(jobResultsQueue));
        //**********Lambda Functions******************************
        // Helper Layer with helper functions
        const helperLayer = new lambda.LayerVersion(this, 'HelperLayer', {
            code: lambda.Code.fromAsset('lambda/helper'),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
            license: 'Apache-2.0',
            description: 'Helper layer.',
        });
        // Textractor helper layer
        const textractorLayer = new lambda.LayerVersion(this, 'Textractor', {
            code: lambda.Code.fromAsset('lambda/textractor'),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
            license: 'Apache-2.0',
            description: 'Textractor layer.',
        });
        //------------------------------------------------------------
        // S3 Event processor
        const s3Processor = new lambda.Function(this, 'S3Processor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/s3processor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            }
        });
        //Layer
        s3Processor.addLayers(helperLayer);
        //Trigger
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.OBJECT_CREATED]
        }));
        //Permissions
        documentsTable.grantReadWriteData(s3Processor);
        syncJobsQueue.grantSendMessages(s3Processor);
        asyncJobsQueue.grantSendMessages(s3Processor);
        //------------------------------------------------------------
        // S3 Batch Operations Event processor 
        const s3BatchProcessor = new lambda.Function(this, 'S3BatchProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/s3batchprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            },
            reservedConcurrentExecutions: 1,
        });
        //Layer
        s3BatchProcessor.addLayers(helperLayer);
        //Permissions
        documentsTable.grantReadWriteData(s3BatchProcessor);
        s3BatchProcessor.grantInvoke(s3BatchOperationsRole);
        s3BatchOperationsRole.addToPolicy(new iam.PolicyStatement({
            actions: ["lambda:*"],
            resources: ["*"]
        }));
        //------------------------------------------------------------
        // Document processor (Router to Sync/Async Pipeline)
        const documentProcessor = new lambda.Function(this, 'TaskProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/documentprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl
            }
        });
        //Layer
        documentProcessor.addLayers(helperLayer);
        //Trigger
        documentProcessor.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(documentsTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON
        }));
        //Permissions
        documentsTable.grantReadWriteData(documentProcessor);
        syncJobsQueue.grantSendMessages(documentProcessor);
        asyncJobsQueue.grantSendMessages(documentProcessor);
        //------------------------------------------------------------
        // Sync Jobs Processor (Process jobs using sync APIs)
        const syncProcessor = new lambda.Function(this, 'SyncProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/syncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: cdk.Duration.seconds(25),
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        syncProcessor.addLayers(helperLayer);
        syncProcessor.addLayers(textractorLayer);
        //Trigger
        syncProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(syncJobsQueue, {
            batchSize: 1
        }));
        //Permissions
        contentBucket.grantReadWrite(syncProcessor);
        existingContentBucket.grantReadWrite(syncProcessor);
        outputTable.grantReadWriteData(syncProcessor);
        documentsTable.grantReadWriteData(syncProcessor);
        syncProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["textract:*"],
            resources: ["*"]
        }));
        //------------------------------------------------------------
        // Async Job Processor (Start jobs using Async APIs)
        const asyncProcessor = new lambda.Function(this, 'ASyncProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/asyncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: cdk.Duration.seconds(60),
            environment: {
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                SNS_TOPIC_ARN: jobCompletionTopic.topicArn,
                SNS_ROLE_ARN: textractServiceRole.roleArn,
                AWS_DATA_PATH: "models"
            }
        });
        //asyncProcessor.addEnvironment("SNS_TOPIC_ARN", textractServiceRole.topicArn)
        //Layer
        asyncProcessor.addLayers(helperLayer);
        //Triggers
        // Run async job processor every 5 minutes
        //Enable code below after test deploy
        const rule = new events.Rule(this, 'Rule', {
            schedule: events.Schedule.expression('rate(2 minutes)')
        });
        rule.addTarget(new aws_events_targets_1.LambdaFunction(asyncProcessor));
        //Run when a job is successfully complete
        asyncProcessor.addEventSource(new aws_lambda_event_sources_1.SnsEventSource(jobCompletionTopic));
        //Permissions
        contentBucket.grantRead(asyncProcessor);
        existingContentBucket.grantReadWrite(asyncProcessor);
        asyncJobsQueue.grantConsumeMessages(asyncProcessor);
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [textractServiceRole.roleArn]
        }));
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["textract:*"],
            resources: ["*"]
        }));
        //------------------------------------------------------------
        // Async Jobs Results Processor
        const jobResultProcessor = new lambda.Function(this, 'JobResultProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/jobresultprocessor'),
            handler: 'lambda_function.lambda_handler',
            memorySize: 2000,
            reservedConcurrentExecutions: 50,
            timeout: cdk.Duration.seconds(900),
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        jobResultProcessor.addLayers(helperLayer);
        jobResultProcessor.addLayers(textractorLayer);
        //Triggers
        jobResultProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(jobResultsQueue, {
            batchSize: 1
        }));
        //Permissions
        outputTable.grantReadWriteData(jobResultProcessor);
        documentsTable.grantReadWriteData(jobResultProcessor);
        contentBucket.grantReadWrite(jobResultProcessor);
        existingContentBucket.grantReadWrite(jobResultProcessor);
        jobResultProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["textract:*"],
            resources: ["*"]
        }));
        //--------------
        // PDF Generator
        const pdfGenerator = new lambda.Function(this, 'PdfGenerator', {
            runtime: lambda.Runtime.JAVA_8,
            code: lambda.Code.asset('lambda/pdfgenerator'),
            handler: 'DemoLambdaV2::handleRequest',
            memorySize: 3000,
            timeout: cdk.Duration.seconds(900),
        });
        contentBucket.grantReadWrite(pdfGenerator);
        existingContentBucket.grantReadWrite(pdfGenerator);
        pdfGenerator.grantInvoke(syncProcessor);
        pdfGenerator.grantInvoke(asyncProcessor);
    }
}
exports.TextractPipelineStack = TextractPipelineStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGV4dHJhY3QtcGlwZWxpbmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ0ZXh0cmFjdC1waXBlbGluZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFDQUFxQztBQUNyQyw4Q0FBK0M7QUFDL0Msd0NBQXlDO0FBQ3pDLGdGQUFxSDtBQUNySCx3Q0FBeUM7QUFDekMsbUVBQW9FO0FBQ3BFLHdDQUF5QztBQUN6QyxrREFBbUQ7QUFDbkQsOENBQStDO0FBQy9DLHNDQUF1QztBQUN2QyxvRUFBMkQ7QUFFM0QsTUFBYSxxQkFBc0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNsRCxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDZDQUE2QztRQUU3QyxvREFBb0Q7UUFDcEQsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBRWhFLG1EQUFtRDtRQUNuRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDcEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHdCQUF3QixDQUFDO1NBQzlELENBQUMsQ0FBQztRQUNILG1CQUFtQixDQUFDLFdBQVcsQ0FDN0IsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsU0FBUyxFQUFFLENBQUMsa0JBQWtCLENBQUMsUUFBUSxDQUFDO1lBQ3hDLE9BQU8sRUFBRSxDQUFDLGFBQWEsQ0FBQztTQUN6QixDQUFDLENBQ0gsQ0FBQztRQUdGLGtFQUFrRTtRQUNsRSxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FB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Y0FBYyxDQUFDLFlBQVksQ0FBQyxDQUFBO1FBQ2xELFlBQVksQ0FBQyxXQUFXLENBQUMsYUFBYSxDQUFDLENBQUE7UUFDdkMsWUFBWSxDQUFDLFdBQVcsQ0FBQyxjQUFjLENBQUMsQ0FBQTtJQUMxQyxDQUFDO0NBQ0Y7QUF6U0Qsc0RBeVNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuaW1wb3J0IGV2ZW50cyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1ldmVudHMnKTtcbmltcG9ydCBpYW0gPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtaWFtJyk7XG5pbXBvcnQgeyBTM0V2ZW50U291cmNlLCBTcXNFdmVudFNvdXJjZSwgU25zRXZlbnRTb3VyY2UsIER5bmFtb0V2ZW50U291cmNlIH0gZnJvbSAnQGF3cy1jZGsvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzJztcbmltcG9ydCBzbnMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3Mtc25zJyk7XG5pbXBvcnQgc25zU3Vic2NyaXB0aW9ucyA9IHJlcXVpcmUoXCJAYXdzLWNkay9hd3Mtc25zLXN1YnNjcmlwdGlvbnNcIik7XG5pbXBvcnQgc3FzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXNxcycpO1xuaW1wb3J0IGR5bmFtb2RiID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWR5bmFtb2RiJyk7XG5pbXBvcnQgbGFtYmRhID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWxhbWJkYScpO1xuaW1wb3J0IHMzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXMzJyk7XG5pbXBvcnQge0xhbWJkYUZ1bmN0aW9ufSBmcm9tIFwiQGF3cy1jZGsvYXdzLWV2ZW50cy10YXJnZXRzXCI7XG5cbmV4cG9ydCBjbGFzcyBUZXh0cmFjdFBpcGVsaW5lU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gVGhlIGNvZGUgdGhhdCBkZWZpbmVzIHlvdXIgc3RhY2sgZ29lcyBoZXJlXG4gICAgXG4gICAgLy8qKioqKioqKioqU05TIFRvcGljcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuICAgIGNvbnN0IGpvYkNvbXBsZXRpb25Ub3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0pvYkNvbXBsZXRpb24nKTtcblxuICAgIC8vKioqKioqKioqKklBTSBSb2xlcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuICAgIGNvbnN0IHRleHRyYWN0U2VydmljZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1RleHRyYWN0U2VydmljZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgndGV4dHJhY3QuYW1hem9uYXdzLmNvbScpXG4gICAgfSk7XG4gICAgdGV4dHJhY3RTZXJ2aWNlUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICByZXNvdXJjZXM6IFtqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm5dLFxuICAgICAgICBhY3Rpb25zOiBbXCJzbnM6UHVibGlzaFwiXVxuICAgICAgfSlcbiAgICApO1xuXG5cbiAgICAvLyoqKioqKioqKipTMyBCYXRjaCBPcGVyYXRpb25zIFJvbGUqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCBzM0JhdGNoT3BlcmF0aW9uc1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1MzQmF0Y2hPcGVyYXRpb25zUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiYXRjaG9wZXJhdGlvbnMuczMuYW1hem9uYXdzLmNvbScpXG4gICAgfSk7XG5cbiAgICAvLyoqKioqKioqKipTMyBCdWNrZXQqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICAvL1MzIGJ1Y2tldCBmb3IgaW5wdXQgZG9jdW1lbnRzIGFuZCBvdXRwdXRcbiAgICBjb25zdCBjb250ZW50QnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnRG9jdW1lbnRzQnVja2V0JywgeyB2ZXJzaW9uZWQ6IGZhbHNlfSk7XG5cbiAgICBjb25zdCBleGlzdGluZ0NvbnRlbnRCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdFeGlzdGluZ0RvY3VtZW50c0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzM0JhdGNoT3BlcmF0aW9uc1JvbGUpXG5cbiAgICBjb25zdCBpbnZlbnRvcnlBbmRMb2dzQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnSW52ZW50b3J5QW5kTG9nc0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xuICAgIGludmVudG9yeUFuZExvZ3NCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoczNCYXRjaE9wZXJhdGlvbnNSb2xlKVxuXG4gICAgLy8qKioqKioqKioqRHluYW1vREIgVGFibGUqKioqKioqKioqKioqKioqKioqKioqKioqXG4gICAgLy9EeW5hbW9EQiB0YWJsZSB3aXRoIGxpbmtzIHRvIG91dHB1dCBpbiBTM1xuICAgIGNvbnN0IG91dHB1dFRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdPdXRwdXRUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9jdW1lbnRJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdvdXRwdXRUeXBlJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfVxuICAgIH0pO1xuXG4gICAgLy9EeW5hbW9EQiB0YWJsZSB3aXRoIGxpbmtzIHRvIG91dHB1dCBpbiBTM1xuICAgIGNvbnN0IGRvY3VtZW50c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEb2N1bWVudHNUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9jdW1lbnRJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzdHJlYW06IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19JTUFHRVxuICAgIH0pO1xuXG4gICAgLy8qKioqKioqKioqU1FTIFF1ZXVlcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqXG4gICAgLy9ETFFcbiAgICBjb25zdCBkbHEgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdETFEnLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLCByZXRlbnRpb25QZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEyMDk2MDApXG4gICAgfSk7XG5cbiAgICAvL0lucHV0IFF1ZXVlIGZvciBzeW5jIGpvYnNcbiAgICBjb25zdCBzeW5jSm9ic1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnU3luY0pvYnMnLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLCByZXRlbnRpb25QZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEyMDk2MDApLCBkZWFkTGV0dGVyUXVldWUgOiB7IHF1ZXVlOiBkbHEsIG1heFJlY2VpdmVDb3VudDogNTB9XG4gICAgfSk7XG5cbiAgICAvL0lucHV0IFF1ZXVlIGZvciBhc3luYyBqb2JzXG4gICAgY29uc3QgYXN5bmNKb2JzUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdBc3luY0pvYnMnLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLCByZXRlbnRpb25QZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEyMDk2MDApLCBkZWFkTGV0dGVyUXVldWUgOiB7IHF1ZXVlOiBkbHEsIG1heFJlY2VpdmVDb3VudDogNTB9XG4gICAgfSk7XG5cbiAgICAvL1F1ZXVlXG4gICAgY29uc3Qgam9iUmVzdWx0c1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnSm9iUmVzdWx0cycsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg5MDApLCByZXRlbnRpb25QZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEyMDk2MDApLCBkZWFkTGV0dGVyUXVldWUgOiB7IHF1ZXVlOiBkbHEsIG1heFJlY2VpdmVDb3VudDogNTB9XG4gICAgfSk7XG4gICAgLy9UcmlnZ2VyXG4gICAgLy9qb2JDb21wbGV0aW9uVG9waWMuc3Vic2NyaWJlUXVldWUoam9iUmVzdWx0c1F1ZXVlKTtcbiAgICBqb2JDb21wbGV0aW9uVG9waWMuYWRkU3Vic2NyaXB0aW9uKFxuICAgICAgbmV3IHNuc1N1YnNjcmlwdGlvbnMuU3FzU3Vic2NyaXB0aW9uKGpvYlJlc3VsdHNRdWV1ZSlcbiAgICApO1xuXG4gICAgLy8qKioqKioqKioqTGFtYmRhIEZ1bmN0aW9ucyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuXG4gICAgLy8gSGVscGVyIExheWVyIHdpdGggaGVscGVyIGZ1bmN0aW9uc1xuICAgIGNvbnN0IGhlbHBlckxheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgJ0hlbHBlckxheWVyJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCdsYW1iZGEvaGVscGVyJyksXG4gICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5QWVRIT05fM183XSxcbiAgICAgIGxpY2Vuc2U6ICdBcGFjaGUtMi4wJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSGVscGVyIGxheWVyLicsXG4gICAgfSk7XG5cbiAgICAvLyBUZXh0cmFjdG9yIGhlbHBlciBsYXllclxuICAgIGNvbnN0IHRleHRyYWN0b3JMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsICdUZXh0cmFjdG9yJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCdsYW1iZGEvdGV4dHJhY3RvcicpLFxuICAgICAgY29tcGF0aWJsZVJ1bnRpbWVzOiBbbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfN10sXG4gICAgICBsaWNlbnNlOiAnQXBhY2hlLTIuMCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ1RleHRyYWN0b3IgbGF5ZXIuJyxcbiAgICB9KTtcblxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBTMyBFdmVudCBwcm9jZXNzb3JcbiAgICBjb25zdCBzM1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1MzUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvczNwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU1lOQ19RVUVVRV9VUkw6IHN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIERPQ1VNRU5UU19UQUJMRTogZG9jdW1lbnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZVxuICAgICAgfVxuICAgIH0pO1xuICAgIC8vTGF5ZXJcbiAgICBzM1Byb2Nlc3Nvci5hZGRMYXllcnMoaGVscGVyTGF5ZXIpXG4gICAgLy9UcmlnZ2VyXG4gICAgczNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFMzRXZlbnRTb3VyY2UoY29udGVudEJ1Y2tldCwge1xuXG4gICAgICBldmVudHM6IFsgczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVEIF1cbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGRvY3VtZW50c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzM1Byb2Nlc3NvcilcbiAgICBzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKHMzUHJvY2Vzc29yKVxuICAgIGFzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKHMzUHJvY2Vzc29yKVxuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFMzIEJhdGNoIE9wZXJhdGlvbnMgRXZlbnQgcHJvY2Vzc29yIFxuICAgIGNvbnN0IHMzQmF0Y2hQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTM0JhdGNoUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvczNiYXRjaHByb2Nlc3NvcicpLFxuICAgICAgaGFuZGxlcjogJ2xhbWJkYV9mdW5jdGlvbi5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgT1VUUFVUX1RBQkxFOiBvdXRwdXRUYWJsZS50YWJsZU5hbWVcbiAgICAgIH0sXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAxLFxuICAgIH0pO1xuICAgIC8vTGF5ZXJcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmFkZExheWVycyhoZWxwZXJMYXllcilcbiAgICAvL1Blcm1pc3Npb25zXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHMzQmF0Y2hQcm9jZXNzb3IpXG4gICAgczNCYXRjaFByb2Nlc3Nvci5ncmFudEludm9rZShzM0JhdGNoT3BlcmF0aW9uc1JvbGUpXG4gICAgczNCYXRjaE9wZXJhdGlvbnNSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6KlwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdXG4gICAgICB9KVxuICAgICk7XG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIERvY3VtZW50IHByb2Nlc3NvciAoUm91dGVyIHRvIFN5bmMvQXN5bmMgUGlwZWxpbmUpXG4gICAgY29uc3QgZG9jdW1lbnRQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdUYXNrUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvZG9jdW1lbnRwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU1lOQ19RVUVVRV9VUkw6IHN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmxcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgZG9jdW1lbnRQcm9jZXNzb3IuYWRkTGF5ZXJzKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlclxuICAgIGRvY3VtZW50UHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShkb2N1bWVudHNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OXG4gICAgfSkpO1xuXG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGRvY3VtZW50c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShkb2N1bWVudFByb2Nlc3NvcilcbiAgICBzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGRvY3VtZW50UHJvY2Vzc29yKVxuICAgIGFzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGRvY3VtZW50UHJvY2Vzc29yKVxuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFN5bmMgSm9icyBQcm9jZXNzb3IgKFByb2Nlc3Mgam9icyB1c2luZyBzeW5jIEFQSXMpXG4gICAgY29uc3Qgc3luY1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1N5bmNQcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM183LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zeW5jcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDEsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygyNSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgRE9DVU1FTlRTX1RBQkxFOiBkb2N1bWVudHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFXU19EQVRBX1BBVEggOiBcIm1vZGVsc1wiXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9MYXllclxuICAgIHN5bmNQcm9jZXNzb3IuYWRkTGF5ZXJzKGhlbHBlckxheWVyKVxuICAgIHN5bmNQcm9jZXNzb3IuYWRkTGF5ZXJzKHRleHRyYWN0b3JMYXllcilcbiAgICAvL1RyaWdnZXJcbiAgICBzeW5jUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTcXNFdmVudFNvdXJjZShzeW5jSm9ic1F1ZXVlLCB7XG4gICAgICBiYXRjaFNpemU6IDFcbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcbiAgICBvdXRwdXRUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcbiAgICBzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1widGV4dHJhY3Q6KlwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gQXN5bmMgSm9iIFByb2Nlc3NvciAoU3RhcnQgam9icyB1c2luZyBBc3luYyBBUElzKVxuICAgIGNvbnN0IGFzeW5jUHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQVN5bmNQcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM183LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9hc3luY3Byb2Nlc3NvcicpLFxuICAgICAgaGFuZGxlcjogJ2xhbWJkYV9mdW5jdGlvbi5sYW1iZGFfaGFuZGxlcicsXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAxLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQVNZTkNfUVVFVUVfVVJMOiBhc3luY0pvYnNRdWV1ZS5xdWV1ZVVybCxcbiAgICAgICAgU05TX1RPUElDX0FSTiA6IGpvYkNvbXBsZXRpb25Ub3BpYy50b3BpY0FybixcbiAgICAgICAgU05TX1JPTEVfQVJOIDogdGV4dHJhY3RTZXJ2aWNlUm9sZS5yb2xlQXJuLFxuICAgICAgICBBV1NfREFUQV9QQVRIIDogXCJtb2RlbHNcIlxuICAgICAgfVxuICAgIH0pO1xuICAgIC8vYXN5bmNQcm9jZXNzb3IuYWRkRW52aXJvbm1lbnQoXCJTTlNfVE9QSUNfQVJOXCIsIHRleHRyYWN0U2VydmljZVJvbGUudG9waWNBcm4pXG5cbiAgICAvL0xheWVyXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkTGF5ZXJzKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlcnNcbiAgICAvLyBSdW4gYXN5bmMgam9iIHByb2Nlc3NvciBldmVyeSA1IG1pbnV0ZXNcbiAgICAvL0VuYWJsZSBjb2RlIGJlbG93IGFmdGVyIHRlc3QgZGVwbG95XG4gICAgIGNvbnN0IHJ1bGUgPSBuZXcgZXZlbnRzLlJ1bGUodGhpcywgJ1J1bGUnLCB7XG4gICAgICAgc2NoZWR1bGU6IGV2ZW50cy5TY2hlZHVsZS5leHByZXNzaW9uKCdyYXRlKDIgbWludXRlcyknKVxuICAgICB9KTtcbiAgICAgcnVsZS5hZGRUYXJnZXQobmV3IExhbWJkYUZ1bmN0aW9uKGFzeW5jUHJvY2Vzc29yKSk7XG5cbiAgICAvL1J1biB3aGVuIGEgam9iIGlzIHN1Y2Nlc3NmdWxseSBjb21wbGV0ZVxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTbnNFdmVudFNvdXJjZShqb2JDb21wbGV0aW9uVG9waWMpKVxuICAgIC8vUGVybWlzc2lvbnNcbiAgICBjb250ZW50QnVja2V0LmdyYW50UmVhZChhc3luY1Byb2Nlc3NvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoYXN5bmNQcm9jZXNzb3IpXG4gICAgYXN5bmNKb2JzUXVldWUuZ3JhbnRDb25zdW1lTWVzc2FnZXMoYXN5bmNQcm9jZXNzb3IpXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJpYW06UGFzc1JvbGVcIl0sXG4gICAgICAgIHJlc291cmNlczogW3RleHRyYWN0U2VydmljZVJvbGUucm9sZUFybl1cbiAgICAgIH0pXG4gICAgKTtcbiAgICBhc3luY1Byb2Nlc3Nvci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcInRleHRyYWN0OipcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXVxuICAgICAgfSlcbiAgICApO1xuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBBc3luYyBKb2JzIFJlc3VsdHMgUHJvY2Vzc29yXG4gICAgY29uc3Qgam9iUmVzdWx0UHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnSm9iUmVzdWx0UHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvam9icmVzdWx0cHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIG1lbW9yeVNpemU6IDIwMDAsXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiA1MCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDkwMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgRE9DVU1FTlRTX1RBQkxFOiBkb2N1bWVudHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFXU19EQVRBX1BBVEggOiBcIm1vZGVsc1wiXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9MYXllclxuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRMYXllcnMoaGVscGVyTGF5ZXIpXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZExheWVycyh0ZXh0cmFjdG9yTGF5ZXIpXG4gICAgLy9UcmlnZ2Vyc1xuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRFdmVudFNvdXJjZShuZXcgU3FzRXZlbnRTb3VyY2Uoam9iUmVzdWx0c1F1ZXVlLCB7XG4gICAgICBiYXRjaFNpemU6IDFcbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIG91dHB1dFRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShqb2JSZXN1bHRQcm9jZXNzb3IpXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGpvYlJlc3VsdFByb2Nlc3NvcilcbiAgICBjb250ZW50QnVja2V0LmdyYW50UmVhZFdyaXRlKGpvYlJlc3VsdFByb2Nlc3NvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcInRleHRyYWN0OipcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFBERiBHZW5lcmF0b3JcbiAgICBjb25zdCBwZGZHZW5lcmF0b3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdQZGZHZW5lcmF0b3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5KQVZBXzgsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3BkZmdlbmVyYXRvcicpLFxuICAgICAgaGFuZGxlcjogJ0RlbW9MYW1iZGFWMjo6aGFuZGxlUmVxdWVzdCcsXG4gICAgICBtZW1vcnlTaXplOiAzMDAwLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoOTAwKSxcbiAgICB9KTtcbiAgICBjb250ZW50QnVja2V0LmdyYW50UmVhZFdyaXRlKHBkZkdlbmVyYXRvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUocGRmR2VuZXJhdG9yKVxuICAgIHBkZkdlbmVyYXRvci5ncmFudEludm9rZShzeW5jUHJvY2Vzc29yKVxuICAgIHBkZkdlbmVyYXRvci5ncmFudEludm9rZShhc3luY1Byb2Nlc3NvcilcbiAgfVxufVxuIl19