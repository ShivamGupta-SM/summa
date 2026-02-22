# Summa Kubernetes Operator

CRD-based declarative management for Summa Ledger deployments on Kubernetes.

## Status

**Phase: CRD Design Only** — The Custom Resource Definitions are ready. Controller implementation is future work. Current plain K8s manifests + HPA (`infrastructure/k8s/`) are production-ready and remain the recommended deployment method.

## Custom Resource Definitions

### SummaLedger (`summaledgers.summa.io`)

Manages the Summa server deployment — API pods, Service, Ingress, HPA, and schema migrations.

```yaml
apiVersion: summa.io/v1alpha1
kind: SummaLedger
metadata:
  name: my-ledger
  namespace: summa
spec:
  image: summa/server:1.0.0
  replicas: 3

  database:
    host: postgres.summa.svc.cluster.local
    port: 5432
    name: summa
    sslMode: require
    secretRef:
      name: summa-secrets      # must contain DATABASE_URL, SUMMA_HMAC_SECRET
    pool:
      maxConnections: 20
      minConnections: 5

  config:
    schema: summa
    currency: USD
    logLevel: info
    logFormat: json

  plugins:
    - name: outbox
    - name: hot-accounts
    - name: search
      config:
        typesenseHost: typesense.summa.svc.cluster.local
        typesenseApiKeySecret: summa-secrets
    - name: audit-log
      config:
        retentionDays: 90
    - name: batch-import
    - name: bank-reconciliation
    - name: api-keys
    - name: snapshots
    - name: reconciliation

  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilization: 70

  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 1Gi

  ingress:
    enabled: true
    className: nginx
    host: ledger.example.com
    tls:
      enabled: true
      clusterIssuer: letsencrypt-prod

  migration:
    autoRun: true
    strategy: push
```

### SummaWorker (`summaworkers.summa.io`)

Manages background worker pods for async processing (outbox delivery, hot account flushes, reconciliation, etc.).

```yaml
apiVersion: summa.io/v1alpha1
kind: SummaWorker
metadata:
  name: my-ledger-workers
  namespace: summa
spec:
  ledgerRef:
    name: my-ledger             # references the SummaLedger CR above

  replicas: 2

  workers:
    - id: "*"                   # run all workers from enabled plugins

  # Or be selective:
  # workers:
  #   - id: outbox-publisher
  #   - id: hot-account-processor
  #     intervalOverride: "2s"
  #   - id: search-indexer
  #   - id: daily-reconciliation
  #     intervalOverride: "1h"
  #   - id: scheduled-processor
  #   - id: batch-processor
  #   - id: bank-auto-matcher
  #     enabled: false           # temporarily disabled

  autoscaling:
    enabled: true
    minReplicas: 1
    maxReplicas: 5
    targetCPUUtilization: 70

  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 1Gi

  terminationGracePeriodSeconds: 60
```

## Installing the CRDs

```bash
kubectl apply -f infrastructure/operator/crds/
```

Verify:
```bash
kubectl get crd summaledgers.summa.io summaworkers.summa.io
```

## Expected Controller Behavior

When the controller is implemented, it should reconcile these CRDs into standard Kubernetes resources:

### SummaLedger Controller

1. **Deployment** — Create/update a Deployment for `summa-server` pods with the specified image, replicas, resources, env vars from `config` + `database.secretRef`
2. **Service** — Create a ClusterIP (or LoadBalancer/NodePort) Service
3. **Ingress** — If `ingress.enabled`, create an Ingress resource with TLS
4. **HPA** — If `autoscaling.enabled`, create an HPA targeting the Deployment
5. **Init Container** — If `migration.autoRun`, add an init container that runs `summa migrate push` before the server starts
6. **ConfigMap** — Generate a ConfigMap from `spec.config` fields + plugin list
7. **Status** — Update `.status.phase`, `.status.replicas`, `.status.migrationStatus`, `.status.enabledPlugins`

### SummaWorker Controller

1. **Deployment** — Create a Deployment running the same image in `SUMMA_MODE=worker` mode
2. **Env Injection** — Inherit database/secret config from the referenced SummaLedger CR
3. **Worker Config** — Pass `SUMMA_WORKERS` env var with comma-separated worker IDs (or `*` for all)
4. **Interval Overrides** — Pass `SUMMA_WORKER_<ID>_INTERVAL` env vars for per-worker overrides
5. **HPA** — If `autoscaling.enabled`, create an HPA
6. **Status** — Track active workers and their health via `.status.activeWorkers`

### Reconciliation Notes

- Controller should watch SummaLedger changes and propagate config to dependent SummaWorker deployments
- Use owner references so deleting a SummaLedger cascades to its workers
- Schema migrations should use a Job (not init container) for better failure handling in production
- Workers use distributed leases (`worker_lease` table) so multiple replicas are safe

## Available Workers Reference

Workers contributed by built-in plugins:

| Worker ID | Plugin | Description | Default Interval |
|-----------|--------|-------------|------------------|
| `outbox-publisher` | outbox | Publish pending outbox events | 5s |
| `outbox-gc` | outbox | Garbage-collect delivered outbox rows | 1h |
| `hot-account-processor` | hot-accounts | Flush pending hot account entries | 5s |
| `search-indexer` | search | Process search index queue | 5s |
| `batch-processor` | batch-import | Process posting batches | 10s |
| `bank-auto-matcher` | bank-reconciliation | Auto-match external transactions | 1m |
| `scheduled-processor` | scheduled-transactions | Execute due scheduled transactions | 30s |
| `statement-generator` | statements | Generate CSV/PDF statements | 30s |
| `audit-log-cleanup` | audit-log | Prune old audit entries | 1d |
| `data-retention-cleanup` | data-retention | Unified data retention cleanup | 1d |
| `version-retention-worker` | version-retention | Archive old balance versions | 1d |
| `freeze-expiry` | freeze-expiry | Auto-unfreeze expired accounts | 1m |
| `hash-snapshot-creator` | hash-snapshot | Create integrity hash snapshots | 1h |
| `daily-reconciliation` | reconciliation | Verify event store vs projections | 1d |
| `daily-snapshots` | snapshots | Create daily balance snapshots | 1d |
| `fx-quote-cleanup` | fx-engine | Expire old FX quotes | 1h |
| `budget-snapshot` | budgeting | Snapshot budget utilization | 1d |
| `approval-expiry` | approval-workflow | Expire timed-out approvals | 5m |
| `invoice-overdue-checker` | ar-ap | Mark overdue invoices + aging | 1h |
| `accrual-processor` | accrual-accounting | Process pending accruals | 1h |
| `gl-reconciliation` | gl-sub-ledger | Verify GL vs sub-ledger balances | 1d |
| `dlq-auto-retry` | dlq-manager | Retry failed DLQ entries | 5m |
| `api-key-cleanup` | api-keys | Remove expired API keys | 1d |
| `scheduled-backup` | backup | Run scheduled backups | cron |
| `velocity-log-cleanup` | velocity-limits | Prune old velocity logs | 1d |
| `batch-engine-shutdown` | batch-engine | Flush remaining batched transactions | shutdown |
