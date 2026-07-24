# Double-charge risk on create payment

Support reports customers charged twice when the client retries after a timeout. Our create-payment **POST** does not send an **Idempotency-Key** header.

Please add idempotency so retries cannot double-charge. Use a stable or random idempotency key per request as appropriate for the vendor.
