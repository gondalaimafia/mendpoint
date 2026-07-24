# 404 on create charge

Our payments integration started failing in production this morning.

Every create-charge call returns **HTTP 404 Not Found**. Downstream services log the path segment as `chargess` (double "s"). The correct REST resource for charges is the singular-ish collection name the vendor documents.

Please fix the client so charge creation hits the valid endpoint again. No other behavior should change.
