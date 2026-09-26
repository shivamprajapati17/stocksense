# StockSense

A multi-warehouse inventory operations app built with Next.js, Clerk, and PostgreSQL. Application records—organizations, user profiles/roles, catalog data, stock, documents, ledger, and audit events—live in PostgreSQL. Clerk provides email sign-in, sign-up, sessions, and password reset for regular accounts.

## Run locally

Requirements: Node.js 20+, npm, and Docker Desktop.

1. Create `.env.local` from `.env.example` and add Clerk development keys for regular Clerk sign-in.
2. Start PostgreSQL, install dependencies, and prepare tables:

   ```bash
   docker compose up -d
   npm install
   npm run db:generate
   npm run db:push
   ```

3. Start the local role demo:

   ```bash
   npm run dev:demo
   ```

   By default this runs on port 3002 with its own build cache. Set `STOCKSENSE_DEMO_PORT=3003` if needed. For Clerk-only development, use `npm run dev`.

Open [http://localhost:3002/sign-in](http://localhost:3002/sign-in). The demo server shows Admin, Manager, and Staff local role buttons beneath the Clerk form. Choose a role; demo profiles and optional sample inventory are stored in local SQL. No Clerk keys are required for demo roles.

| Role | Local demo identity | Access |
|---|---|---|
| Admin | `admin@stocksense.local` (`stocksense_demo_admin`) | Full workspace management |
| Manager | `manager@stocksense.local` (`stocksense_demo_manager`) | Inventory operations and approvals; no user administration |
| Staff | `staff@stocksense.local` (`stocksense_demo_staff`) | Day-to-day receipts/deliveries and read access |

These are demo identities, not email/password credentials. Demo mode is limited to development and enabled only by the `npm run dev:demo` launcher. The sidebar allows role switching or exiting the demo. `SEED_DEMO_DATA=true` in development seeds two warehouses, three categories, six products, two suppliers, and opening stock idempotently.

Do not expose the local database credentials beyond your machine; change the starter password and connection string before any shared deployment. Never commit `.env.local` or production credentials. Regular sign-in, sign-up, password reset, and invitation links are provided by Clerk.

## Application

All business API routes require a Clerk session or valid development demo session. Access is scoped to the authenticated SQL organization and checked on the server. A first regular account creates a workspace admin profile. Team invites assign a manager/staff role after Clerk invitation acceptance; a verified invited email is required. Existing Clerk accounts can accept invites after signing in. Team admins can edit member names and workspace roles, and disable accounts.

Inventory pages include table and Kanban display modes for products, stock, receipts, deliveries, transfers, adjustments, team, warehouses, categories, and suppliers. Kanban is a grouped overview (by status, inventory health, role, or usage); records are opened from a card for details and available actions. Workflow statuses change via the explicit buttons, rather than by dragging cards.

Included capabilities:

- Products, categories, suppliers, warehouses, and workspace team administration.
- Organization-scoped stock levels by warehouse.
- Receipts; confirming a receipt adds stock and ledger entries atomically.
- Deliveries; pick, pack, and confirmation deducts stock atomically and refuses insufficient quantities.
- Manager-approved warehouse transfers and physical-count adjustments.
- Ledger history and CSV export.
- Dashboard KPIs, movement, variance, turnover, and stock-on-hand reports.
- Responsive dashboard, role-based authorization, and audit events.

## API routes

| Resource | Routes |
|---|---|
| Auth/profile | `GET /api/auth/me`, `GET /api/auth/user`; `POST /api/auth/logout` is informational (use Clerk sign-out) |
| Invitation acceptance | `POST /api/invitations/accept` (authenticated, verified invited email) |
| Dashboard | `GET /api/dashboard/kpis`, `/api/dashboard/summary` |
| Products | `GET/POST /api/products`, `GET/PUT/PATCH/DELETE /api/products/:id`, `GET /api/products/:id/history` |
| Stock | `GET /api/stock`, `/api/stock/:productId`, `/api/stock/location/:warehouseId` |
| Warehouses | `GET/POST /api/warehouses`, `GET/PUT/PATCH /api/warehouses/:id` |
| Categories | `GET /api/categories`, `POST /api/categories`, `PUT/PATCH/DELETE /api/categories/:id` |
| Suppliers | `GET/POST /api/suppliers`, `PUT/PATCH /api/suppliers/:id` |
| Receipts | `GET/POST /api/receipts`, `GET/PUT/PATCH/DELETE /api/receipts/:id`, `POST /api/receipts/:id/confirm` |
| Deliveries | `GET/POST /api/deliveries`, `GET/PUT/PATCH/DELETE /api/deliveries/:id`, `POST /api/deliveries/:id/pick`, `/pack`, `/confirm` |
| Transfers | `GET/POST /api/transfers`, `GET/PUT/PATCH/DELETE /api/transfers/:id`, `POST /api/transfers/:id/approve`, `/confirm` |
| Adjustments | `GET/POST /api/adjustments`, `GET/PUT/PATCH/DELETE /api/adjustments/:id`, `POST /api/adjustments/:id/approve` |
| Ledger/reports | `GET /api/ledger`, `/api/ledger/export`; `GET /api/reports/movements?days=30`, `/variance?days=30`, `/aging`, `/turnover?days=30` |
| Users/audit | `GET /api/users`, `/api/users/:id`, `POST /api/users` (invite), `PUT /api/users/:id` (edit), `PUT /api/users/:id/role`, `DELETE /api/users/:id`, `GET /api/audit` |
| Local demo | `GET/POST/DELETE /api/demo-login` (development only) |

## Checks

Run `npm run typecheck`, `npm run lint`, `npm audit`, and `npm run build`. The application does not currently include automated test files. Exercise Clerk email delivery/invitation acceptance with a configured Clerk instance and real invite inbox before relying on that integration.

## Limits

This is a local-development implementation, not a deployed service with production SLA, compliance certification, SMTP guarantees, file upload, barcoding, or automated backups. Configure TLS, database credentials, backups, Clerk production domains, and invitation policies before a production deployment. No face images are captured or stored. User passwords remain with Clerk.
