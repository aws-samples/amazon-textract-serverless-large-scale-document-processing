# Large scale document processing with Amazon Textract

This reference architecture shows how you can extract text and data from documents at scale using Amazon Textract. Below are some of key attributes of reference architecture:
- Process incoming documents to an Amazon S3 bucket.
- Process large backfill of existing documents in an Amazon S3 bucket.
- Serverless, highly available and highly scalable architecture.
- Easily handle spiky workloads.
- Pipelines to support both Sync and Async APIs of Amazon Textract.
- Control the rate at which you process documents without doing any complex distributed job management. This control can be important to protect your downstream systems which will be ingesting output from Textract.
- Sample implementation which takes advantage of [AWS Cloud Development Kit (CDK)](https://docs.aws.amazon.com/cdk/latest/guide/home.html) to define infrastructure in code and provision it through CloudFormation.

## Architecture

Architecture below shows the core components. 

![](arch.png)

### Image pipeline (Use Sync APIs of Amazon Textract)
1. The process starts as a message is sent to an Amazon SQS queue to analyze a document.
2. A Lambda function is invoked synchronously with an event that contains queue message.
3. Lambda function then calls Amazon Textract and store result in different datastores for example DynamoDB, S3 or Elasticsearch.

You control the throughput of your pipeline by controlling the batch size and lambda concurrency.

### Image and PDF pipeline (Use Async APIs of Amazon Textract)

1. The process starts when a message is sent to an SQS queue to analyze a document.
2. A job scheduler lambda function runs at certain frequency for example every 5 minutes and poll for messages in the SQS queue.
3. For each message in the queue it submits an Amazon Textract job to process the document and continue submitting these jobs until it reaches the maximum limit of concurrent jobs in your AWS account.
4. As Amazon Textract is finished processing a document it sends a completion notification to an SNS topic.
5. SNS then triggers the job scheduler lambda function to start next set of Amazon Textract jobs.
6. SNS also sends a message to an SQS queue which is then processed by a Lambda function to get results from Amazon Textract and store them in a relevant dataset for example DynamoDB, S3 or Elasticsearch.

Your pipeline runs at maximum throughput based on limits on your account. If needed you can get limits raised for concurrent jobs and pipeline automatically adapts based on new limits.

## Document processing workflow

Architecture below shows overall workflow and few additional components that are used in addition to the core architecture described above to process incoming documents as well as large backfill.

![](arch-complete.png)

### Process incoming documents workflow
1. A document gets uploaded to an Amazon S3 bucket. It triggers a Lambda function which writes a task to process the document to DynamoDB.
2. Using DynamoDB streams, a Lambda function is triggered which writes to an SQS queue in one of the pipelines.
3. Documents are processed as described above by "Image Pipeline" or "Image and PDF Pipeline".

### Large backfill of existing documents workflow
1. Documents already exist in an Amazon S3 bucket.
2. We create a CSV file or use [S3 inventory](https://docs.aws.amazon.com/AmazonS3/latest/dev/storage-inventory.html) to generate a list of documents that needs to be processed.
3. We create and start an Amazon S3 batch operations job which triggers a Lambda for each object in the list.
4. Lambda writes a task to process each document to DynamoDB.
5. Using DynamoDB streams, a Lambda is triggered which writes to an SQS queue in one of the pipelines.
6. Documents are processed as described above by "Image Pipeline" or "Image and PDF Pipeline".

Similar architecture can be used for other services like Amazon Rekognition to process images and videos. Images can be routed to sync pipeline where as async pipeline can process videos.

## Prerequisites

- Node.js
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-install.html)

## Setup

- Download this repo on your local machine
- Install [AWS Cloud Development Kit (CDK)](https://docs.aws.amazon.com/cdk/latest/guide/what-is.html): npm install -g aws-cdk
- Go to folder textract-pipeline and run: npm install

## Deployment
- Run "cdk bootstrap"
- Run "cdk deploy" to deploy stack

## Test incoming documents
- Go to the Amazon S3 bucket "textractpipeline-documentsbucketxxxx" created by the stack and upload few sample documents (jpg/jpeg, png, pdf).
- You will see output files generated for each document with a folder name "{filename}-analysis" (refresh Amazon S3 bucket to see these results).

## Test existing backfill documents
- Go to the Amazon S3 bucket "textractpipeline-existingdocumentsbucketxxxx" create by the stack and upload few sample documents (jpg/jpeg, png, pdf).
- Go to the Amazon S3 bucket "textractpipeline-inventoryandlogsxxxxx" and upload a csv file containing the list of document names you just uploaded to the bucket "textractpipeline-existingdocumentsbucketxxxx". CSV file should have two columns bucketName,objectName. See [example](./inventory-test.csv).
- You can instead use [Amazon S3 Inventory](https://docs.aws.amazon.com/AmazonS3/latest/dev/storage-inventory.html) to automatically generate a list of documents in your Amazon S3 bucket.
- Go to S3 in AWS Console and click on Batch Operations.
- Click on Create job, select CSV or S3 inventory report and click Next.
- Under Choose operation: select Invoke AWS Lambda function.
- Under Invoke AWS Lambda function: select "TextractPipeline-S3BatchProcessorxxxx" and click Next.
- Under path to completion report destination: browse and select Amazon S3 bucket "TextractPipeline-inventoryandlogsxxxxx".
- Under Permissions: for IAM role, select "TextractPipeline-S3BatchOperationRolexxxx" and click Next.
- Review and click Create job.
- From Amazon S3 Batch operations page, click on the Job ID link for the job you just created.
- Click "Confirm and run" and then "Run job".
- From S3 Batch operations page, click refresh to see the job status.
- Go to Amazon S3 bucket "textractpipeline-existingdocumentsbucketxxxx" and you should see output generated for documents in your list.

## Source code
- [s3batchproc.py](./src/s3batchproc.py) Lambda function that handles event from S3 Batch operation job.
- [s3proc.py](./src/s3proc.py) Lambda function that handles s3 event for an object creation.
- [docproc.py](./src/docproc.py) Lambda function that push documents to queues for sync or async pipelines.
- [syncproc.py](./src/syncproc.py) Lambda function that takes documents from a queue and process them using sync APIs.
- [asyncproc.py](./src/asyncproc.py) Lambda function that takes documents from a queue and start async Amazon Textract jobs.
- [jobresultsproc.py](./src/jobresultsproc.py) Lambda function that process results for a completed Amazon Textract async job.
- [textract-pipeline-stack.ts](./textract-pipeline/lib/textract-pipeline-stack.ts) CDK code to define infrastrucure including IAM roles, Lambda functions, SQS queues etc.

## Modify source code and update deployed stack
- You can edit lambda functions in src folder.
- Shared code is added as Lambda layers and automatically added  to different lambda functions.
- To test locally, update variables in the top of test.py with values corresponding to the resources created by your deployment.
- Copy updated lambda functions to appropriate folders: "sh build.sh".
- Deploy changes: "cdk deploy".
- Produce and view CloudFormation template if needed: "cdk synth".
- Produce and export CloudFormation template if needed: "cdk synth -o textractcf".

## Cost
- As you deploy this reference architecture, it creates different resources (Amazon S3 bucket, Amazon DynamoDB table, and AWS Lambda functions etc.). When you analyze documents, it calls different APIs (Amazon Textract) in your AWS account. You will get charged for all the API calls made as part of the analysis as well as any AWS resources created as part of the deployment. To avoid any recurring charges, delete stack using "cdk destroy".

## Delete stack
- Run: cdk destroy

## License

This library is licensed under the Apache 2.0 License. 
