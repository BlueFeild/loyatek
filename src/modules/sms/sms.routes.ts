import { Router } from "express";

// رسايل SMS - بيتبني في modules/sms (الراوترات دي متركّبة في app.ts)
export const smsRouter = Router();
// السوبر أدمن: رصيد الرسايل لكل شركة
export const adminSmsRouter = Router();
