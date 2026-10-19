import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { erpIsEmpty, seedErpDemo } from "./erp-demo";

export const erpDemoRouter = Router();
erpDemoRouter.use(requireAuth, requireModule("erp"));

// زرار "بيانات تجريبية" بيظهر بس لو الـ ERP فاضي
erpDemoRouter.get("/", async (req, res) => {
  res.json({ canLoad: await erpIsEmpty(req.auth!.tenantId) });
});

// تحميل البيانات التجريبية - OWNER/ADMIN، ومرة واحدة بس (الشركة لازم تكون فاضية)
const running = new Set<string>();
erpDemoRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const tenantId = req.auth!.tenantId;
  if (running.has(tenantId)) return res.status(409).json({ error: "Demo data is already being loaded — wait a moment." });
  if (!(await erpIsEmpty(tenantId))) {
    return res.status(409).json({ error: "This company already has ERP data. Demo data only loads into an empty company (create a separate demo company)." });
  }
  running.add(tenantId);
  try {
    res.status(201).json({ ok: true, summary: await seedErpDemo(tenantId) });
  } finally {
    running.delete(tenantId);
  }
});
