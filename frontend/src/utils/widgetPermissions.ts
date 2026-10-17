import type { WidgetPermissions } from '../types/widget';

export type WidgetPermissionKey = keyof WidgetPermissions;

export interface PermissionDeniedResponse {
  error: 'permission_denied';
  permission: WidgetPermissionKey;
}

/** Returns a typed denial payload for the widget bridge. */
export function permissionDenied(permission: WidgetPermissionKey): PermissionDeniedResponse {
  return { error: 'permission_denied', permission };
}

/** Maps each data request the sandbox answers to the permission it requires. */
const DATA_ACTION_PERMISSIONS: Record<string, WidgetPermissionKey> = {
  getProposals: 'proposals',
  getVaultConfig: 'vaultConfig',
};

/** Returns the permission required for a `data` message, or null if the action is unknown. */
export function getDataActionPermission(action: unknown): WidgetPermissionKey | null {
  if (typeof action !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(DATA_ACTION_PERMISSIONS, action)
    ? DATA_ACTION_PERMISSIONS[action]
    : null;
}

export function hasPermission(permissions: WidgetPermissions, key: WidgetPermissionKey): boolean {
  return permissions[key] === true;
}
