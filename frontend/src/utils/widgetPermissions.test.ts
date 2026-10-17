import { describe, it, expect } from 'vitest';
import type { WidgetPermissions } from '../types/widget';
import { getDataActionPermission, hasPermission, permissionDenied } from './widgetPermissions';

describe('getDataActionPermission', () => {
  it('maps each data action to its required permission', () => {
    expect(getDataActionPermission('getProposals')).toBe('proposals');
    expect(getDataActionPermission('getVaultConfig')).toBe('vaultConfig');
  });

  it('returns null for unknown or non-string actions', () => {
    expect(getDataActionPermission('deleteEverything')).toBeNull();
    expect(getDataActionPermission('constructor')).toBeNull();
    expect(getDataActionPermission(undefined)).toBeNull();
    expect(getDataActionPermission({ action: 'getProposals' })).toBeNull();
  });
});

describe('hasPermission', () => {
  it('grants only permissions explicitly set to true', () => {
    const permissions: WidgetPermissions = { proposals: true, vaultConfig: false };
    expect(hasPermission(permissions, 'proposals')).toBe(true);
    expect(hasPermission(permissions, 'vaultConfig')).toBe(false);
    expect(hasPermission(permissions, 'events')).toBe(false);
  });

  it('does not treat truthy non-boolean values as granted', () => {
    const permissions = { proposals: 'yes' } as unknown as WidgetPermissions;
    expect(hasPermission(permissions, 'proposals')).toBe(false);
  });
});

describe('permissionDenied', () => {
  it('returns a typed permission_denied payload naming the permission', () => {
    expect(permissionDenied('proposals')).toEqual({ error: 'permission_denied', permission: 'proposals' });
  });
});
