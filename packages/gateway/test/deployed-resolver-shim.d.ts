// The deployed channel-secret resolver sidecar is plain Node (no build step,
// no .d.ts). The agreement test imports it to pin its runtime behavior against
// the typed gateway module; this ambient shim lets tsc resolve that import.
declare module '*/channel-secret-resolver/server.mjs';
