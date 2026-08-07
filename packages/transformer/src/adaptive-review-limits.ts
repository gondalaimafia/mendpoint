/**
 * One creation-time contract for adaptive candidates that require browser
 * review. These ceilings leave deterministic headroom below the 5 MiB web
 * proxy response cap even when every UTF-8 byte needs JSON escaping.
 */
export const MAX_ADAPTIVE_REVIEW_FILES = 100;
export const MAX_ADAPTIVE_REVIEW_FILE_BYTES = 256 * 1024;
export const MAX_ADAPTIVE_REVIEW_TOTAL_BYTES = 512 * 1024;
export const MAX_ADAPTIVE_SEAL_BYTES = 4 * 1024 * 1024;
