import { z } from 'zod';

/**
 * A frame on opencode's event stream: `{ type, data, ... }`. We validate only
 * the fields the translator reacts to and keep the rest as-is, so a server
 * upgrade that adds fields (or event types) cannot crash the loop.
 */
export const OpencodeFrameSchema = z.looseObject({
  type: z.string(),
  data: z.unknown().optional(),
});

export type OpencodeFrame = z.infer<typeof OpencodeFrameSchema>;
