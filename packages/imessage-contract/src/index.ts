/**
 * The wire contract between the calendar app and the iMessage bridge.
 *
 * Two processes with independent lifecycles need one shared, versioned
 * description of what they say to each other. This package is that description
 * and nothing else: it imports no other workspace package, so either side can
 * be rebuilt, restarted or extracted without dragging the other along.
 */
import { z } from 'zod';

/**
 * Bumped only when the wire format changes in a way an older client cannot
 * parse. Adding an optional field is not such a change.
 *
 * `GET /health` reports it; a client seeing a version it does not know must
 * degrade to "messaging unavailable" rather than guess.
 */
export const CONTRACT_VERSION = 1;

export const BRIDGE_ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTH_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UNSUPPORTED',
  'PROVIDER_ERROR',
  'INTERNAL_ERROR',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/** Mirrors the calendar app's own mapping so the client can reuse its handling. */
export const STATUS_BY_BRIDGE_ERROR: Record<BridgeErrorCode, number> = {
  VALIDATION_ERROR: 400,
  AUTH_ERROR: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNSUPPORTED: 503,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(BRIDGE_ERROR_CODES),
    message: z.string(),
  }),
});

// --- identity -------------------------------------------------------------

export const handleKindSchema = z.enum(['phone', 'email']);

/**
 * One way to reach a person. `value` is what Contacts stores (how a human typed
 * it); `normalized` is what iMessage uses and what anything downstream should
 * key on. Never compare on `value`.
 */
export const contactHandleSchema = z.object({
  kind: handleKindSchema,
  value: z.string(),
  normalized: z.string(),
  label: z.string().optional(),
});

export const contactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  handles: z.array(contactHandleSchema),
});

export const contactSearchResponseSchema = z.object({
  contacts: z.array(contactSchema),
  /** True when the result was cut off by `limit`; refine the query. */
  truncated: z.boolean(),
});

// --- threads --------------------------------------------------------------

/**
 * Conversation state without conversation content.
 *
 * Every deterministic follow-up rule is expressible over these timestamps, so
 * the ordinary path never moves message bodies across the socket. All times are
 * epoch milliseconds; `imsg` speaks ISO 8601 and the bridge converts once.
 */
export const threadStateSchema = z.object({
  /** The handle as asked for, echoed back. */
  handle: z.string(),
  normalized: z.string(),
  chatId: z.number().int(),
  service: z.string().optional(),
  /** Resolved by `imsg` from Contacts, when it has access. */
  contactName: z.string().optional(),
  lastMessageAt: z.number().int().optional(),
  lastInboundAt: z.number().int().optional(),
  lastOutboundAt: z.number().int().optional(),
});

export const threadDirectionSchema = z.enum(['inbound', 'outbound']);

export const threadMessageSchema = z.object({
  id: z.number().int(),
  at: z.number().int(),
  direction: threadDirectionSchema,
  text: z.string(),
  senderName: z.string().optional(),
});

/** The one endpoint that carries message text. Used only by the LLM path. */
export const threadMessagesResponseSchema = z.object({
  handle: z.string(),
  normalized: z.string(),
  chatId: z.number().int(),
  messages: z.array(threadMessageSchema),
});

// --- sending --------------------------------------------------------------

export const sendRequestSchema = z.object({
  /**
   * Required. Deduplicated against the audit log, so a client that retries a
   * request whose response it never saw gets the original result rather than
   * sending a second text.
   */
  idempotencyKey: z.string().min(1).max(200),
  to: z.string().min(1),
  text: z.string().min(1).max(2000),
  dryRun: z.boolean().optional(),
});

/**
 * `unconfirmed` is not a failure. `imsg` distinguishes "never started" from
 * "may have completed" and "still in flight"; only the first is safe to retry,
 * and collapsing the three into a boolean is how someone sends the same
 * question twice. `retrySafe` carries that decision explicitly so no caller has
 * to re-derive it.
 */
export const sendStatusSchema = z.enum([
  'sent',
  'unconfirmed',
  'failed',
  'blocked',
  'simulated',
  'duplicate',
]);

export const sendResultSchema = z.object({
  id: z.string(),
  status: sendStatusSchema,
  retrySafe: z.boolean(),
  at: z.number().int(),
  to: z.string(),
  reason: z.string().optional(),
});

// --- health ---------------------------------------------------------------

/**
 * Missing permissions are the normal state on a fresh machine, so they are
 * reported as data here rather than raised as errors. Contacts can be readable
 * while Messages is not; reading can work while sending does not.
 */
export const capabilitiesSchema = z.object({
  imsg: z.object({
    available: z.boolean(),
    version: z.string().optional(),
    detail: z.string().optional(),
  }),
  messages: z.object({
    readable: z.boolean(),
    sendable: z.boolean(),
    detail: z.string().optional(),
  }),
  contacts: z.object({
    readable: z.boolean(),
    count: z.number().int().optional(),
    detail: z.string().optional(),
  }),
  send: z.object({
    enabled: z.boolean(),
    remainingToday: z.number().int(),
  }),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  contractVersion: z.number().int(),
  capabilities: capabilitiesSchema,
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type HandleKind = z.infer<typeof handleKindSchema>;
export type ContactHandle = z.infer<typeof contactHandleSchema>;
export type BridgeContact = z.infer<typeof contactSchema>;
export type ContactSearchResponse = z.infer<typeof contactSearchResponseSchema>;
export type ThreadState = z.infer<typeof threadStateSchema>;
export type ThreadDirection = z.infer<typeof threadDirectionSchema>;
export type ThreadMessage = z.infer<typeof threadMessageSchema>;
export type ThreadMessagesResponse = z.infer<typeof threadMessagesResponseSchema>;
export type SendRequest = z.infer<typeof sendRequestSchema>;
export type SendStatus = z.infer<typeof sendStatusSchema>;
export type SendResult = z.infer<typeof sendResultSchema>;
export type BridgeCapabilities = z.infer<typeof capabilitiesSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
