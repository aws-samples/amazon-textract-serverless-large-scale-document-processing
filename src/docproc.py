import json
import os
from helper import FileHelper, AwsHelper

def postMessage(client, qUrl, jsonMessage):

    message = json.dumps(jsonMessage)

    client.send_message(
        QueueUrl=qUrl,
        MessageBody=message
    )

    print("Submitted message to queue: {}".format(message))

def processRequest(request):

    output = ""

    print("request: {}".format(request))

    documentId = request["documentId"]
    bucketName = request["bucketName"]
    objectName = request["objectName"]

    print("Input Object: {}/{}".format(bucketName, objectName))

    ext = FileHelper.getFileExtenstion(objectName.lower())
    print("Extension: {}".format(ext))

    if(ext and ext in ["jpg", "jpeg", "png"]):
        qUrl = request['syncQueueUrl']
    elif (ext in ["pdf"]):
        qUrl = request['asyncQueueUrl']

    if(qUrl):
        features = ["Text", "Forms", "Tables"]

        jsonMessage = { 'documentId' : documentId,
            "features" : features,
            'bucketName': bucketName,
            'objectName' : objectName }

        client = AwsHelper().getClient('sqs')
        postMessage(client, qUrl, jsonMessage)

    output = "Completed routing for documentId: {}, object: {}/{}".format(documentId, bucketName, objectName)

    print(output)

def processRecord(record, syncQueueUrl, asyncQueueUrl):
    
    newImage = record["dynamodb"]["NewImage"]
    
    documentId = None
    bucketName = None
    objectName = None
    documentStatus = None
    
    if("documentId" in newImage and "S" in newImage["documentId"]):
        documentId = newImage["documentId"]["S"]
    if("bucketName" in newImage and "S" in newImage["bucketName"]):
        bucketName = newImage["bucketName"]["S"]
    if("objectName" in newImage and "S" in newImage["objectName"]):
        objectName = newImage["objectName"]["S"]
    if("documentStatus" in newImage and "S" in newImage["documentStatus"]):
        documentStatus = newImage["documentStatus"]["S"]

    print("DocumentId: {}, BucketName: {}, ObjectName: {}, DocumentStatus: {}".format(documentId, bucketName, objectName, documentStatus))

    if(documentId and bucketName and objectName and documentStatus):
        request = {}
        request["documentId"] = documentId
        request["bucketName"] = bucketName
        request["objectName"] = objectName
        request['syncQueueUrl'] = syncQueueUrl
        request['asyncQueueUrl'] = asyncQueueUrl

        processRequest(request)

def lambda_handler(event, context):

    try:
        
        print("event: {}".format(event))

        syncQueueUrl = os.environ['SYNC_QUEUE_URL']
        asyncQueueUrl = os.environ['ASYNC_QUEUE_URL']

        if("Records" in event and event["Records"]):
            for record in event["Records"]:
                try:
                    print("Processing record: {}".format(record))

                    if("eventName" in record and record["eventName"] == "INSERT"):
                        if("dynamodb" in record and record["dynamodb"] and "NewImage" in record["dynamodb"]):
                            processRecord(record, syncQueueUrl, asyncQueueUrl)

                except Exception as e:
                    print("Faild to process record. Exception: {}".format(e))

    except Exception as e:
        print("Failed to process records. Exception: {}".format(e))