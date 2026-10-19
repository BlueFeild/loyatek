import { prisma } from "../config/db";

// أي ID جاي من العميل (فرع، عميل، مورد، صنف، حساب، موظف) لازم يكون تبع نفس
// الشركة اللي في التوكن - غير كده شركة ممكن تربط فاتورتها أو أمر الشراء بتاعها
// بحاجة من شركة تانية (أو تزوّد مخزون شركة تانية وهي بتستلم أمر شراء)
export interface OwnedRefs {
  branchIds?: (string | null | undefined)[];
  customerIds?: (string | null | undefined)[];
  supplierIds?: (string | null | undefined)[];
  itemIds?: (string | null | undefined)[];
  accountIds?: (string | null | undefined)[];
  employeeIds?: (string | null | undefined)[];
}

export class NotOwnedError extends Error {
  status = 400;
}

const uniq = (ids: (string | null | undefined)[] | undefined) => [...new Set((ids ?? []).filter((x): x is string => Boolean(x)))];

async function check(
  ids: (string | null | undefined)[] | undefined,
  count: (ids: string[]) => Promise<number>,
  label: string
) {
  const list = uniq(ids);
  if (list.length === 0) return;
  if ((await count(list)) !== list.length) throw new NotOwnedError(`${label} not found`);
}

export async function assertTenantOwns(tenantId: string, refs: OwnedRefs, db: any = prisma): Promise<void> {
  await check(refs.branchIds, (ids) => db.branch.count({ where: { tenantId, id: { in: ids } } }), "Branch");
  await check(refs.customerIds, (ids) => db.customer.count({ where: { tenantId, id: { in: ids } } }), "Customer");
  await check(refs.supplierIds, (ids) => db.supplier.count({ where: { tenantId, id: { in: ids } } }), "Supplier");
  await check(refs.itemIds, (ids) => db.inventoryItem.count({ where: { tenantId, id: { in: ids } } }), "Inventory item");
  await check(refs.accountIds, (ids) => db.account.count({ where: { tenantId, id: { in: ids } } }), "Account");
  await check(refs.employeeIds, (ids) => db.employee.count({ where: { tenantId, id: { in: ids } } }), "Employee");
}
