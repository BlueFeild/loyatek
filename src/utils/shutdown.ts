// إيقاف هادي للسيرفر (تدقيق INFRA-003): لما Railway يبعت SIGTERM وقت نشر نسخة جديدة،
// السيرفر يبطّل ياخد طلبات جديدة، يخلّص اللي شغال، والـ jobs ماتبدأش دورة جديدة،
// وبعدين يقفل الاتصال بقاعدة البيانات. قبل كده العملية كانت بتتقفل في نص أي حاجة
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}
