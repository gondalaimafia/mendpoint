const AWS = require("aws-sdk");

const doc = new AWS.DynamoDB.DocumentClient({ region: "us-east-1" });

async function getItem(TableName, Key) {
  const result = await doc.get({ TableName, Key }).promise();
  return result.Item;
}

async function putItem(TableName, Item) {
  await doc.put({ TableName, Item }).promise();
}

async function queryItems(TableName, params) {
  return doc.query({ TableName, ...params }).promise();
}

module.exports = { getItem, putItem, queryItems };
