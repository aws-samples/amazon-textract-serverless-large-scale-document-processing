import boto3
from decimal import Decimal
import json
import os
from helper import AwsHelper, S3Helper, DynamoDBHelper
from og import OutputGenerator
import datastore

def callTextract(bucketName, objectName, detectText, detectForms, detectTables):
    textract = AwsHelper().getClient('textract')
    if(not detectForms and not detectTables):
        response = textract.detect_document_text(
            Document={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    else:
        features  = []
        if(detectTables):
            features.append("TABLES")
        if(detectForms):
            features.append("FORMS")
        
        response = textract.analyze_document(
            Document={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            FeatureTypes=features
        )

    return response


def processImage(documentId, features, bucketName, objectName, outputTableName, documentsTableName):

    detectText = "Text" in features
    detectForms = "Forms" in features
    detectTables = "Tables" in features

    response = callTextract(bucketName, objectName, detectText, detectForms, detectTables)

    dynamodb = AwsHelper().getResource("dynamodb")
    ddb = dynamodb.Table(outputTableName)

    print("Generating output for DocumentId: {}".format(documentId))

    opg = OutputGenerator(documentId, response, bucketName, objectName, detectForms, detectTables, ddb)
    opg.run()

    print("DocumentId: {}".format(documentId))

    ds = datastore.DocumentStore(documentsTableName, outputTableName)
    ds.markDocumentComplete(documentId)

# --------------- Main handler ------------------

def processRequest(request):

    output = ""

    print("request: {}".format(request))

    bucketName = request['bucketName']
    objectName = request['objectName']
    features = request['features']
    documentId = request['documentId']
    outputTable = request['outputTable']
    documentsTable = request['documentsTable']
    documentsTable = request["documentsTable"]
    
    if(documentId and bucketName and objectName and features):
        print("DocumentId: {}, features: {}, Object: {}/{}".format(documentId, features, bucketName, objectName))

        processImage(documentId, features, bucketName, objectName, outputTable, documentsTable)

        output = "Document: {}, features: {}, Object: {}/{} processed.".format(documentId, features, bucketName, objectName)
        print(output)

    return {
        'statusCode': 200,
        'body': output
    }

def lambda_handler(event, context):

    print("event: {}".format(event))
    message = json.loads(event['Records'][0]['body'])
    print("Message: {}".format(message))

    request = {}
    request["documentId"] = message['documentId']
    request["bucketName"] = message['bucketName']
    request["objectName"] = message['objectName']
    request["features"] = message['features']    
    request["outputTable"] = os.environ['OUTPUT_TABLE']
    request["documentsTable"] = os.environ['DOCUMENTS_TABLE']

    return processRequest(request)