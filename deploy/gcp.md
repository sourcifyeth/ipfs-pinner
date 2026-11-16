# Deploy on Google Cloud

Replace the values in capitals. Use the region of the Cloud SQL instance, so
that the database traffic has no network cost.

```bash
PROJECT=sourcify-project
REGION=REGION_OF_CLOUD_SQL
IMAGE=$REGION-docker.pkg.dev/$PROJECT/REPOSITORY/ipfs-pinner:latest
SQL=PROJECT:REGION:INSTANCE
COMMON="--image=$IMAGE --region=$REGION --service-account=ipfs-pinner@$PROJECT.iam.gserviceaccount.com \
  --set-cloudsql-instances=$SQL \
  --set-env-vars=PGHOST=/cloudsql/$SQL,PGDATABASE=sourcify,PGUSER=ipfs_pinner,STATE_BUCKET=sourcify-ipfs-pinner-state \
  --set-secrets=PGPASSWORD=ipfs-pinner-db-password:latest,LIGHTHOUSE_API_KEY=lighthouse-api-key:latest \
  --memory=1Gi --max-retries=1"

# State bucket. The service account needs roles/storage.objectAdmin on it,
# roles/cloudsql.client on the project, and access to the two secrets.
gcloud storage buckets create gs://sourcify-ipfs-pinner-state --location=$REGION

# Hourly job. A run with no new rows makes two small queries and stops.
gcloud run jobs create ipfs-pinner $COMMON --task-timeout=50m \
  --update-env-vars=MODE=incremental,MAX_RUN_MINUTES=45
gcloud scheduler jobs create http ipfs-pinner-hourly --location=$REGION --schedule="7 * * * *" \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/ipfs-pinner:run" \
  --http-method=POST --oauth-service-account-email=ipfs-pinner@$PROJECT.iam.gserviceaccount.com

# Backfill job. Start it by hand. It continues where it stopped.
gcloud run jobs create ipfs-pinner-backfill $COMMON --task-timeout=24h \
  --update-env-vars=MODE=backfill,MAX_BYTES_PER_SECOND=4000000,MAX_RUN_MINUTES=1380
gcloud run jobs execute ipfs-pinner-backfill --region=$REGION
```

## Order

1. Run the hourly job once. The first run only sets its cursor to the present.
2. Start the backfill job. It covers every row that exists at that time.
3. Rows that arrive during the backfill are covered by the hourly job. A row
   can be uploaded by both jobs. That is harmless.

The backfill reads 201 GB of text (November 2026). At 4 MB per second this
takes about 14 hours. Watch the CPU and the disk read charts of Cloud SQL in
the first hour. To slow down, lower `MAX_BYTES_PER_SECOND` and start the job
again.

`/tmp` in Cloud Run is in memory. The job holds one CAR file there
(`CAR_MAX_BYTES`, default 128 MB), so 1 GiB of memory is enough.

## Alerts

Both jobs exit with a non-zero code on any error. Create one Cloud Monitoring
alert policy on failed executions of Cloud Run jobs
(metric `run.googleapis.com/job/completed_execution_count`, label `result=failed`).
