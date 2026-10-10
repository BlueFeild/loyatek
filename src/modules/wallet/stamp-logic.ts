// منطق الأختام والهدايا - دوال صافية (من غير داتابيز) عشان نقدر نختبرها
// بدقة. العميل بيبدأ من رصيد، كل ختم بيزوّد 1، ولما الرصيد يوصل لعدد
// الأختام المطلوب بيتحوّل لهدية ويبدأ العدّاد من جديد (والزيادة بتتحفظ)
export function computeStamp(currentBalance: number, stampCount: number) {
  const target = Math.max(1, Math.floor(stampCount));
  const total = Math.max(0, Math.floor(currentBalance)) + 1;
  return {
    balance: total % target,
    rewardsEarned: Math.floor(total / target),
  };
}
