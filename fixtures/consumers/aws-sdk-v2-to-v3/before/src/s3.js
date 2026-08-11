import AWS from "aws-sdk";

const s3 = new AWS.S3({ region: "us-east-1" });

export async function readObject(Bucket, Key) {
  const data = await s3.getObject({ Bucket, Key }).promise();
  return data.Body.toString();
}

export async function writeObject(Bucket, Key, Body) {
  await s3.putObject({ Bucket, Key, Body }).promise();
}

export async function removeObject(Bucket, Key) {
  await s3.deleteObject({ Bucket, Key }).promise();
}

export async function listObjects(Bucket) {
  return s3.listObjectsV2({ Bucket }).promise();
}
