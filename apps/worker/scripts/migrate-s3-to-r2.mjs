#!/usr/bin/env node
/**
 * One-off media migration: AWS S3 -> Cloudflare R2.
 *
 * R2 exposes an S3-compatible API, so we stream every object from the source
 * S3 bucket into R2, preserving the exact key layout (folder/images|videos/...)
 * so existing media URLs only need their host swapped to R2_PUBLIC_BASE_URL.
 *
 * Prereqs (run from apps/worker):
 *   npm i -D @aws-sdk/client-s3
 *   export S3_BUCKET=... S3_REGION=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
 *   export R2_ACCOUNT_ID=... R2_BUCKET=tophunt-media R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
 *   node scripts/migrate-s3-to-r2.mjs
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const src = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const dst = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const SRC_BUCKET = process.env.S3_BUCKET;
const DST_BUCKET = process.env.R2_BUCKET;

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  let ContinuationToken;
  let copied = 0;
  do {
    const list = await src.send(
      new ListObjectsV2Command({ Bucket: SRC_BUCKET, ContinuationToken }),
    );
    for (const obj of list.Contents || []) {
      const got = await src.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: obj.Key }));
      const body = await streamToBuffer(got.Body);
      await dst.send(
        new PutObjectCommand({
          Bucket: DST_BUCKET,
          Key: obj.Key,
          Body: body,
          ContentType: got.ContentType,
        }),
      );
      copied++;
      if (copied % 50 === 0) console.log(`copied ${copied} objects...`);
    }
    ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (ContinuationToken);

  console.log(`Done. Copied ${copied} objects to R2 bucket "${DST_BUCKET}".`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
