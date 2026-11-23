import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';
import { User } from '../models/types.js';
import { checkAccountEligibility } from '../services/accountService.js';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供身份凭证，请登录' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; username: string; sv?: number };
    const check = checkAccountEligibility(payload.id, payload.sv);

    if (!check.eligible) {
      const code =
        check.reason === 'not_found' || check.reason === 'session_revoked' ? 401 : 403;
      res.status(code).json({ error: check.message || '账号状态异常' });
      return;
    }

    req.user = check.user;
    next();
  } catch {
    res.status(401).json({ error: '登录状态已失效，请重新登录' });
    return;
  }
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '权限不足，仅管理员可访问' });
      return;
    }
    next();
  });
}
