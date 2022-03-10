#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";

const app = new cdk.App();
const vpcStack = new VpcStack(app, "VpcStack", {
  terminationProtection: true,
});
const databaseStack = new DatabaseStack(app, "DatabaseStack", {
  vpc: vpcStack.vpc,
  terminationProtection: true,
});

cdk.Tags.of(vpcStack).add("Environment", "Production");
cdk.Tags.of(databaseStack).add("Environment", "Production");
