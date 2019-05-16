import json

def S3BatchOperationsEvent(bucketArn, objectName):
    return {
        "job" : {
            "id" : "1"
        },
        "invocationId" : "1",
        "invocationSchemaVersion" : "1",
        "tasks" : [
            {
                "taskId" : "1",
                "s3Key" : objectName,
                "s3BucketArn" : bucketArn
            }
        ]
    }

def s3Event(bucketName, objectName):
    return {
        "Records" : [{
            "s3" : {
                "bucket" : {
                    "name" : bucketName
                },
                "object" : {
                    "key" : objectName
                }
            }
        }]
    }

def documentEvent(documentId, bucketName, objectName):
    return {
        "Records" : [{
            "eventName" : "INSERT",
            "dynamodb" : {
                'NewImage': {
                            'documentId': {'S': documentId},
                            'bucketName': {'S': bucketName},
                            'objectName': {'S': objectName},
                            'documentStatus': {'S': "IN_PROGRESS"}
                }
            }
        }]
    }

def syncQueueDocument(documentId, bucketName, objectName):
    
    body = {
            "documentId": documentId,
            "bucketName": bucketName,
            "objectName": objectName,
            "features" : ["Text", "Forms", "Tables"]
    }

    return {
        "Records" : [{
            "body" : json.dumps(body)
        }]
    }

def jobResultsEvent(jobId, jobTag, jobStatus, jobAPI, bucketName, objectName):
    
    message = {
        "JobId" : jobId,
        "JobTag" : jobTag,
        "Status" : jobStatus,
        "API" : jobAPI,
        "DocumentLocation" : {
            "S3Bucket" : bucketName,
            "S3ObjectName" : objectName
        }
    }

    body = {
         "Message" : json.dumps(message)
    }

    return {
        "Records" : [{
            "body" : json.dumps(body)
        }]
    }

def searchEvent(keyword):

    return {
        "resource" : "/search",
        "queryStringParameters" : {
            "k" : keyword
        }
    }

def createDocumentEvent(bucketName, objectName):
    
    return {
        "resource" : "/document",
        "queryStringParameters" : {
            "bucketname" : bucketName,
            "objectName" : objectName
        }
    }
    
def getDocumentEvent(documentId):

    return {
        "resource" : "/document",
        "queryStringParameters" : {
            "documentid" : documentId
        }
    }

def getDocumentsEvent():
    
    return {
        "resource" : "/documents"
    }

