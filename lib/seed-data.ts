import { Prisma } from '@prisma/client';

const starterWarehouses = [
  { name: 'Main warehouse', location: 'Central', address: '100 Distribution Way' },
  { name: 'Northside depot', location: 'Northside', address: '24 Industrial Park' },
] as const;
const starterCategories = [
  { name: 'Raw materials', description: 'Materials used in production' },
  { name: 'Packaging', description: 'Boxes, labels, and shipping materials' },
  { name: 'Hardware', description: 'Fasteners and workshop supplies' },
] as const;
const starterProducts = [
  { sku: 'MAT-STEEL-01', name: 'Stainless steel rod', category: 'Raw materials', unitOfMeasure: 'pieces', costPrice: 18.5, sellingPrice: 29, reorderLevel: 20, reorderQuantity: 60, main: 84, north: 22 },
  { sku: 'MAT-ALUM-02', name: 'Aluminium sheet', category: 'Raw materials', unitOfMeasure: 'sheets', costPrice: 32, sellingPrice: 48, reorderLevel: 12, reorderQuantity: 30, main: 28, north: 8 },
  { sku: 'PKG-BOX-M', name: 'Shipping carton — medium', category: 'Packaging', unitOfMeasure: 'boxes', costPrice: 1.25, sellingPrice: 2.5, reorderLevel: 40, reorderQuantity: 120, main: 156, north: 42 },
  { sku: 'PKG-TAPE-01', name: 'Packing tape', category: 'Packaging', unitOfMeasure: 'rolls', costPrice: 2.1, sellingPrice: 4, reorderLevel: 24, reorderQuantity: 48, main: 18, north: 6 },
  { sku: 'HRD-BOLT-M8', name: 'Hex bolt M8 × 40 mm', category: 'Hardware', unitOfMeasure: 'pieces', costPrice: 0.16, sellingPrice: 0.4, reorderLevel: 150, reorderQuantity: 500, main: 720, north: 180 },
  { sku: 'HRD-GLOVE-L', name: 'Work gloves — large', category: 'Hardware', unitOfMeasure: 'pairs', costPrice: 4.8, sellingPrice: 8.5, reorderLevel: 16, reorderQuantity: 36, main: 0, north: 0 },
] as const;

export async function seedOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  const categories = new Map<string, string>();
  for (const category of starterCategories) {
    const record = await tx.productCategory.upsert({ where: { organizationId_name: { organizationId, name: category.name } }, create: { organizationId, ...category }, update: {} });
    categories.set(category.name, record.id);
  }
  const warehouses = new Map<string, string>();
  for (const warehouse of starterWarehouses) {
    const record = await tx.warehouse.upsert({ where: { organizationId_name: { organizationId, name: warehouse.name } }, create: { organizationId, ...warehouse }, update: {} });
    warehouses.set(warehouse.name, record.id);
  }
  for (const [name, email, phone] of [
    ['Acme Materials', 'orders@acme-materials.example', '+1 555 010 0420'],
    ['Box & Parcel Supply', 'sales@box-parcel.example', '+1 555 010 0872'],
  ]) {
    if (!(await tx.supplier.findFirst({ where: { organizationId, name } }))) await tx.supplier.create({ data: { organizationId, name, email, phone } });
  }
  for (const spec of starterProducts) {
    const product = await tx.product.upsert({
      where: { organizationId_sku: { organizationId, sku: spec.sku } },
      create: { organizationId, sku: spec.sku, name: spec.name, categoryId: categories.get(spec.category), unitOfMeasure: spec.unitOfMeasure, costPrice: spec.costPrice, sellingPrice: spec.sellingPrice, reorderLevel: spec.reorderLevel, reorderQuantity: spec.reorderQuantity },
      update: {},
    });
    for (const [warehouseName, quantity] of [[starterWarehouses[0].name, spec.main], [starterWarehouses[1].name, spec.north]] as const) {
      const warehouseId = warehouses.get(warehouseName)!;
      const existing = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: product.id, warehouseId } } });
      if (!existing) {
        await tx.stockLevel.create({ data: { productId: product.id, warehouseId, availableQuantity: quantity } });
        if (quantity > 0) await tx.stockLedger.create({ data: { organizationId, productId: product.id, warehouseId, transactionType: 'opening_stock', referenceType: 'seed', referenceId: `opening-${spec.sku}`, quantityChange: quantity, beforeBalance: 0, afterBalance: quantity, notes: 'Sample opening balance for local development' } });
      }
    }
  }
}
