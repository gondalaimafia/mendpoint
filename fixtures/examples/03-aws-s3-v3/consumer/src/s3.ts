import AWS from "aws-sdk";

const s3 = new AWS.S3({ region: "us-east-1" });

export async function readObject(Bucket: string, Key: string): Promise<string> {
  const data = await s3.getObject({ Bucket, Key }).promise();
  const content = data.Body.toString();
  return content;
}

export async function readConfig() {
  return readObject(process.env.BUCKET!, "config.json");
}
