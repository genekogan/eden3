// The deployed channel-secret resolver sidecar is plain Node (no build, no
// .d.ts). The real-path itest imports its engine to prove behavior against real
// Postgres; this ambient shim lets tsc resolve that import.
declare module '*/channel-secret-resolver/server.mjs';
