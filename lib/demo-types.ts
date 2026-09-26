export const DEMO_ROLES = ['admin', 'manager', 'staff'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];
