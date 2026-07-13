import { describe, it, expect, vi } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, requirePermission } from '../server/infrastructure/rbac.js';

describe('rbac', () => {
  it('user role can read flags/jobs/ops but cannot write flags or run jobs', () => {
    expect(hasPermission('user', PERMISSIONS.FLAGS_READ)).toBe(true);
    expect(hasPermission('user', PERMISSIONS.FLAGS_WRITE)).toBe(false);
    expect(hasPermission('user', PERMISSIONS.JOBS_RUN)).toBe(false);
    expect(hasPermission('user', PERMISSIONS.FLAGS_KILL_SWITCH)).toBe(false);
  });

  it('operator can write flags and run jobs, but cannot touch the kill switch', () => {
    expect(hasPermission('operator', PERMISSIONS.FLAGS_WRITE)).toBe(true);
    expect(hasPermission('operator', PERMISSIONS.JOBS_RUN)).toBe(true);
    expect(hasPermission('operator', PERMISSIONS.FLAGS_KILL_SWITCH)).toBe(false);
  });

  it('admin has every permission, including the kill switch', () => {
    for (const perm of Object.values(PERMISSIONS)) {
      expect(hasPermission('admin', perm)).toBe(true);
    }
  });

  it('fails closed to user-level permissions for an unknown/missing role', () => {
    expect(hasPermission('some-made-up-role', PERMISSIONS.FLAGS_WRITE)).toBe(false);
    expect(hasPermission(undefined, PERMISSIONS.FLAGS_READ)).toBe(true); // read is a user permission
    expect(hasPermission(undefined, PERMISSIONS.FLAGS_KILL_SWITCH)).toBe(false);
  });

  it('the permission hierarchy is strictly additive: operator ⊇ user, admin ⊇ operator', () => {
    for (const perm of ROLE_PERMISSIONS.user) expect(ROLE_PERMISSIONS.operator).toContain(perm);
    for (const perm of ROLE_PERMISSIONS.operator) expect(ROLE_PERMISSIONS.admin).toContain(perm);
  });

  describe('requirePermission middleware', () => {
    function mockRes() {
      const res = {};
      res.status = vi.fn(() => res);
      res.json = vi.fn(() => res);
      return res;
    }

    it('returns 401 when there is no authenticated user', () => {
      const req = {};
      const res = mockRes();
      const next = vi.fn();
      requirePermission(PERMISSIONS.FLAGS_READ)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 with INSUFFICIENT_PERMISSION when the role lacks the permission', () => {
      const req = { user: { role: 'user' } };
      const res = mockRes();
      const next = vi.fn();
      requirePermission(PERMISSIONS.FLAGS_KILL_SWITCH)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSION' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when the role has the required permission', () => {
      const req = { user: { role: 'admin' } };
      const res = mockRes();
      const next = vi.fn();
      requirePermission(PERMISSIONS.FLAGS_KILL_SWITCH)(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('treats a missing role on req.user as "user" (fails closed, does not throw)', () => {
      const req = { user: {} };
      const res = mockRes();
      const next = vi.fn();
      requirePermission(PERMISSIONS.FLAGS_WRITE)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
