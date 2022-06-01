#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TextractPipelineStack } from '../lib/textract-pipeline-stack';

const app = new cdk.App();
new TextractPipelineStack(app, 'TextractPipelineStack');
