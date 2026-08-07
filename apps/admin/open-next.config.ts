import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal OpenNext config for deploying the admin panel to Cloudflare Workers.
// Incremental cache / R2 / queues can be wired in later if ISR is needed.
export default defineCloudflareConfig();
