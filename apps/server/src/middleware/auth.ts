import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  userId: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express type augmentation requires a namespace.
  namespace Express {
    interface Request {
      user?: AuthUser;
      agentKeyId?: string;
    }
  }
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-secret-change-me';
}

function getJwtVerificationSecrets(): string[] {
  const primarySecret = getJwtSecret();
  const noosSecret = process.env.NOOS_JWT_SECRET;

  return noosSecret && noosSecret !== primarySecret
    ? [primarySecret, noosSecret]
    : [primarySecret];
}

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;

  const payload = value as Record<string, unknown>;
  return typeof payload.userId === 'string'
    && payload.userId.length > 0
    && typeof payload.email === 'string'
    && payload.email.length > 0;
}

export function validateToken(token: string): AuthUser | null {
  for (const secret of getJwtVerificationSecrets()) {
    try {
      const decoded = jwt.verify(token, secret);
      if (isAuthUser(decoded)) return decoded;
    } catch {
      // Try the next configured verification key.
    }
  }

  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const token = authHeader.slice(7);
  const user = validateToken(token);

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = user;
  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const user = validateToken(token);
    if (user) {
      req.user = user;
    }
  }

  next();
}
