# VPC reference deployment contract

Status: internal scaffold. This document and the executable contract do not
prove a customer deployment.

## Boundary

The enterprise topology places the web, API, worker, database, graph,
artifacts, and configuration inside one approved customer region. Ingress is
private and restricted to approved network ranges. Network policy denies all
other ingress and egress by default.

Outbound access is limited to three named paths: private SCM, private model
serving, and security updates. SCM and model endpoints must resolve through
private DNS and use HTTPS. Any additional destination requires a new reviewed
contract revision.

Customer data, backups, and customer managed encryption keys remain in the
declared region. Logs are exported only to the customer named destination with
an explicit retention period. Deployment automation binds an immutable
artifact digest, exact source revision, and distinct rollback revision.

## Readiness gate

`assessVpcDeployment` validates these controls and fails closed. A structurally
valid contract remains not ready until it retains both an approved cloud
account and region evidence reference and an approved enterprise network
evidence reference.

The scaffold does not provision cloud resources, approve a network, validate a
customer key, or prove private connectivity. Those acceptance events require
an approved cloud account, region, and enterprise network.
