import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "us-east-1" });

export async function readObject(Bucket, Key) {
  const data = await s3.send(new GetObjectCommand({ Bucket, Key }));
  return data.Body.toString();
}

export async function writeObject(Bucket, Key, Body) {
  await s3.send(new PutObjectCommand({ Bucket, Key, Body }));
}

export async function removeObject(Bucket, Key) {
  await s3.send(new DeleteObjectCommand({ Bucket, Key }));
}

export async function listObjects(Bucket) {
  return s3.send(new ListObjectsV2Command({ Bucket }));
}
