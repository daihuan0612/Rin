// Rin API - Shared API types and schemas
// Used by both client and server

// Types
export * from './types';

// Schemas for server-side validation
export * from './schemas';

// Schema validator
export { t } from './schema-validator';

// Media proxy whitelist (shared by client and server)
export { IMAGE_PROXY_HOSTS, isProxiedMediaHost } from './media-proxy';
