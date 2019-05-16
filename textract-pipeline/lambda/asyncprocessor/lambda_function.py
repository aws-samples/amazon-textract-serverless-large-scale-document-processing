import json
import boto3
import os
from helper import AwsHelper
import time

def startJob(bucketName, objectName, documentId, snsTopic, snsRole, detectForms, detectTables):

    print("Starting job with documentId: {}, bucketName: {}, objectName: {}".format(documentId, bucketName, objectName))

    response = None
    client = AwsHelper().getClient('textract')
    if(not detectForms and not detectTables):
        response = client.start_document_text_detection(
            ClientRequestToken  = documentId,
            DocumentLocation={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            NotificationChannel= {
              "RoleArn": snsRole,
              "SNSTopicArn": snsTopic
           },
           JobTag = documentId)
    else:
        features  = []
        if(detectTables):
            features.append("TABLES")
        if(detectForms):
            features.append("FORMS")

        response = client.start_document_analysis(
            ClientRequestToken  = documentId,
            DocumentLocation={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            FeatureTypes=features,
            NotificationChannel= {
                  "RoleArn": snsRole,
                  "SNSTopicArn": snsTopic
               },
            JobTag = documentId)

    return response["JobId"]


def processItem(message, snsTopic, snsRole):

    print('message:')
    print(message)

    messageBody = json.loads(message['Body'])

    bucketName = messageBody['bucketName']
    objectName = messageBody['objectName']
    documentId = messageBody['documentId']
    features = messageBody['features']

    print('Bucket Name: ' + bucketName)
    print('Object Name: ' + objectName)
    print('Task ID: ' + documentId)
    print("API: {}".format(features))

    print('starting Textract job...')

    detectForms = 'Forms' in features
    detectTables = 'Tables' in features

    jobId = startJob(bucketName, objectName, documentId, snsTopic, snsRole, detectForms, detectTables)

    if(jobId):
        print("Started Job with Id: {}".format(jobId))

    return jobId

def changeVisibility(sqs, qUrl, receipt_handle):
    try:
        sqs.change_message_visibility(
                QueueUrl=qUrl,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=0
            )
    except Exception as e:
        print("Failed to change visibility for {} with error: {}".format(receipt_handle, e))

def getMessagesFromQueue(sqs, qUrl,):
    # Receive message from SQS queue
    response = sqs.receive_message(
        QueueUrl=qUrl,
        MaxNumberOfMessages=1,
        VisibilityTimeout=60 #14400
    )

    print('SQS Response Recieved:')
    print(response)

    if('Messages' in response):
        return response['Messages']
    else:
        print("No messages in queue.")
        return None

def processItems(qUrl, snsTopic, snsRole):

    sqs = AwsHelper().getClient('sqs')
    messages = getMessagesFromQueue(sqs, qUrl)

    jc = 0
    totalMessages = 0
    hitLimit = False
    limitException = None

    if(messages):


        totalMessages = len(messages)
        print("Total messages: {}".format(totalMessages))

        for message in messages:
            receipt_handle = message['ReceiptHandle']

            try:
                if(hitLimit):
                    changeVisibility(sqs, qUrl, receipt_handle)
                else:
                    print("starting job...")
                    processItem(message, snsTopic, snsRole)
                    print("started job...")
                    print('Deleting item from queue...')
                    # Delete received message from queue
                    sqs.delete_message(
                        QueueUrl=qUrl,
                        ReceiptHandle=receipt_handle
                    )
                    print('Deleted item from queue...')
                    jc += 1
            except Exception as e:
                print("Error while starting job or deleting from queue: {}".format(e))
                changeVisibility(sqs, qUrl, receipt_handle)
                if(e.__class__.__name__ == 'LimitExceededException' 
                    or e.__class__.__name__ == "ProvisionedThroughputExceededException"):
                    hitLimit = True
                    limitException = e

        if(hitLimit):
            raise limitException

    return totalMessages, jc

def processRequest(request):

    qUrl = request['qUrl']
    snsTopic = request['snsTopic']
    snsRole = request['snsRole']

    i = 0
    max = 100

    totalJobsScheduled = 0

    hitLimit = False
    provisionedThroughputExceededCount = 0

    while(i < max):
        try:
            tc, jc = processItems(qUrl, snsTopic, snsRole)

            totalJobsScheduled += jc

            if(tc == 0):
                i = max

        except Exception as e:
            if(e.__class__.__name__ == 'LimitExceededException'):
                print("Exception: Hit limit.")
                hitLimit = True
                i = max
            elif(e.__class__.__name__ == "ProvisionedThroughputExceededException"):
                print("ProvisionedThroughputExceededException.")
                provisionedThroughputExceededCount += 1
                if(provisionedThroughputExceededCount > 5):
                    i = max
                else:
                    print("Waiting for few seconds...")
                    time.sleep(5)
                    print("Waking up...")

        i += 1

    output = "Started {} jobs.".format(totalJobsScheduled)
    if(hitLimit):
        output += " Hit limit."

    print(output)

    return {
        'statusCode': 200,
        'body': output
    }

def lambda_handler(event, context):

    print("event: {}".format(event))

    request = {}

    request["qUrl"] = os.environ['ASYNC_QUEUE_URL']
    request["snsTopic"] = os.environ['SNS_TOPIC_ARN']
    request["snsRole"] = os.environ['SNS_ROLE_ARN']

    return processRequest(request)
