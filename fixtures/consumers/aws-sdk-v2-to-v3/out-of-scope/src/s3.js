import AWS from "aws-sdk";

// Unsupported service (SQS) outside the recipe's S3 / DocumentClient surface.
// Analysis must report this file as out-of-scope and abstain rather than
// producing a wrong edit.
const sqs = new AWS.SQS({ region: "us-east-1" });

export async function enqueue(QueueUrl, MessageBody) {
  return sqs.sendMessage({ QueueUrl, MessageBody }).promise();
}
