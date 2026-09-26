import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getActor, requireRole } from '@/lib/auth';
import { auth, clerkClient, currentUser } from '@clerk/nextjs/server';
import { db } from '@/lib/db';

const roles = ['admin', 'manager', 'staff'] as const;
const itemSchema = z.object({ productId: z.string().uuid(), quantity: z.coerce.number().int().positive().max(1_000_000), unitPrice: z.coerce.number().nonnegative().optional(), notes: z.string().max(1000).optional() });
const docSchema = z.object({ warehouseId: z.string().uuid(), supplierId: z.string().uuid().optional().nullable(), purchaseOrderId: z.string().max(100).optional(), salesOrderId: z.string().max(100).optional(), notes: z.string().max(4000).optional(), expectedDeliveryDate: z.coerce.date().optional(), items: z.array(itemSchema).min(1).max(500) });
const uuid = z.string().uuid();
const asInt = (value: string | null, fallback: number, max: number) => Math.max(1, Math.min(max, Number(value) || fallback));
const makeNumber = (prefix: string) => `${prefix}-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
const idParam = (value?: string) => uuid.parse(value);
const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

async function audit(tx: Prisma.TransactionClient, actor: { organizationId: string; id: string }, action: string, entityType: string, entityId?: string, details?: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.id, action, entityType, entityId, details } });
}

async function ensureWarehouse(organizationId: string, warehouseId: string) {
  const warehouse = await db.warehouse.findFirst({ where: { id: warehouseId, organizationId, isActive: true } });
  if (!warehouse) throw new Error('WAREHOUSE_NOT_FOUND');
  return warehouse;
}

async function ensureProducts(organizationId: string, items: { productId: string }[]) {
  const ids = [...new Set(items.map((item) => item.productId))];
  const found = await db.product.findMany({ where: { organizationId, id: { in: ids }, isActive: true } });
  if (found.length !== ids.length) throw new Error('PRODUCT_NOT_FOUND');
  return found;
}

async function applyStock(tx: Prisma.TransactionClient, actor: { organizationId: string; id: string }, args: { productId: string; warehouseId: string; change: number; type: string; referenceType?: string; referenceId?: string; notes?: string }) {
  if (args.change < 0) {
    const changed = await tx.stockLevel.updateMany({ where: { productId: args.productId, warehouseId: args.warehouseId, availableQuantity: { gte: -args.change } }, data: { availableQuantity: { decrement: -args.change } } });
    if (!changed.count) throw new Error('INSUFFICIENT_STOCK');
  } else if (args.change > 0) {
    await tx.stockLevel.upsert({ where: { productId_warehouseId: { productId: args.productId, warehouseId: args.warehouseId } }, create: { productId: args.productId, warehouseId: args.warehouseId, availableQuantity: args.change }, update: { availableQuantity: { increment: args.change } } });
  } else {
    await tx.stockLevel.upsert({ where: { productId_warehouseId: { productId: args.productId, warehouseId: args.warehouseId } }, create: { productId: args.productId, warehouseId: args.warehouseId, availableQuantity: 0 }, update: {} });
  }
  const updated = await tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: args.productId, warehouseId: args.warehouseId } } });
  const after = updated.availableQuantity;
  await tx.stockLedger.create({ data: { organizationId: actor.organizationId, productId: args.productId, warehouseId: args.warehouseId, transactionType: args.type, referenceType: args.referenceType, referenceId: args.referenceId, quantityChange: args.change, beforeBalance: after - args.change, afterBalance: after, notes: args.notes, createdById: actor.id } });
}

async function listProducts(actor: Awaited<ReturnType<typeof getActor>>, request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const page = asInt(searchParams.get('page'), 1, 1_000_000), limit = asInt(searchParams.get('limit'), 50, 500);
  const q = searchParams.get('q')?.trim();
  const warehouseId = searchParams.get('warehouseId');
  if (warehouseId) await ensureWarehouse(actor.organizationId, idParam(warehouseId));
  const where: Prisma.ProductWhereInput = { organizationId: actor.organizationId, deletedAt: null, ...(searchParams.get('categoryId') ? { categoryId: searchParams.get('categoryId') } : {}), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}) };
  const [total, products] = await Promise.all([db.product.count({ where }), db.product.findMany({ where, include: { category: true, stockLevels: { where: warehouseId ? { warehouseId } : undefined, include: { warehouse: { select: { id: true, name: true } } } } }, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit })]);
  return json({ data: products, page, limit, total, pages: Math.ceil(total / limit) });
}

async function documentList(type: string, organizationId: string, request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const page = asInt(searchParams.get('page'), 1, 1_000_000), limit = asInt(searchParams.get('limit'), 50, 500);
  const status = searchParams.get('status');
  const where = { organizationId, ...(status ? { status } : {}), ...(searchParams.get('warehouseId') ? { warehouseId: searchParams.get('warehouseId')! } : {}) };
  if (type === 'receipts') { const [total, data] = await Promise.all([db.receipt.count({ where }), db.receipt.findMany({ where, include: { supplier: true, warehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit })]); return json({ data, page, limit, total }); }
  if (type === 'deliveries') { const [total, data] = await Promise.all([db.deliveryOrder.count({ where }), db.deliveryOrder.findMany({ where, include: { warehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit })]); return json({ data, page, limit, total }); }
  if (type === 'transfers') { const [total, data] = await Promise.all([db.internalTransfer.count({ where }), db.internalTransfer.findMany({ where, include: { fromWarehouse: true, toWarehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit })]); return json({ data, page, limit, total }); }
  const [total, data] = await Promise.all([db.stockAdjustment.count({ where }), db.stockAdjustment.findMany({ where, include: { warehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit })]); return json({ data, page, limit, total });
}

async function createDocument(type: string, actor: Awaited<ReturnType<typeof getActor>>, body: unknown) {
  if (type === 'transfers') {
    const input = z.object({ fromWarehouseId: uuid, toWarehouseId: uuid, notes: z.string().max(4000).optional(), items: z.array(itemSchema).min(1).max(500) }).parse(body);
    if (input.fromWarehouseId === input.toWarehouseId) throw new Error('TRANSFER_SAME_WAREHOUSE');
    await Promise.all([ensureWarehouse(actor.organizationId, input.fromWarehouseId), ensureWarehouse(actor.organizationId, input.toWarehouseId)]);
    await ensureProducts(actor.organizationId, input.items);
    return db.$transaction(async (tx) => {
      const transfer = await tx.internalTransfer.create({ data: { organizationId: actor.organizationId, transferNumber: makeNumber('TRF'), fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, createdById: actor.id, items: { create: input.items.map((item) => ({ productId: item.productId, quantity: item.quantity })) } }, include: { items: true, fromWarehouse: true, toWarehouse: true } });
      await audit(tx, actor, 'transfer.create', 'transfer', transfer.id);
      return transfer;
    });
  }
  if (type === 'adjustments') {
    const input = z.object({ warehouseId: uuid, notes: z.string().max(4000).optional(), adjustmentType: z.string().max(50).optional(), items: z.array(z.object({ productId: uuid, countedQuantity: z.coerce.number().int().nonnegative().max(1_000_000), reason: z.string().max(255).optional() })).min(1).max(500) }).parse(body);
    await ensureWarehouse(actor.organizationId, input.warehouseId);
    await ensureProducts(actor.organizationId, input.items);
    return db.$transaction(async (tx) => {
      const adjustment = await tx.stockAdjustment.create({ data: { organizationId: actor.organizationId, adjustmentNumber: makeNumber('ADJ'), warehouseId: input.warehouseId, notes: input.notes, adjustmentType: input.adjustmentType || 'count', createdById: actor.id, items: { create: await Promise.all(input.items.map(async (item) => { const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: item.productId, warehouseId: input.warehouseId } } }); return { productId: item.productId, recordedQuantity: level?.availableQuantity ?? 0, countedQuantity: item.countedQuantity, variance: item.countedQuantity - (level?.availableQuantity ?? 0), reason: item.reason }; })) } }, include: { items: true, warehouse: true } });
      await audit(tx, actor, 'adjustment.create', 'adjustment', adjustment.id);
      return adjustment;
    });
  }
  const input = docSchema.parse(body);
  await ensureWarehouse(actor.organizationId, input.warehouseId);
  await ensureProducts(actor.organizationId, input.items);
  if (input.supplierId && !(await db.supplier.findFirst({ where: { id: input.supplierId, organizationId: actor.organizationId } }))) throw new Error('SUPPLIER_NOT_FOUND');
  const items = input.items.map((item) => ({ productId: item.productId, quantityOrdered: item.quantity, ...(item.unitPrice !== undefined ? { unitPrice: item.unitPrice } : {}), notes: item.notes }));
  if (type === 'receipts') return db.$transaction(async (tx) => {
    const receipt = await tx.receipt.create({ data: { organizationId: actor.organizationId, receiptNumber: makeNumber('RCV'), warehouseId: input.warehouseId, supplierId: input.supplierId ?? null, purchaseOrderId: input.purchaseOrderId, notes: input.notes, createdById: actor.id, items: { create: items } }, include: { items: { include: { product: true } }, warehouse: true, supplier: true } });
    await audit(tx, actor, 'receipt.create', 'receipt', receipt.id);
    return receipt;
  });
  if (type === 'deliveries') return db.$transaction(async (tx) => {
    const delivery = await tx.deliveryOrder.create({ data: { organizationId: actor.organizationId, deliveryNumber: makeNumber('SHP'), warehouseId: input.warehouseId, salesOrderId: input.salesOrderId, expectedDeliveryDate: input.expectedDeliveryDate, notes: input.notes, createdById: actor.id, items: { create: items.map(({ productId, quantityOrdered, notes }) => ({ productId, quantityOrdered, notes })) } }, include: { items: { include: { product: true } }, warehouse: true } });
    await audit(tx, actor, 'delivery.create', 'delivery', delivery.id);
    return delivery;
  });
  throw new Error('UNSUPPORTED_DOCUMENT');
}

async function documentAction(type: string, id: string, operation: string, actor: Awaited<ReturnType<typeof getActor>>, body: Record<string, unknown>) {
  if (type === 'receipts') {
    const receipt = await db.receipt.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!receipt) throw new Error('DOCUMENT_NOT_FOUND');
    if (operation === 'confirm') {
      if (receipt.status !== 'draft' && receipt.status !== 'waiting') throw new Error('INVALID_TRANSITION');
      return db.$transaction(async (tx) => { const claimed = await tx.receipt.updateMany({ where: { id, organizationId: actor.organizationId, status: { in: ['draft', 'waiting'] } }, data: { status: 'done', receiptDate: new Date(), receivedById: actor.id } }); if (!claimed.count) throw new Error('INVALID_TRANSITION'); for (const item of receipt.items) await applyStock(tx, actor, { productId: item.productId, warehouseId: receipt.warehouseId, change: item.quantityReceived || item.quantityOrdered, type: 'receipt', referenceType: 'receipt', referenceId: receipt.id, notes: receipt.notes ?? undefined }); for (const item of receipt.items) await tx.receiptItem.update({ where: { id: item.id }, data: { quantityReceived: item.quantityReceived || item.quantityOrdered } }); const updated = await tx.receipt.findUniqueOrThrow({ where: { id } }); await audit(tx, actor, 'receipt.confirm', 'receipt', id); return updated; });
    }
    if (operation === 'delete') { if (receipt.status !== 'draft') throw new Error('ONLY_DRAFT_CAN_DELETE'); await db.receipt.delete({ where: { id } }); return { deleted: true }; }
    if (operation === 'update') { if (receipt.status !== 'draft') throw new Error('ONLY_DRAFT_CAN_EDIT'); return db.receipt.update({ where: { id }, data: { notes: typeof body.notes === 'string' ? body.notes.slice(0, 4000) : undefined, purchaseOrderId: typeof body.purchaseOrderId === 'string' ? body.purchaseOrderId.slice(0, 100) : undefined } }); }
    return receipt;
  }
  if (type === 'deliveries') {
    const delivery = await db.deliveryOrder.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!delivery) throw new Error('DOCUMENT_NOT_FOUND');
    if (operation === 'pick') { if (!['draft', 'picking'].includes(delivery.status)) throw new Error('INVALID_TRANSITION'); return db.$transaction(async (tx) => { for (const item of delivery.items) { const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: item.productId, warehouseId: delivery.warehouseId } } }); if ((level?.availableQuantity ?? 0) < item.quantityOrdered) throw new Error('INSUFFICIENT_STOCK'); } const updated = await tx.deliveryOrder.update({ where: { id }, data: { status: 'picking', items: { updateMany: { where: { deliveryOrderId: id }, data: { quantityPicked: { set: 0 } } } } } }); for (const item of delivery.items) await tx.deliveryItem.update({ where: { id: item.id }, data: { quantityPicked: item.quantityOrdered } }); await audit(tx, actor, 'delivery.pick', 'delivery', id); return updated; }); }
    if (operation === 'pack') { if (!['picking', 'packed'].includes(delivery.status)) throw new Error('INVALID_TRANSITION'); if (delivery.items.some((item) => item.quantityPicked < item.quantityOrdered)) throw new Error('ITEMS_NOT_PICKED'); const result = await db.deliveryOrder.update({ where: { id }, data: { status: 'packed' } }); await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.id, action: 'delivery.pack', entityType: 'delivery', entityId: id } }); return result; }
    if (operation === 'confirm') { if (delivery.status !== 'packed') throw new Error('INVALID_TRANSITION'); return db.$transaction(async (tx) => { const claimed = await tx.deliveryOrder.updateMany({ where: { id, organizationId: actor.organizationId, status: 'packed' }, data: { status: 'delivered', deliveredById: actor.id } }); if (!claimed.count) throw new Error('INVALID_TRANSITION'); for (const item of delivery.items) await applyStock(tx, actor, { productId: item.productId, warehouseId: delivery.warehouseId, change: -item.quantityOrdered, type: 'delivery', referenceType: 'delivery', referenceId: id, notes: delivery.notes ?? undefined }); for (const item of delivery.items) await tx.deliveryItem.update({ where: { id: item.id }, data: { quantityDelivered: item.quantityOrdered } }); await audit(tx, actor, 'delivery.confirm', 'delivery', id); return tx.deliveryOrder.findUniqueOrThrow({ where: { id } }); }); }
    if (operation === 'delete') { if (delivery.status !== 'draft') throw new Error('ONLY_DRAFT_CAN_DELETE'); await db.deliveryOrder.delete({ where: { id } }); return { deleted: true }; }
    if (operation === 'update' && delivery.status === 'draft') return db.deliveryOrder.update({ where: { id }, data: { notes: typeof body.notes === 'string' ? body.notes.slice(0, 4000) : undefined } });
    return delivery;
  }
  if (type === 'transfers') {
    const transfer = await db.internalTransfer.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!transfer) throw new Error('DOCUMENT_NOT_FOUND');
    if (operation === 'approve') { if (transfer.status !== 'draft') throw new Error('INVALID_TRANSITION'); const claimed = await db.internalTransfer.updateMany({ where: { id, organizationId: actor.organizationId, status: 'draft' }, data: { status: 'approved', approvedAt: new Date(), approvedById: actor.id } }); if (!claimed.count) throw new Error('INVALID_TRANSITION'); await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.id, action: 'transfer.approve', entityType: 'transfer', entityId: id } }); return db.internalTransfer.findUniqueOrThrow({ where: { id } }); }
    if (operation === 'confirm') { if (transfer.status !== 'approved') throw new Error('INVALID_TRANSITION'); return db.$transaction(async (tx) => { const claimed = await tx.internalTransfer.updateMany({ where: { id, organizationId: actor.organizationId, status: 'approved' }, data: { status: 'completed', completedAt: new Date(), completedById: actor.id } }); if (!claimed.count) throw new Error('INVALID_TRANSITION'); for (const item of transfer.items) { await applyStock(tx, actor, { productId: item.productId, warehouseId: transfer.fromWarehouseId, change: -item.quantity, type: 'transfer_out', referenceType: 'transfer', referenceId: id }); await applyStock(tx, actor, { productId: item.productId, warehouseId: transfer.toWarehouseId, change: item.quantity, type: 'transfer_in', referenceType: 'transfer', referenceId: id }); } await audit(tx, actor, 'transfer.confirm', 'transfer', id); return tx.internalTransfer.findUniqueOrThrow({ where: { id } }); }); }
    if (operation === 'delete' && transfer.status === 'draft') { await db.internalTransfer.delete({ where: { id } }); return { deleted: true }; }
    return transfer;
  }
  const adjustment = await db.stockAdjustment.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
  if (!adjustment) throw new Error('DOCUMENT_NOT_FOUND');
  if (operation === 'approve') { if (adjustment.status !== 'draft') throw new Error('INVALID_TRANSITION'); return db.$transaction(async (tx) => { const claimed = await tx.stockAdjustment.updateMany({ where: { id, organizationId: actor.organizationId, status: 'draft' }, data: { status: 'approved', approvedAt: new Date(), approvedById: actor.id } }); if (!claimed.count) throw new Error('INVALID_TRANSITION'); for (const item of adjustment.items) await applyStock(tx, actor, { productId: item.productId, warehouseId: adjustment.warehouseId, change: item.variance, type: 'adjustment', referenceType: 'adjustment', referenceId: id, notes: item.reason ?? adjustment.notes ?? undefined }); await audit(tx, actor, 'adjustment.approve', 'adjustment', id); return tx.stockAdjustment.findUniqueOrThrow({ where: { id } }); }); }
  if (operation === 'delete' && adjustment.status === 'draft') { await db.stockAdjustment.delete({ where: { id } }); return { deleted: true }; }
  return adjustment;
}

async function dashboard(organizationId: string, warehouseId?: string | null) {
  const stockWhere = { warehouse: { organizationId, ...(warehouseId ? { id: warehouseId } : {}) }, product: { organizationId, isActive: true, deletedAt: null } };
  const [products, stock, lowRows, out, receipts, deliveries, transfers, value, activity, warehouses, warehouseOptions] = await Promise.all([
    db.product.count({ where: { organizationId, isActive: true, deletedAt: null } }),
    db.stockLevel.aggregate({ where: stockWhere, _sum: { availableQuantity: true } }),
    db.stockLevel.findMany({ where: stockWhere, select: { availableQuantity: true, product: { select: { reorderLevel: true } } } }),
    db.stockLevel.count({ where: { ...stockWhere, availableQuantity: 0 } }),
    db.receipt.count({ where: { organizationId, status: { in: ['draft', 'waiting'] }, ...(warehouseId ? { warehouseId } : {}) } }),
    db.deliveryOrder.count({ where: { organizationId, status: { in: ['draft', 'picking', 'packed'] }, ...(warehouseId ? { warehouseId } : {}) } }),
    db.internalTransfer.count({ where: { organizationId, status: { in: ['draft', 'approved'] }, ...(warehouseId ? { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] } : {}) } }),
    db.stockLevel.findMany({ where: stockWhere, select: { availableQuantity: true, product: { select: { costPrice: true } } } }),
    db.stockLedger.findMany({ where: { organizationId, ...(warehouseId ? { warehouseId } : {}) }, include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 8 }),
    db.warehouse.count({ where: { organizationId, isActive: true } }),
    db.warehouse.findMany({ where: { organizationId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const low = lowRows.filter((row) => row.availableQuantity <= row.product.reorderLevel).length;
  const stockValue = value.reduce((sum, row) => sum + Number(row.product.costPrice) * row.availableQuantity, 0);
  return { products, unitsInStock: stock._sum.availableQuantity ?? 0, lowStock: low, outOfStock: out, pendingReceipts: receipts, pendingDeliveries: deliveries, pendingTransfers: transfers, stockValue, warehouses, warehouseOptions, recentActivity: activity };
}

async function acceptWorkspaceInvitation() {
  const session = await auth();
  if (!session.userId) return fail('Sign in is required.', 401);
  const clerkUser = await currentUser();
  if (!clerkUser) return fail('Sign in is required.', 401);
  const emailAddress = clerkUser.emailAddresses.find((address) => address.id === clerkUser.primaryEmailAddressId && address.verification?.status === 'verified') ?? clerkUser.emailAddresses.find((address) => address.verification?.status === 'verified');
  if (!emailAddress) return fail('A verified invited email address is required.', 403);
  const email = emailAddress.emailAddress.toLowerCase();
  const client = await clerkClient();
  const invitations = await client.invitations.getInvitationList({ query: email, limit: 100, offset: 0 });
  const invitation = invitations.data.find((entry) => {
    if (entry.emailAddress.toLowerCase() !== email || entry.status !== 'accepted') return false;
    const metadata = entry.publicMetadata ?? {};
    return typeof metadata.stocksenseOrganizationId === 'string' && (metadata.stocksenseRole === 'manager' || metadata.stocksenseRole === 'staff');
  });
  if (!invitation) return fail('No accepted StockSense invitation was found for this verified email. Reopen the invitation email, or ask the workspace admin to resend it.', 404);
  const organizationId = invitation.publicMetadata?.stocksenseOrganizationId;
  const role = invitation.publicMetadata?.stocksenseRole;
  if (typeof organizationId !== 'string' || (role !== 'manager' && role !== 'staff')) return fail('The invitation has invalid workspace details. Ask the workspace admin to resend it.', 403);
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
  if (!organization) return fail('The workspace for this invitation no longer exists.', 403);
  const existing = await db.user.findUnique({ where: { clerkId: session.userId }, select: { id: true, organizationId: true, role: true, status: true, deletedAt: true } });
  if (existing && existing.organizationId !== organization.id) return fail('This account already belongs to a different StockSense workspace.', 409);
  if (existing && (existing.status !== 'active' || existing.deletedAt)) return fail('This account has been disabled.', 403);
  const userMetadata = clerkUser.publicMetadata as Record<string, unknown>;
  await client.users.updateUserMetadata(session.userId, { publicMetadata: { ...userMetadata, stocksenseOrganizationId: organization.id, stocksenseRole: role } });
  if (existing && existing.role !== 'admin' && existing.role !== role) await db.user.update({ where: { id: existing.id }, data: { role } });
  const actor = await getActor();
  if (actor.organizationId !== organization.id) return fail('This account could not be joined to the invited workspace.', 409);
  if (!existing) await db.auditLog.create({ data: { organizationId: organization.id, userId: actor.id, action: 'user.invite.accept', entityType: 'invitation', entityId: invitation.id, details: { email, role } } });
  return json({ accepted: true, organizationId: organization.id, role: actor.role });
}

export async function dispatch(request: NextRequest) {
  try {
    const segments = request.nextUrl.pathname.split('/').filter(Boolean).slice(1);
    const [resource, rawId, action] = segments;
    if (resource === 'invitations' && rawId === 'accept' && request.method === 'POST') return await acceptWorkspaceInvitation();
    const actor = await getActor();
    const method = request.method;
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await request.json().catch(() => ({})) as Record<string, unknown> : {};

    if (resource === 'auth') {
      if (rawId === 'me' || rawId === 'user' || request.nextUrl.pathname.endsWith('/auth/user')) return json({ user: { id: actor.id, email: actor.email, firstName: actor.firstName, lastName: actor.lastName, role: actor.role }, organization: actor.organization, permissions: actor.role === 'admin' ? ['*'] : actor.role === 'manager' ? ['products:*', 'stock:*', 'receipts:*', 'deliveries:*', 'transfers:*', 'adjustments:*', 'reports:read', 'ledger:read', 'users:read'] : ['products:read', 'stock:read', 'receipts:read', 'receipts:create', 'deliveries:read', 'deliveries:create', 'ledger:read'] });
      if (rawId === 'logout' && method === 'POST') return json({ success: true, message: 'Use Clerk sign-out to end your session.' });
    }
    if (resource === 'dashboard') {
      const selectedWarehouse = request.nextUrl.searchParams.get('warehouseId');
      if (selectedWarehouse) await ensureWarehouse(actor.organizationId, idParam(selectedWarehouse));
      if (rawId === 'kpis' || rawId === 'summary' || !rawId) return json(await dashboard(actor.organizationId, selectedWarehouse));
    }
    if (resource === 'products') {
      if (method === 'GET' && !rawId) return listProducts(actor, request);
      if (method === 'POST' && !rawId) {
        if (actor.role === 'staff') throw new Error('FORBIDDEN');
        const input = z.object({ sku: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(255), description: z.string().max(4000).optional(), categoryId: uuid.optional().nullable(), unitOfMeasure: z.string().max(50).optional(), costPrice: z.coerce.number().nonnegative().optional(), sellingPrice: z.coerce.number().nonnegative().optional(), reorderLevel: z.coerce.number().int().nonnegative().optional(), reorderQuantity: z.coerce.number().int().positive().optional(), isActive: z.boolean().optional() }).parse(body);
        if (input.categoryId && !(await db.productCategory.findFirst({ where: { id: input.categoryId, organizationId: actor.organizationId } }))) return fail('Category not found in this organization.', 404);
        const product = await db.product.create({ data: { ...input, organizationId: actor.organizationId } });
        await audit(db, actor, 'product.create', 'product', product.id);
        return json(product, 201);
      }
      if (rawId) {
        const id = idParam(rawId);
        if (action === 'history' && method === 'GET') return json(await db.stockLedger.findMany({ where: { organizationId: actor.organizationId, productId: id }, include: { warehouse: true, createdBy: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }));
        if (method === 'GET') { const product = await db.product.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, include: { category: true, stockLevels: { include: { warehouse: true } } } }); return product ? json(product) : fail('Product not found.', 404); }
        if (method === 'PUT' || method === 'PATCH') { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const input = z.object({ sku: z.string().trim().min(1).max(100).optional(), name: z.string().trim().min(1).max(255).optional(), description: z.string().max(4000).nullable().optional(), categoryId: uuid.nullable().optional(), unitOfMeasure: z.string().max(50).optional(), costPrice: z.coerce.number().nonnegative().optional(), sellingPrice: z.coerce.number().nonnegative().optional(), reorderLevel: z.coerce.number().int().nonnegative().optional(), reorderQuantity: z.coerce.number().int().positive().optional(), isActive: z.boolean().optional() }).parse(body); const result = await db.product.updateMany({ where: { id, organizationId: actor.organizationId, deletedAt: null }, data: input }); if (!result.count) return fail('Product not found.', 404); return json(await db.product.findUnique({ where: { id } })); }
        if (method === 'DELETE') { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const result = await db.product.updateMany({ where: { id, organizationId: actor.organizationId }, data: { deletedAt: new Date(), isActive: false } }); return result.count ? json({ deleted: true }) : fail('Product not found.', 404); }
      }
    }
    if (resource === 'stock') {
      if (method === 'GET' && !rawId) { const query = request.nextUrl.searchParams.get('q')?.trim(); const where: Prisma.StockLevelWhereInput = { warehouse: { organizationId: actor.organizationId, ...(request.nextUrl.searchParams.get('warehouseId') ? { id: idParam(request.nextUrl.searchParams.get('warehouseId')!) } : {}) }, product: { organizationId: actor.organizationId, deletedAt: null, ...(request.nextUrl.searchParams.get('productId') ? { id: idParam(request.nextUrl.searchParams.get('productId')!) } : {}), ...(query ? { OR: [{ name: { contains: query, mode: 'insensitive' } }, { sku: { contains: query, mode: 'insensitive' } }] } : {}) } }; return json(await db.stockLevel.findMany({ where, include: { product: true, warehouse: true }, orderBy: [{ warehouse: { name: 'asc' } }, { product: { name: 'asc' } }] })); }
      if (method === 'GET' && rawId === 'location' && action) { await ensureWarehouse(actor.organizationId, idParam(action)); return json(await db.stockLevel.findMany({ where: { warehouseId: action, warehouse: { organizationId: actor.organizationId } }, include: { product: true, warehouse: true }, orderBy: { product: { name: 'asc' } } })); }
      if (method === 'GET' && rawId) { const productId = idParam(rawId); return json(await db.stockLevel.findMany({ where: { productId, product: { organizationId: actor.organizationId } }, include: { warehouse: true, product: true } })); }
    }
    if (resource === 'warehouses') {
      const q = request.nextUrl.searchParams.get('q')?.trim();
      const includeInactive = request.nextUrl.searchParams.get('includeInactive') === 'true';
      if (method === 'GET' && !rawId) return json(await db.warehouse.findMany({ where: { organizationId: actor.organizationId, ...(includeInactive ? {} : { isActive: true }), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { location: { contains: q, mode: 'insensitive' } }] } : {}) }, include: { _count: { select: { stockLevels: true } } }, orderBy: { name: 'asc' } }));
      if (method === 'POST' && !rawId) { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const input = z.object({ name: z.string().trim().min(1).max(255), location: z.string().max(255).optional(), address: z.string().max(2000).optional() }).parse(body); const current = await db.warehouse.count({ where: { organizationId: actor.organizationId, isActive: true } }); if (actor.organization.subscriptionTier === 'starter' && current >= actor.organization.maxWarehouses) return fail('Warehouse limit reached for this plan.', 409); const warehouse = await db.warehouse.create({ data: { ...input, organizationId: actor.organizationId } }); await audit(db, actor, 'warehouse.create', 'warehouse', warehouse.id); return json(warehouse, 201); }
      if (rawId) { const id = idParam(rawId); if (method === 'GET') { const warehouse = await db.warehouse.findFirst({ where: { id, organizationId: actor.organizationId }, include: { stockLevels: { include: { product: true } } } }); return warehouse ? json(warehouse) : fail('Warehouse not found.', 404); } if (method === 'PUT' || method === 'PATCH') { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const input = z.object({ name: z.string().trim().min(1).max(255).optional(), location: z.string().max(255).nullable().optional(), address: z.string().max(2000).nullable().optional(), isActive: z.boolean().optional() }).parse(body); const updated = await db.warehouse.updateMany({ where: { id, organizationId: actor.organizationId }, data: input }); return updated.count ? json(await db.warehouse.findUnique({ where: { id } })) : fail('Warehouse not found.', 404); } }
    }
    if (resource === 'categories') {
      const q = request.nextUrl.searchParams.get('q')?.trim();
      if (method === 'GET') return json(await db.productCategory.findMany({ where: { organizationId: actor.organizationId, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }, include: { _count: { select: { products: true } } }, orderBy: { name: 'asc' } }));
      if (method === 'POST') { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const input = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional() }).parse(body); const result = await db.productCategory.create({ data: { ...input, organizationId: actor.organizationId } }); await audit(db, actor, 'category.create', 'category', result.id); return json(result, 201); }
      if (rawId && (method === 'PUT' || method === 'PATCH')) { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const id = idParam(rawId); const input = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(1000).nullable().optional() }).parse(body); const updated = await db.productCategory.updateMany({ where: { id, organizationId: actor.organizationId }, data: input }); return updated.count ? json(await db.productCategory.findUnique({ where: { id } })) : fail('Category not found.', 404); }
      if (rawId && method === 'DELETE') { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const id = idParam(rawId); await db.product.updateMany({ where: { categoryId: id, organizationId: actor.organizationId }, data: { categoryId: null } }); const result = await db.productCategory.deleteMany({ where: { id, organizationId: actor.organizationId } }); return result.count ? json({ deleted: true }) : fail('Category not found.', 404); }
    }
    if (resource === 'suppliers') {
      const q = request.nextUrl.searchParams.get('q')?.trim();
      if (method === 'GET' && !rawId) return json(await db.supplier.findMany({ where: { organizationId: actor.organizationId, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}) }, include: { _count: { select: { receipts: true } } }, orderBy: { name: 'asc' } }));
      if (method === 'POST' && !rawId) { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const input = z.object({ name: z.string().trim().min(1).max(255), email: z.string().email().optional().or(z.literal('')), phone: z.string().max(30).optional(), address: z.string().max(2000).optional() }).parse(body); const supplier = await db.supplier.create({ data: { ...input, email: input.email || null, organizationId: actor.organizationId } }); await audit(db, actor, 'supplier.create', 'supplier', supplier.id); return json(supplier, 201); }
      if (rawId && (method === 'PUT' || method === 'PATCH')) { if (actor.role === 'staff') throw new Error('FORBIDDEN'); const id = idParam(rawId); const input = z.object({ name: z.string().trim().min(1).max(255).optional(), email: z.string().email().optional().or(z.literal('')).nullable(), phone: z.string().max(30).nullable().optional(), address: z.string().max(2000).nullable().optional() }).parse(body); const updated = await db.supplier.updateMany({ where: { id, organizationId: actor.organizationId }, data: { ...input, ...(input.email !== undefined ? { email: input.email || null } : {}) } }); return updated.count ? json(await db.supplier.findUnique({ where: { id } })) : fail('Supplier not found.', 404); }
    }
    if (['receipts', 'deliveries', 'transfers', 'adjustments'].includes(resource)) {
      if (method === 'GET' && !rawId) return documentList(resource, actor.organizationId, request);
      if (method === 'POST' && !rawId) { if (actor.role === 'staff' && ['transfers', 'adjustments'].includes(resource)) throw new Error('FORBIDDEN'); return json(await createDocument(resource, actor, body), 201); }
      if (rawId) {
        const id = idParam(rawId);
        if (method === 'GET' && !action) { const result = resource === 'receipts' ? await db.receipt.findFirst({ where: { id, organizationId: actor.organizationId }, include: { supplier: true, warehouse: true, items: { include: { product: true } } } }) : resource === 'deliveries' ? await db.deliveryOrder.findFirst({ where: { id, organizationId: actor.organizationId }, include: { warehouse: true, items: { include: { product: true } } } }) : resource === 'transfers' ? await db.internalTransfer.findFirst({ where: { id, organizationId: actor.organizationId }, include: { fromWarehouse: true, toWarehouse: true, items: { include: { product: true } } } }) : await db.stockAdjustment.findFirst({ where: { id, organizationId: actor.organizationId }, include: { warehouse: true, items: { include: { product: true } } } }); return result ? json(result) : fail('Document not found.', 404); }
        if (action === 'approve' && method === 'POST') await requireRole(['admin', 'manager']);
        if (['confirm', 'approve', 'pick', 'pack'].includes(action || '') && actor.role === 'staff' && (action === 'approve' || resource === 'transfers' || resource === 'adjustments')) throw new Error('FORBIDDEN');
        if (['confirm', 'approve', 'pick', 'pack'].includes(action || '') && method === 'POST') return json(await documentAction(resource, id, action!, actor, body));
        if ((method === 'PUT' || method === 'PATCH') && !action) return json(await documentAction(resource, id, 'update', actor, body));
        if (method === 'DELETE' && !action) return json(await documentAction(resource, id, 'delete', actor, body));
      }
    }
    if (resource === 'ledger' && method === 'GET') {
      const q = request.nextUrl.searchParams.get('q')?.trim();
      const where: Prisma.StockLedgerWhereInput = { organizationId: actor.organizationId, ...(request.nextUrl.searchParams.get('productId') ? { productId: idParam(request.nextUrl.searchParams.get('productId')!) } : {}), ...(request.nextUrl.searchParams.get('warehouseId') ? { warehouseId: idParam(request.nextUrl.searchParams.get('warehouseId')!) } : {}), ...(request.nextUrl.searchParams.get('type') ? { transactionType: request.nextUrl.searchParams.get('type')! } : {}), ...(request.nextUrl.searchParams.get('from') ? { createdAt: { gte: new Date(request.nextUrl.searchParams.get('from')!) } } : {}), ...(q ? { OR: [{ product: { name: { contains: q, mode: 'insensitive' } } }, { product: { sku: { contains: q, mode: 'insensitive' } } }, { transactionType: { contains: q, mode: 'insensitive' } }] } : {}) };
      const rows = await db.stockLedger.findMany({ where, include: { product: true, warehouse: true, createdBy: { select: { firstName: true, lastName: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 500 });
      if (rawId === 'export') { const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`; const csv = ['Date,Type,SKU,Product,Warehouse,Change,Before,After,User,Reference', ...rows.map((row) => [row.createdAt.toISOString(), row.transactionType, row.product.sku, row.product.name, row.warehouse.name, row.quantityChange, row.beforeBalance, row.afterBalance, row.createdBy?.email, row.referenceId].map(quote).join(','))].join('\r\n'); return new NextResponse(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="stocksense-ledger.csv"' } }); }
      return json({ data: rows, total: rows.length });
    }
    if (resource === 'reports' && method === 'GET') {
      const days = Math.max(1, Math.min(365, Number(request.nextUrl.searchParams.get('days')) || 30)); const since = new Date(Date.now() - days * 86400000);
      if (rawId === 'movements') { const entries = await db.stockLedger.findMany({ where: { organizationId: actor.organizationId, createdAt: { gte: since }, ...(request.nextUrl.searchParams.get('warehouseId') ? { warehouseId: idParam(request.nextUrl.searchParams.get('warehouseId')!) } : {}) }, select: { transactionType: true, quantityChange: true, createdAt: true }, orderBy: { createdAt: 'asc' } }); const buckets = new Map<string, { date: string; inbound: number; outbound: number; adjustments: number }>(); for (const entry of entries) { const key = entry.createdAt.toISOString().slice(0, 10); const bucket = buckets.get(key) ?? { date: key, inbound: 0, outbound: 0, adjustments: 0 }; if (entry.transactionType.includes('receipt') || entry.transactionType === 'transfer_in') bucket.inbound += entry.quantityChange; else if (entry.transactionType.includes('delivery') || entry.transactionType === 'transfer_out') bucket.outbound += Math.abs(entry.quantityChange); else bucket.adjustments += entry.quantityChange; buckets.set(key, bucket); } return json([...buckets.values()]); }
      if (rawId === 'variance') { const rows = await db.adjustmentItem.findMany({ where: { adjustment: { organizationId: actor.organizationId, status: 'approved', createdAt: { gte: since } } }, include: { product: true, adjustment: { include: { warehouse: true } } }, orderBy: { adjustment: { createdAt: 'desc' } } }); return json(rows); }
      if (rawId === 'aging') { const rows = await db.stockLevel.findMany({ where: { warehouse: { organizationId: actor.organizationId }, product: { organizationId: actor.organizationId, deletedAt: null }, availableQuantity: { gt: 0 } }, include: { product: true, warehouse: true } }); const enriched = await Promise.all(rows.map(async (row) => { const lastMovement = await db.stockLedger.findFirst({ where: { organizationId: actor.organizationId, productId: row.productId, warehouseId: row.warehouseId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }); return { productId: row.productId, sku: row.product.sku, product: row.product.name, warehouse: row.warehouse.name, quantity: row.availableQuantity, stockValue: Number(row.product.costPrice) * row.availableQuantity, lastMovementAt: lastMovement?.createdAt ?? null }; })); return json(enriched); }
      if (rawId === 'turnover') { const rows = await db.stockLedger.findMany({ where: { organizationId: actor.organizationId, createdAt: { gte: since }, transactionType: 'delivery' }, select: { productId: true, quantityChange: true } }); const totals = new Map<string, number>(); for (const row of rows) totals.set(row.productId, (totals.get(row.productId) ?? 0) + Math.abs(row.quantityChange)); const products = await db.product.findMany({ where: { organizationId: actor.organizationId, deletedAt: null, id: { in: [...totals.keys()] } }, select: { id: true, sku: true, name: true } }); return json(products.map((product) => ({ ...product, unitsDelivered: totals.get(product.id) ?? 0, periodDays: days }))); }
    }
    if (resource === 'users') {
      const q = request.nextUrl.searchParams.get('q')?.trim();
      if (method === 'GET' && !rawId) { await requireRole(['admin', 'manager']); return json(await db.user.findMany({ where: { organizationId: actor.organizationId, deletedAt: null, ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } : {}) }, select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true, createdAt: true }, orderBy: { createdAt: 'asc' } })); }
      if (method === 'POST' && !rawId) { await requireRole(['admin']); const input = z.object({ email: z.string().trim().email().max(255), role: z.enum(['manager', 'staff']).default('staff') }).parse(body); const normalizedEmail = input.email.toLowerCase(); const alreadyMember = await db.user.findFirst({ where: { organizationId: actor.organizationId, email: normalizedEmail, deletedAt: null } }); if (alreadyMember) return fail('This email already belongs to a workspace member.', 409); const otherWorkspaceMember = await db.user.findFirst({ where: { email: normalizedEmail, deletedAt: null, organizationId: { not: actor.organizationId } } }); if (otherWorkspaceMember) return fail('This account already belongs to a different StockSense workspace.', 409); const invite = await (await clerkClient()).invitations.createInvitation({ emailAddress: normalizedEmail, redirectUrl: new URL('/sign-up', request.nextUrl.origin).toString(), publicMetadata: { stocksenseOrganizationId: actor.organizationId, stocksenseRole: input.role }, notify: true, ignoreExisting: true }); await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.id, action: 'user.invite', entityType: 'invitation', entityId: invite.id, details: { email: normalizedEmail, role: input.role } } }); return json({ id: invite.id, email: invite.emailAddress, status: invite.status, role: input.role }, 201); }
      if (rawId && method === 'PUT' && !action) { await requireRole(['admin']); const id = idParam(rawId); const input = z.object({ firstName: z.string().trim().max(100).nullable().optional(), lastName: z.string().trim().max(100).nullable().optional(), role: z.enum(roles).optional() }).refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.').parse(body); if (id === actor.id && input.role && input.role !== actor.role) return fail('You cannot change your own role.', 409); const member = await db.user.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } }); if (!member) return fail('User not found.', 404); if (member.role === 'admin' && input.role && input.role !== 'admin' && await db.user.count({ where: { organizationId: actor.organizationId, role: 'admin', deletedAt: null, status: 'active' } }) <= 1) return fail('The last active admin cannot be demoted.', 409); const updates = { ...(input.firstName !== undefined ? { firstName: input.firstName || null } : {}), ...(input.lastName !== undefined ? { lastName: input.lastName || null } : {}), ...(input.role ? { role: input.role } : {}) }; if (!member.clerkId.startsWith('stocksense_demo_') && (input.firstName !== undefined || input.lastName !== undefined)) await (await clerkClient()).users.updateUser(member.clerkId, { ...(input.firstName !== undefined ? { firstName: input.firstName || undefined } : {}), ...(input.lastName !== undefined ? { lastName: input.lastName || undefined } : {}) }); const updated = await db.user.update({ where: { id }, data: updates, select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true, createdAt: true } }); await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.id, action: 'user.update', entityType: 'user', entityId: id, details: { ...(input.role ? { role: input.role } : {}), ...(input.firstName !== undefined || input.lastName !== undefined ? { nameUpdated: true } : {}) } } }); return json(updated); }
      if (rawId && action === 'role' && method === 'PUT') { await requireRole(['admin']); const input = z.object({ role: z.enum(roles) }).parse(body); const id = idParam(rawId); if (id === actor.id) return fail('You cannot change your own role.', 409); const member = await db.user.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } }); if (!member) return fail('User not found.', 404); if (member.role === 'admin' && input.role !== 'admin' && await db.user.count({ where: { organizationId: actor.organizationId, role: 'admin', deletedAt: null, status: 'active' } }) <= 1) return fail('The last active admin cannot be demoted.', 409); const result = await db.user.updateMany({ where: { id, organizationId: actor.organizationId, deletedAt: null }, data: { role: input.role } }); return result.count ? json({ success: true }) : fail('User not found.', 404); }
      if (rawId && method === 'DELETE') { await requireRole(['admin']); const id = idParam(rawId); if (id === actor.id) return fail('You cannot remove your own account.', 409); const member = await db.user.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } }); if (!member) return fail('User not found.', 404); if (member.role === 'admin' && await db.user.count({ where: { organizationId: actor.organizationId, role: 'admin', deletedAt: null, status: 'active' } }) <= 1) return fail('The last active admin cannot be disabled.', 409); const result = await db.user.updateMany({ where: { id, organizationId: actor.organizationId }, data: { status: 'disabled', deletedAt: new Date() } }); if (!result.count) return fail('User not found.', 404); if (!member.clerkId.startsWith('stocksense_demo_')) await (await clerkClient()).users.updateUserMetadata(member.clerkId, { publicMetadata: { stocksenseDisabled: true } }); await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.id, action: 'user.disable', entityType: 'user', entityId: id } }); return json({ success: true }); }
      if (rawId && method === 'GET') { await requireRole(['admin', 'manager']); const user = await db.user.findFirst({ where: { id: idParam(rawId), organizationId: actor.organizationId, deletedAt: null }, select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true, createdAt: true }, }); return user ? json(user) : fail('User not found.', 404); }
    }
    if (resource === 'audit' && method === 'GET') { await requireRole(['admin', 'manager']); const rows = await db.auditLog.findMany({ where: { organizationId: actor.organizationId }, include: { user: { select: { email: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }); return json(rows); }
    return fail('Route not found.', 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    if (message === 'UNAUTHENTICATED') return fail('Sign in is required.', 401);
    if (message === 'ACCOUNT_DISABLED') return fail('This account has been disabled.', 403);
    if (message === 'INVITED_WORKSPACE_NOT_FOUND') return fail('The workspace for this invitation no longer exists.', 403);
    if (message === 'FORBIDDEN') return fail('You do not have permission to perform this action.', 403);
    if (message === 'INSUFFICIENT_STOCK') return fail('Insufficient available stock for this operation.', 409);
    if (message === 'PRODUCT_NOT_FOUND') return fail('One or more products are unavailable in this organization.', 404);
    if (message === 'SUPPLIER_NOT_FOUND') return fail('Supplier not found in this organization.', 404);
    if (message === 'WAREHOUSE_NOT_FOUND') return fail('Warehouse not found in this organization.', 404);
    if (message === 'DOCUMENT_NOT_FOUND') return fail('Document not found.', 404);
    if (message === 'INVALID_TRANSITION') return fail('This document cannot make that status transition.', 409);
    if (message === 'ONLY_DRAFT_CAN_DELETE' || message === 'ONLY_DRAFT_CAN_EDIT' || message === 'ITEMS_NOT_PICKED' || message === 'TRANSFER_SAME_WAREHOUSE') return fail(message.replaceAll('_', ' ').toLowerCase(), 409);
    if (error instanceof z.ZodError) return fail(error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 422);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return fail('A record with that unique value already exists.', 409);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') return fail('This record is referenced by other data and cannot be removed.', 409);
    console.error('StockSense API error:', error);
    return fail('The request could not be completed. Please check your input and try again.', 500);
  }
}
