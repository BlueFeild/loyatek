-- رسايل تأكيد احترافية: النصوص الافتراضية الجديدة. الشركات اللي لسه على النص
-- الافتراضي القديم بس هي اللي بتتحدّث (اللي التاجر كتبه بنفسه مابيتلمسش)
ALTER TABLE "booking_settings" ALTER COLUMN "waTemplate" SET DEFAULT E'Hello {name} 👋\nYour booking at {business} is confirmed ✅\n\n🔹 Service: {services}\n📅 Date: {date}\n⏰ Time: {time}\n👤 With: {resource}\n💳 Payment: {payment}\n🔖 Booking ref: {reference}\n\nNeed to reschedule or cancel? Just reply to this message. We look forward to seeing you!';
ALTER TABLE "booking_settings" ALTER COLUMN "waMerchantTemplate" SET DEFAULT E'🔔 New booking — {business}\n\n👤 {name} · {phone}\n🔹 {services}\n🧑‍💼 With: {resource}\n📅 {date} at {time}\n💳 {payment}\n🔖 Ref: {reference}';
ALTER TABLE "catalog_settings" ALTER COLUMN "waMerchantTemplate" SET DEFAULT E'🔔 New order — {mode}\n👤 {name}\n\n{items}\n\n💰 Total: {total}';
ALTER TABLE "catalog_settings" ALTER COLUMN "waCustomerTemplate" SET DEFAULT E'Hello {name} 👋\nThank you for your order! ✅\n\n🍽️ {mode}\n\n{items}\n\n💰 Total: {total}\n⏱️ Ready in about {prep} minutes.\n\nWe''ll let you know if anything changes. Enjoy!';

UPDATE "booking_settings" SET "waTemplate" = E'Hello {name} 👋\nYour booking at {business} is confirmed ✅\n\n🔹 Service: {services}\n📅 Date: {date}\n⏰ Time: {time}\n👤 With: {resource}\n💳 Payment: {payment}\n🔖 Booking ref: {reference}\n\nNeed to reschedule or cancel? Just reply to this message. We look forward to seeing you!'
WHERE "waTemplate" = 'Hi! Your slot is confirmed for today. Show this ticket at check-in — no payment needed in advance.';
UPDATE "booking_settings" SET "waMerchantTemplate" = E'🔔 New booking — {business}\n\n👤 {name} · {phone}\n🔹 {services}\n🧑‍💼 With: {resource}\n📅 {date} at {time}\n💳 {payment}\n🔖 Ref: {reference}'
WHERE "waMerchantTemplate" = E'🔔 New booking\n{name} · {phone}\n{resource}\n{date} at {time}';
UPDATE "catalog_settings" SET "waMerchantTemplate" = E'🔔 New order — {mode}\n👤 {name}\n\n{items}\n\n💰 Total: {total}'
WHERE "waMerchantTemplate" = E'🔔 New Order\n{mode}\n\n{items}\n\nTotal: {total}';
UPDATE "catalog_settings" SET "waCustomerTemplate" = E'Hello {name} 👋\nThank you for your order! ✅\n\n🍽️ {mode}\n\n{items}\n\n💰 Total: {total}\n⏱️ Ready in about {prep} minutes.\n\nWe''ll let you know if anything changes. Enjoy!'
WHERE "waCustomerTemplate" = E'✅ Order confirmed!\n{mode}\n\n{items}\n\nTotal: {total}\nEstimated prep time: {prep} minutes.';
