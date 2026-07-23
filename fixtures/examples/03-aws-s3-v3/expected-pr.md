## mendpoint: migrate AWS S3 — breaking (v3)

- Add `@aws-sdk/client-s3`; remove monolithic `aws-sdk` import
- `new AWS.S3` → `new S3Client`
- `getObject(...).promise()` → `client.send(new GetObjectCommand(...))`
- Stream `Body` via helper `streamToString`
