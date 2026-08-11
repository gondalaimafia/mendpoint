const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

async function getItem(TableName, Key) {
  const result = await doc.send(new GetCommand({ TableName, Key }));
  return result.Item;
}

async function putItem(TableName, Item) {
  await doc.send(new PutCommand({ TableName, Item }));
}

async function queryItems(TableName, params) {
  return doc.send(new QueryCommand({ TableName, ...params }));
}

module.exports = { getItem, putItem, queryItems };
