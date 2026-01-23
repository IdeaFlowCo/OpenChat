import { Router, Request, Response } from 'express';

const router = Router();

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const rateLimitByIp = new Map<string, { count: number; resetAt: number }>();

const rateLimit = (req: Request, res: Response, next: () => void) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = rateLimitByIp.get(ip);

  if (!entry || entry.resetAt <= now) {
    rateLimitByIp.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    return;
  }

  next();
};

router.post('/', rateLimit, (req: Request, res: Response) => {
  const payload = req.body || {};
  const logEntry = {
    timestamp: payload.timestamp || new Date().toISOString(),
    source: 'frontend',
    level: payload.level || 'info',
    message: payload.message || 'Client log',
    error: payload.error || null,
    request: payload.request || null,
    context: payload.context || null,
    tags: payload.tags || null,
    meta: {
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null
    }
  };

  console.log(JSON.stringify(logEntry));
  res.json({ ok: true });
});

export default router;
