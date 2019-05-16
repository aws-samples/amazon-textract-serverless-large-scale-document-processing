#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/cdk');
import { TextractPipelineStack } from '../lib/textract-pipeline-stack';

const app = new cdk.App();
new TextractPipelineStack(app, 'TextractPipeline');

