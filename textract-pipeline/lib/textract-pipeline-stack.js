"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("@aws-cdk/cdk");
const events = require("@aws-cdk/aws-events");
const iam = require("@aws-cdk/aws-iam");
const aws_lambda_event_sources_1 = require("@aws-cdk/aws-lambda-event-sources");
const sns = require("@aws-cdk/aws-sns");
const sqs = require("@aws-cdk/aws-sqs");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const lambda = require("@aws-cdk/aws-lambda");
const s3 = require("@aws-cdk/aws-s3");
class TextractPipelineStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        //**********SNS Topics******************************
        const jobCompletionTopic = new sns.Topic(this, 'JobCompletion');
        //**********IAM Roles******************************
        const textractServiceRole = new iam.Role(this, 'TextractServiceRole', {
            assumedBy: new iam.ServicePrincipal('textract.amazonaws.com')
        });
        textractServiceRole.addToPolicy(new iam.PolicyStatement().addResource(jobCompletionTopic.topicArn).addAction('sns:Publish'));
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
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.String },
            sortKey: { name: 'outputType', type: dynamodb.AttributeType.String }
        });
        //DynamoDB table with links to output in S3
        const documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.String },
            streamSpecification: dynamodb.StreamViewType.NewImage
        });
        //**********SQS Queues*****************************
        //Input Queue for sync jobs
        const syncJobsQueue = new sqs.Queue(this, 'SyncJobs', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600
        });
        //Input Queue for async jobs
        const asyncJobsQueue = new sqs.Queue(this, 'AsyncJobs', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600
        });
        //Queue
        const jobResultsQueue = new sqs.Queue(this, 'JobResults', {
            visibilityTimeoutSec: 900, retentionPeriodSec: 1209600
        });
        //Trigger
        jobCompletionTopic.subscribeQueue(jobResultsQueue);
        //**********Lambda Functions******************************
        // Helper Layer with helper functions
        const helperLayer = new lambda.LayerVersion(this, 'HelperLayer', {
            code: lambda.Code.asset('lambda/helper'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Helper layer.',
        });
        // Textractor helper layer
        const textractorLayer = new lambda.LayerVersion(this, 'Textractor', {
            code: lambda.Code.asset('lambda/textractor'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Textractor layer.',
        });
        //------------------------------------------------------------
        // S3 Event processor
        const s3Processor = new lambda.Function(this, 'S3Processor', {
            runtime: lambda.Runtime.Python37,
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
        s3Processor.addLayer(helperLayer);
        //Trigger
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.ObjectCreated]
        }));
        //Permissions
        documentsTable.grantReadWriteData(s3Processor);
        syncJobsQueue.grantSendMessages(s3Processor);
        asyncJobsQueue.grantSendMessages(s3Processor);
        //------------------------------------------------------------
        // S3 Batch Operations Event processor 
        const s3BatchProcessor = new lambda.Function(this, 'S3BatchProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/s3batchprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            },
            reservedConcurrentExecutions: 1,
        });
        //Layer
        s3BatchProcessor.addLayer(helperLayer);
        //Permissions
        documentsTable.grantReadWriteData(s3BatchProcessor);
        s3BatchProcessor.grantInvoke(s3BatchOperationsRole);
        s3BatchOperationsRole.addToPolicy(new iam.PolicyStatement().addAllResources().addActions("lambda:*"));
        //------------------------------------------------------------
        // Document processor (Router to Sync/Async Pipeline)
        const documentProcessor = new lambda.Function(this, 'TaskProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/documentprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl
            }
        });
        //Layer
        documentProcessor.addLayer(helperLayer);
        //Trigger
        documentProcessor.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(documentsTable, {
            startingPosition: lambda.StartingPosition.TrimHorizon
        }));
        //Permissions
        documentsTable.grantReadWriteData(documentProcessor);
        syncJobsQueue.grantSendMessages(documentProcessor);
        asyncJobsQueue.grantSendMessages(documentProcessor);
        //------------------------------------------------------------
        // Sync Jobs Processor (Process jobs using sync APIs)
        const syncProcessor = new lambda.Function(this, 'SyncProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/syncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: 25,
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        syncProcessor.addLayer(helperLayer);
        syncProcessor.addLayer(textractorLayer);
        //Trigger
        syncProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(syncJobsQueue, {
            batchSize: 1
        }));
        //Permissions
        contentBucket.grantReadWrite(syncProcessor);
        existingContentBucket.grantReadWrite(syncProcessor);
        outputTable.grantReadWriteData(syncProcessor);
        documentsTable.grantReadWriteData(syncProcessor);
        syncProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addActions("textract:*"));
        //------------------------------------------------------------
        // Async Job Processor (Start jobs using Async APIs)
        const asyncProcessor = new lambda.Function(this, 'ASyncProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/asyncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: 60,
            environment: {
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                SNS_TOPIC_ARN: jobCompletionTopic.topicArn,
                SNS_ROLE_ARN: textractServiceRole.roleArn,
                AWS_DATA_PATH: "models"
            }
        });
        //asyncProcessor.addEnvironment("SNS_TOPIC_ARN", textractServiceRole.topicArn)
        //Layer
        asyncProcessor.addLayer(helperLayer);
        //Triggers
        // Run async job processor every 5 minutes
        const rule = new events.EventRule(this, 'Rule', {
            scheduleExpression: 'rate(2 minutes)',
        });
        rule.addTarget(asyncProcessor);
        //Run when a job is successfully complete
        asyncProcessor.addEventSource(new aws_lambda_event_sources_1.SnsEventSource(jobCompletionTopic));
        //Permissions
        contentBucket.grantRead(asyncProcessor);
        existingContentBucket.grantReadWrite(asyncProcessor);
        asyncJobsQueue.grantConsumeMessages(asyncProcessor);
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement().addResource(textractServiceRole.roleArn).addAction('iam:PassRole'));
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction("textract:*"));
        //------------------------------------------------------------
        // Async Jobs Results Processor
        const jobResultProcessor = new lambda.Function(this, 'JobResultProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/jobresultprocessor'),
            handler: 'lambda_function.lambda_handler',
            memorySize: 2000,
            reservedConcurrentExecutions: 50,
            timeout: 900,
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        jobResultProcessor.addLayer(helperLayer);
        jobResultProcessor.addLayer(textractorLayer);
        //Triggers
        jobResultProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(jobResultsQueue, {
            batchSize: 1
        }));
        //Permissions
        outputTable.grantReadWriteData(jobResultProcessor);
        documentsTable.grantReadWriteData(jobResultProcessor);
        contentBucket.grantReadWrite(jobResultProcessor);
        existingContentBucket.grantReadWrite(jobResultProcessor);
        jobResultProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction("textract:*"));
    }
}
exports.TextractPipelineStack = TextractPipelineStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGV4dHJhY3QtcGlwZWxpbmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ0ZXh0cmFjdC1waXBlbGluZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG9DQUFxQztBQUNyQyw4Q0FBK0M7QUFDL0Msd0NBQXlDO0FBQ3pDLGdGQUFxSDtBQUNySCx3Q0FBeUM7QUFDekMsd0NBQXlDO0FBQ3pDLGtEQUFtRDtBQUNuRCw4Q0FBK0M7QUFDL0Msc0NBQXVDO0FBRXZDLE1BQWEscUJBQXNCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFFbEQsWUFBWSxLQUFvQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUNsRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixvREFBb0Q7UUFDcEQsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBRWhFLG1EQUFtRDtRQUNuRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDcEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHdCQUF3QixDQUFDO1NBQzlELENBQUMsQ0FBQztRQUNILG1CQUFtQixDQUFDLFdBQVcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLEVBQUUsQ0FBQyxXQUFXLENBQUMsa0JBQWtCLENBQUMsUUFBUSxDQUFDLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUM7UUFFN0gsa0VBQWtFO1FBQ2xFLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUN4RSxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsa0NBQWtDLENBQUM7U0FDeEUsQ0FBQyxDQUFDO1FBRUgsbURB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QUMsY0FBYyxDQUFDLElBQUkseUNBQWMsQ0FBQyxlQUFlLEVBQUU7WUFDcEUsU0FBUyxFQUFFLENBQUM7U0FDYixDQUFDLENBQUMsQ0FBQztRQUNKLGFBQWE7UUFDYixXQUFXLENBQUMsa0JBQWtCLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtRQUNsRCxjQUFjLENBQUMsa0JBQWtCLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtRQUNyRCxhQUFhLENBQUMsY0FBYyxDQUFDLGtCQUFrQixDQUFDLENBQUE7UUFDaEQscUJBQXFCLENBQUMsY0FBYyxDQUFDLGtCQUFrQixDQUFDLENBQUE7UUFDeEQsa0JBQWtCLENBQUMsZUFBZSxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsRUFBRSxDQUFDLGVBQWUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFBO0lBQ3pHLENBQUM7Q0FDRjtBQWpQRCxzREFpUEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgY2RrID0gcmVxdWlyZSgnQGF3cy1jZGsvY2RrJyk7XG5pbXBvcnQgZXZlbnRzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWV2ZW50cycpO1xuaW1wb3J0IGlhbSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1pYW0nKTtcbmltcG9ydCB7IFMzRXZlbnRTb3VyY2UsIFNxc0V2ZW50U291cmNlLCBTbnNFdmVudFNvdXJjZSwgRHluYW1vRXZlbnRTb3VyY2UgfSBmcm9tICdAYXdzLWNkay9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnO1xuaW1wb3J0IHNucyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zbnMnKTtcbmltcG9ydCBzcXMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3Mtc3FzJyk7XG5pbXBvcnQgZHluYW1vZGIgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtZHluYW1vZGInKTtcbmltcG9ydCBsYW1iZGEgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtbGFtYmRhJyk7XG5pbXBvcnQgczMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtczMnKTtcblxuZXhwb3J0IGNsYXNzIFRleHRyYWN0UGlwZWxpbmVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5Db25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vKioqKioqKioqKlNOUyBUb3BpY3MqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCBqb2JDb21wbGV0aW9uVG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdKb2JDb21wbGV0aW9uJyk7XG5cbiAgICAvLyoqKioqKioqKipJQU0gUm9sZXMqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCB0ZXh0cmFjdFNlcnZpY2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUZXh0cmFjdFNlcnZpY2VSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ3RleHRyYWN0LmFtYXpvbmF3cy5jb20nKVxuICAgIH0pO1xuICAgIHRleHRyYWN0U2VydmljZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoKS5hZGRSZXNvdXJjZShqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm4pLmFkZEFjdGlvbignc25zOlB1Ymxpc2gnKSk7XG5cbiAgICAvLyoqKioqKioqKipTMyBCYXRjaCBPcGVyYXRpb25zIFJvbGUqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCBzM0JhdGNoT3BlcmF0aW9uc1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1MzQmF0Y2hPcGVyYXRpb25zUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiYXRjaG9wZXJhdGlvbnMuczMuYW1hem9uYXdzLmNvbScpXG4gICAgfSk7XG5cbiAgICAvLyoqKioqKioqKipTMyBCdWNrZXQqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICAvL1MzIGJ1Y2tldCBmb3IgaW5wdXQgZG9jdW1lbnRzIGFuZCBvdXRwdXRcbiAgICBjb25zdCBjb250ZW50QnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnRG9jdW1lbnRzQnVja2V0JywgeyB2ZXJzaW9uZWQ6IGZhbHNlfSk7XG5cbiAgICBjb25zdCBleGlzdGluZ0NvbnRlbnRCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdFeGlzdGluZ0RvY3VtZW50c0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzM0JhdGNoT3BlcmF0aW9uc1JvbGUpXG5cbiAgICBjb25zdCBpbnZlbnRvcnlBbmRMb2dzQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnSW52ZW50b3J5QW5kTG9nc0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xuICAgIGludmVudG9yeUFuZExvZ3NCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoczNCYXRjaE9wZXJhdGlvbnNSb2xlKVxuXG4gICAgLy8qKioqKioqKioqRHluYW1vREIgVGFibGUqKioqKioqKioqKioqKioqKioqKioqKioqXG4gICAgLy9EeW5hbW9EQiB0YWJsZSB3aXRoIGxpbmtzIHRvIG91dHB1dCBpbiBTM1xuICAgIGNvbnN0IG91dHB1dFRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdPdXRwdXRUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9jdW1lbnRJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU3RyaW5nIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdvdXRwdXRUeXBlJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TdHJpbmcgfVxuICAgIH0pO1xuXG4gICAgLy9EeW5hbW9EQiB0YWJsZSB3aXRoIGxpbmtzIHRvIG91dHB1dCBpbiBTM1xuICAgIGNvbnN0IGRvY3VtZW50c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEb2N1bWVudHNUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9jdW1lbnRJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU3RyaW5nIH0sXG4gICAgICBzdHJlYW1TcGVjaWZpY2F0aW9uOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5OZXdJbWFnZVxuICAgIH0pO1xuXG4gICAgLy8qKioqKioqKioqU1FTIFF1ZXVlcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqXG4gICAgLy9JbnB1dCBRdWV1ZSBmb3Igc3luYyBqb2JzXG4gICAgY29uc3Qgc3luY0pvYnNRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ1N5bmNKb2JzJywge1xuICAgICAgdmlzaWJpbGl0eVRpbWVvdXRTZWM6IDMwLCByZXRlbnRpb25QZXJpb2RTZWM6IDEyMDk2MDBcbiAgICB9KTtcblxuICAgIC8vSW5wdXQgUXVldWUgZm9yIGFzeW5jIGpvYnNcbiAgICBjb25zdCBhc3luY0pvYnNRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ0FzeW5jSm9icycsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0U2VjOiAzMCwgcmV0ZW50aW9uUGVyaW9kU2VjOiAxMjA5NjAwXG4gICAgfSk7XG5cbiAgICAvL1F1ZXVlXG4gICAgY29uc3Qgam9iUmVzdWx0c1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnSm9iUmVzdWx0cycsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0U2VjOiA5MDAsIHJldGVudGlvblBlcmlvZFNlYzogMTIwOTYwMFxuICAgIH0pO1xuICAgIC8vVHJpZ2dlclxuICAgIGpvYkNvbXBsZXRpb25Ub3BpYy5zdWJzY3JpYmVRdWV1ZShqb2JSZXN1bHRzUXVldWUpO1xuXG4gICAgLy8qKioqKioqKioqTGFtYmRhIEZ1bmN0aW9ucyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuXG4gICAgLy8gSGVscGVyIExheWVyIHdpdGggaGVscGVyIGZ1bmN0aW9uc1xuICAgIGNvbnN0IGhlbHBlckxheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgJ0hlbHBlckxheWVyJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9oZWxwZXInKSxcbiAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW2xhbWJkYS5SdW50aW1lLlB5dGhvbjM3XSxcbiAgICAgIGxpY2Vuc2U6ICdBcGFjaGUtMi4wJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSGVscGVyIGxheWVyLicsXG4gICAgfSk7XG5cbiAgICAvLyBUZXh0cmFjdG9yIGhlbHBlciBsYXllclxuICAgIGNvbnN0IHRleHRyYWN0b3JMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsICdUZXh0cmFjdG9yJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS90ZXh0cmFjdG9yJyksXG4gICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5QeXRob24zN10sXG4gICAgICBsaWNlbnNlOiAnQXBhY2hlLTIuMCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ1RleHRyYWN0b3IgbGF5ZXIuJyxcbiAgICB9KTtcblxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBTMyBFdmVudCBwcm9jZXNzb3JcbiAgICBjb25zdCBzM1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1MzUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3MzcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNZTkNfUVVFVUVfVVJMOiBzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBBU1lOQ19RVUVVRV9VUkw6IGFzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgT1VUUFVUX1RBQkxFOiBvdXRwdXRUYWJsZS50YWJsZU5hbWVcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgczNQcm9jZXNzb3IuYWRkTGF5ZXIoaGVscGVyTGF5ZXIpXG4gICAgLy9UcmlnZ2VyXG4gICAgczNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFMzRXZlbnRTb3VyY2UoY29udGVudEJ1Y2tldCwge1xuICAgICAgZXZlbnRzOiBbIHMzLkV2ZW50VHlwZS5PYmplY3RDcmVhdGVkIF1cbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGRvY3VtZW50c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzM1Byb2Nlc3NvcilcbiAgICBzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKHMzUHJvY2Vzc29yKVxuICAgIGFzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKHMzUHJvY2Vzc29yKVxuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFMzIEJhdGNoIE9wZXJhdGlvbnMgRXZlbnQgcHJvY2Vzc29yIFxuICAgIGNvbnN0IHMzQmF0Y2hQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTM0JhdGNoUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3MzYmF0Y2hwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgRE9DVU1FTlRTX1RBQkxFOiBkb2N1bWVudHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIE9VVFBVVF9UQUJMRTogb3V0cHV0VGFibGUudGFibGVOYW1lXG4gICAgICB9LFxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMSxcbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgczNCYXRjaFByb2Nlc3Nvci5hZGRMYXllcihoZWxwZXJMYXllcilcbiAgICAvL1Blcm1pc3Npb25zXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHMzQmF0Y2hQcm9jZXNzb3IpXG4gICAgczNCYXRjaFByb2Nlc3Nvci5ncmFudEludm9rZShzM0JhdGNoT3BlcmF0aW9uc1JvbGUpXG4gICAgczNCYXRjaE9wZXJhdGlvbnNSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KCkuYWRkQWxsUmVzb3VyY2VzKCkuYWRkQWN0aW9ucyhcImxhbWJkYToqXCIpKVxuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIERvY3VtZW50IHByb2Nlc3NvciAoUm91dGVyIHRvIFN5bmMvQXN5bmMgUGlwZWxpbmUpXG4gICAgY29uc3QgZG9jdW1lbnRQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdUYXNrUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2RvY3VtZW50cHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNZTkNfUVVFVUVfVVJMOiBzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBBU1lOQ19RVUVVRV9VUkw6IGFzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9MYXllclxuICAgIGRvY3VtZW50UHJvY2Vzc29yLmFkZExheWVyKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlclxuICAgIGRvY3VtZW50UHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShkb2N1bWVudHNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVHJpbUhvcml6b25cbiAgICB9KSk7XG5cbiAgICAvL1Blcm1pc3Npb25zXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGRvY3VtZW50UHJvY2Vzc29yKVxuICAgIHN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoZG9jdW1lbnRQcm9jZXNzb3IpXG4gICAgYXN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoZG9jdW1lbnRQcm9jZXNzb3IpXG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gU3luYyBKb2JzIFByb2Nlc3NvciAoUHJvY2VzcyBqb2JzIHVzaW5nIHN5bmMgQVBJcylcbiAgICBjb25zdCBzeW5jUHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnU3luY1Byb2Nlc3NvcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlB5dGhvbjM3LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zeW5jcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDEsXG4gICAgICB0aW1lb3V0OiAyNSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9VVFBVVF9UQUJMRTogb3V0cHV0VGFibGUudGFibGVOYW1lLFxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQVdTX0RBVEFfUEFUSCA6IFwibW9kZWxzXCJcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgc3luY1Byb2Nlc3Nvci5hZGRMYXllcihoZWxwZXJMYXllcilcbiAgICBzeW5jUHJvY2Vzc29yLmFkZExheWVyKHRleHRyYWN0b3JMYXllcilcbiAgICAvL1RyaWdnZXJcbiAgICBzeW5jUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTcXNFdmVudFNvdXJjZShzeW5jSm9ic1F1ZXVlLCB7XG4gICAgICBiYXRjaFNpemU6IDFcbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcbiAgICBvdXRwdXRUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcbiAgICBzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbnMoXCJ0ZXh0cmFjdDoqXCIpKVxuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIEFzeW5jIEpvYiBQcm9jZXNzb3IgKFN0YXJ0IGpvYnMgdXNpbmcgQXN5bmMgQVBJcylcbiAgICBjb25zdCBhc3luY1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0FTeW5jUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2FzeW5jcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDEsXG4gICAgICB0aW1lb3V0OiA2MCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIFNOU19UT1BJQ19BUk4gOiBqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm4sXG4gICAgICAgIFNOU19ST0xFX0FSTiA6IHRleHRyYWN0U2VydmljZVJvbGUucm9sZUFybixcbiAgICAgICAgQVdTX0RBVEFfUEFUSCA6IFwibW9kZWxzXCJcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL2FzeW5jUHJvY2Vzc29yLmFkZEVudmlyb25tZW50KFwiU05TX1RPUElDX0FSTlwiLCB0ZXh0cmFjdFNlcnZpY2VSb2xlLnRvcGljQXJuKVxuXG4gICAgLy9MYXllclxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZExheWVyKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlcnNcbiAgICAvLyBSdW4gYXN5bmMgam9iIHByb2Nlc3NvciBldmVyeSA1IG1pbnV0ZXNcbiAgICBjb25zdCBydWxlID0gbmV3IGV2ZW50cy5FdmVudFJ1bGUodGhpcywgJ1J1bGUnLCB7XG4gICAgICBzY2hlZHVsZUV4cHJlc3Npb246ICdyYXRlKDIgbWludXRlcyknLFxuICAgIH0pO1xuICAgIHJ1bGUuYWRkVGFyZ2V0KGFzeW5jUHJvY2Vzc29yKTtcbiAgICAvL1J1biB3aGVuIGEgam9iIGlzIHN1Y2Nlc3NmdWxseSBjb21wbGV0ZVxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTbnNFdmVudFNvdXJjZShqb2JDb21wbGV0aW9uVG9waWMpKVxuICAgIC8vUGVybWlzc2lvbnNcbiAgICBjb250ZW50QnVja2V0LmdyYW50UmVhZChhc3luY1Byb2Nlc3NvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoYXN5bmNQcm9jZXNzb3IpXG4gICAgYXN5bmNKb2JzUXVldWUuZ3JhbnRDb25zdW1lTWVzc2FnZXMoYXN5bmNQcm9jZXNzb3IpXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KCkuYWRkUmVzb3VyY2UodGV4dHJhY3RTZXJ2aWNlUm9sZS5yb2xlQXJuKS5hZGRBY3Rpb24oJ2lhbTpQYXNzUm9sZScpKVxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbihcInRleHRyYWN0OipcIikpXG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gQXN5bmMgSm9icyBSZXN1bHRzIFByb2Nlc3NvclxuICAgIGNvbnN0IGpvYlJlc3VsdFByb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0pvYlJlc3VsdFByb2Nlc3NvcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlB5dGhvbjM3LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9qb2JyZXN1bHRwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgbWVtb3J5U2l6ZTogMjAwMCxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDUwLFxuICAgICAgdGltZW91dDogOTAwLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgT1VUUFVUX1RBQkxFOiBvdXRwdXRUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERPQ1VNRU5UU19UQUJMRTogZG9jdW1lbnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBV1NfREFUQV9QQVRIIDogXCJtb2RlbHNcIlxuICAgICAgfVxuICAgIH0pO1xuICAgIC8vTGF5ZXJcbiAgICBqb2JSZXN1bHRQcm9jZXNzb3IuYWRkTGF5ZXIoaGVscGVyTGF5ZXIpXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZExheWVyKHRleHRyYWN0b3JMYXllcilcbiAgICAvL1RyaWdnZXJzXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTcXNFdmVudFNvdXJjZShqb2JSZXN1bHRzUXVldWUsIHtcbiAgICAgIGJhdGNoU2l6ZTogMVxuICAgIH0pKTtcbiAgICAvL1Blcm1pc3Npb25zXG4gICAgb3V0cHV0VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGpvYlJlc3VsdFByb2Nlc3NvcilcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShqb2JSZXN1bHRQcm9jZXNzb3IpXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbihcInRleHRyYWN0OipcIikpXG4gIH1cbn0iXX0=