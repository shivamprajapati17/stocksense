'use client';

import type { ReactNode } from 'react';

type Row = Record<string, unknown>;
type BoardView = 'products' | 'stock' | 'receipts' | 'deliveries' | 'transfers' | 'adjustments' | 'team' | 'warehouses' | 'categories' | 'suppliers';

const boardColumns: Record<BoardView, string[]> = {
  products: ['Active', 'Inactive'],
  stock: ['Out of stock', 'Low stock', 'Healthy'],
  receipts: ['Draft', 'Waiting', 'Done'],
  deliveries: ['Draft', 'Picking', 'Packed', 'Delivered'],
  transfers: ['Draft', 'Approved', 'Completed'],
  adjustments: ['Draft', 'Approved'],
  team: ['Admin', 'Manager', 'Staff'],
  warehouses: ['Active', 'Inactive'],
  categories: ['In use', 'Unused'],
  suppliers: ['Has receipts', 'No receipts'],
};

const label = (row: Row, key: string, fallback = ''): string => typeof row[key] === 'string' ? row[key] as string : fallback;
const child = (row: Row, key: string): Row => row[key] !== null && typeof row[key] === 'object' ? row[key] as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((entry): entry is Row => entry !== null && typeof entry === 'object') : [];
const number = (value: unknown): number => typeof value === 'number' ? value : Number(value || 0);

function columnFor(view: BoardView, row: Row): string {
  if (view === 'products') return row.isActive === true ? 'Active' : 'Inactive';
  if (view === 'stock') {
    const quantity = number(row.availableQuantity);
    const reorder = number(child(row, 'product').reorderLevel);
    return quantity <= 0 ? 'Out of stock' : quantity <= reorder ? 'Low stock' : 'Healthy';
  }
  if (view === 'team') return ['admin', 'manager', 'staff'].includes(label(row, 'role')) ? `${label(row, 'role')[0].toUpperCase()}${label(row, 'role').slice(1)}` : 'Staff';
  if (view === 'warehouses') return row.isActive === true ? 'Active' : 'Inactive';
  if (view === 'categories') return number(child(row, '_count').products) > 0 ? 'In use' : 'Unused';
  if (view === 'suppliers') return number(child(row, '_count').receipts) > 0 ? 'Has receipts' : 'No receipts';
  const status = label(row, 'status', 'draft').toLowerCase();
  return boardColumns[view].find((item) => item.toLowerCase() === status) ?? boardColumns[view][0];
}

function cardHeading(view: BoardView, row: Row): string {
  const names: Record<BoardView, string[]> = {
    products: ['name'], stock: [], receipts: ['receiptNumber'], deliveries: ['deliveryNumber'], transfers: ['transferNumber'], adjustments: ['adjustmentNumber'], team: [], warehouses: ['name'], categories: ['name'], suppliers: ['name'],
  };
  return names[view].map((key) => label(row, key)).find(Boolean) || label(child(row, 'product'), 'name') || label(row, 'email') || label(row, 'sku') || 'Inventory record';
}

function cardSubheading(view: BoardView, row: Row): string {
  if (view === 'products') return label(row, 'sku');
  if (view === 'stock') return `${label(child(row, 'product'), 'sku')} · ${label(child(row, 'warehouse'), 'name')}`;
  if (view === 'team') return label(row, 'email');
  if (view === 'transfers') return `${label(child(row, 'fromWarehouse'), 'name')} → ${label(child(row, 'toWarehouse'), 'name')}`;
  if (view === 'receipts') return label(child(row, 'supplier'), 'name', label(child(row, 'warehouse'), 'name'));
  if (view === 'deliveries' || view === 'adjustments') return label(child(row, 'warehouse'), 'name');
  return label(row, 'location', label(row, 'address', 'Workspace location'));
}

function cardMeta(view: BoardView, row: Row): string {
  if (view === 'stock') return `${number(row.availableQuantity).toLocaleString()} available`;
  if (view === 'products') {
    const units = rows(row.stockLevels).reduce((sum, stock) => sum + number(stock.availableQuantity), 0);
    return `${units.toLocaleString()} on hand · reorder at ${number(row.reorderLevel).toLocaleString()}`;
  }
  if (view === 'team') return label(row, 'status', 'active');
  if (view === 'categories') return label(row, 'description', `${number(child(row, '_count').products)} products`);
  if (view === 'suppliers') return label(row, 'email', label(row, 'phone'));
  const itemCount = rows(row.items).length;
  return itemCount ? `${itemCount} line${itemCount === 1 ? '' : 's'}` : '';
}

export function ResourceKanban({ view, rows: records, onSelect, actions }: { view: BoardView; rows: Row[]; onSelect: (row: Row) => void; actions?: (row: Row) => ReactNode }) {
  return <div className="resource-kanban" aria-label={`${view} kanban board`}>
    {boardColumns[view].map((column) => {
      const cards = records.filter((row) => columnFor(view, row) === column);
      return <section className="kanban-column" key={column} aria-label={`${column} (${cards.length})`}><header className="kanban-column-heading"><strong>{column}</strong><span>{cards.length}</span></header><div className="kanban-card-list">
        {cards.map((row) => <article className="kanban-card" key={label(row, 'id')}><button type="button" className="kanban-card-main" onClick={() => onSelect(row)}><strong>{cardHeading(view, row)}</strong><span>{cardSubheading(view, row)}</span><small>{cardMeta(view, row)}</small></button>{actions?.(row) && <div className="kanban-card-actions">{actions(row)}</div>}{view === 'team' && !actions && <div className="kanban-card-actions"><span className="role-label">View only</span></div>}</article>)}
        {!cards.length && <p className="kanban-empty">No records</p>}
      </div></section>;
    })}
  </div>;
}
