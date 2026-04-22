import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    instanceId?: string;
  }
}

/** Verifies the `Authorization: Bearer <jwt>` header. Rejects with 401 if
 *  the token is missing, malformed, expired, or forged. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'missing_token' });
  }
  const token = header.slice('Bearer '.length).trim();
  const claims = await verifyAccessToken(token);
  if (!claims) return reply.code(401).send({ error: 'invalid_token' });
  req.userId = claims.sub;
  req.instanceId = claims.iid;
}
