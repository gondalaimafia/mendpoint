import AWS from "aws-sdk";

const s3 = new AWS.S3({ region: "us-west-2" });

export async function dumpKey(Bucket: string, Key: string) {
  const data = await s3.getObject({ Bucket, Key }).promise();
  return Buffer.from(data.Body).toString("base64");
}
