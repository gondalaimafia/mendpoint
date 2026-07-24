# Mixed content / SSL requirement for API base URL

Security review flagged that we call the payments API over plain HTTP. Production must use **SSL/TLS** — base URLs should be **https**, not http.

Please upgrade the API client base URL so all traffic to the vendor uses HTTPS.
