import {
  Duration,
  Stack,
  StackProps,
  aws_iam as iam,
  aws_ec2 as ec2,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_rds as rds,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";

interface DatabaseStackPops extends StackProps {
  vpc: ec2.IVpc;
}

export class DatabaseStack extends Stack {
  constructor(scope: Construct, id: string, props: DatabaseStackPops) {
    super(scope, id, props);

    const EXCLUDE_CHARACTERS = ":@/\" '";

    const dbClientSg = new ec2.SecurityGroup(this, "DbClientSg", {
      vpc: props.vpc,
      securityGroupName: "prd-db-client-sg",
      description: "",
      allowAllOutbound: true,
    });

    const rotateSecretsLambdaFunctionSg = new ec2.SecurityGroup(
      this,
      "RotateSecretsLambdaFunctionSg",
      {
        vpc: props.vpc,
        securityGroupName: "prd-rotate-secrets-lambda-sg",
        description: "",
        allowAllOutbound: true,
      }
    );

    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: props.vpc,
      securityGroupName: "prd-db-sg",
      description: "",
      allowAllOutbound: true,
    });
    dbSg.addIngressRule(
      ec2.Peer.securityGroupId(rotateSecretsLambdaFunctionSg.securityGroupId),
      ec2.Port.tcp(5432),
      "Allow DB access from Lambda functions that rotate Secrets"
    );
    dbSg.addIngressRule(
      ec2.Peer.securityGroupId(dbClientSg.securityGroupId),
      ec2.Port.tcp(5432),
      "Allow DB access from DB Client"
    );

    const dbAdminSecret = new secretsmanager.Secret(this, "DbAdminSecret", {
      secretName: "prd-db-cluster/AdminLoginInfo",
      generateSecretString: {
        excludeCharacters: EXCLUDE_CHARACTERS,
        generateStringKey: "password",
        passwordLength: 32,
        requireEachIncludedType: true,
        secretStringTemplate: '{"username": "postgresAdmin"}',
      },
    });

    const dbClusterParameterGroup = new rds.ParameterGroup(
      this,
      "DbClusterParameterGroup",
      {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_13_4,
        }),
        description: "aurora-postgresql13",
        parameters: {
          "pgaudit.log": "all",
          "pgaudit.role": "rds_pgaudit",
          shared_preload_libraries: "pgaudit",
          timezone: "Asia/Tokyo",
        },
      }
    );

    const dbParameterGroup = new rds.ParameterGroup(this, "DbParameterGroup", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_13_4,
      }),
      description: "aurora-postgresql13",
    });

    const subnetGroup = new rds.SubnetGroup(this, "SubnetGroup", {
      description: "description",
      vpc: props.vpc,
      subnetGroupName: "SubnetGroup",
      vpcSubnets: props.vpc.selectSubnets({
        onePerAz: true,
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    const dbCluster = new rds.DatabaseCluster(this, "DbCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_13_4,
      }),
      instanceProps: {
        vpc: props.vpc,
        allowMajorVersionUpgrade: false,
        autoMinorVersionUpgrade: true,
        deleteAutomatedBackups: false,
        enablePerformanceInsights: true,
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE3,
          ec2.InstanceSize.MEDIUM
        ),
        parameterGroup: dbParameterGroup,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
        publiclyAccessible: false,
        securityGroups: [dbSg],
      },
      backup: {
        retention: Duration.days(7),
        preferredWindow: "16:00-16:30",
      },
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_YEAR,
      clusterIdentifier: "prd-db-cluster",
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(dbAdminSecret),
      defaultDatabaseName: "testDB",
      deletionProtection: true,
      iamAuthentication: false,
      instanceIdentifierBase: "prd-db-instance",
      instances: 1,
      monitoringInterval: Duration.minutes(1),
      parameterGroup: dbClusterParameterGroup,
      preferredMaintenanceWindow: "Sat:17:00-Sat:17:30",
      storageEncrypted: true,
      subnetGroup,
    });

    new secretsmanager.SecretRotation(this, "DbAdminSecretRotation", {
      application:
        secretsmanager.SecretRotationApplication.POSTGRES_ROTATION_SINGLE_USER,
      secret: dbAdminSecret,
      target: dbCluster,
      vpc: props.vpc,
      automaticallyAfter: Duration.days(3),
      excludeCharacters: EXCLUDE_CHARACTERS,
      securityGroup: rotateSecretsLambdaFunctionSg,
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      }),
    });

    // DB Client IAM role
    const dbClientIamRole = new iam.Role(this, "DbClientIamRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
        new iam.ManagedPolicy(this, "GetSecretValueIamPolicy", {
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [dbAdminSecret.secretArn],
              actions: ["secretsmanager:GetSecretValue"],
            }),
          ],
        }),
      ],
    });

    // User data for Amazon Linux 2
    const userDataParameter = fs.readFileSync(
      "./src/ec2/user_data_amazon_linux2.sh",
      "utf8"
    );
    const userDataAmazonLinux2 = ec2.UserData.forLinux({
      shebang: "#!/bin/bash",
    });
    userDataAmazonLinux2.addCommands(userDataParameter);

    new ec2.Instance(this, "DbClient", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: props.vpc,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      role: dbClientIamRole,
      securityGroup: dbClientSg,
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      }),
      userData: userDataAmazonLinux2,
    });
  }
}
