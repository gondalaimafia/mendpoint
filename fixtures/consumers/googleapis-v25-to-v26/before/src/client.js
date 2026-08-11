const google = require("googleapis");

async function listLabels(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.labels.list({ userId: "me" });
  return response.data.labels;
}

module.exports = { listLabels };
