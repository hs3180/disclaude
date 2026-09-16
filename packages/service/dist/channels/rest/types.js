/**
 * Shared types for the REST channel subsystem (Issue #4127).
 *
 * Co-locating these here lets modules under channels/rest/ depend on a neutral
 * type home instead of back-importing from rest-channel.ts (the host class),
 * which would create a compile-time circular type dependency as more routes are
 * extracted. rest-channel.ts re-exports `IFileStorageService` for back-compat.
 *
 * @module service/channels/rest/types
 */
export {};
