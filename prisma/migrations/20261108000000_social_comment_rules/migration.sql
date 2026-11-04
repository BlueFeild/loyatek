-- أتمتة تعليقات فيسبوك/انستجرام: كلمة في التعليق ← رسالة خاصة تلقائي (مرة واحدة لكل شخص في كل قاعدة)
CREATE TABLE IF NOT EXISTS "social_comment_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "dmText" TEXT NOT NULL,
    "publicReply" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_comment_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "social_comment_rules_tenantId_idx" ON "social_comment_rules"("tenantId");

CREATE TABLE IF NOT EXISTS "social_comment_rule_hits" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_comment_rule_hits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_comment_rule_hits_ruleId_authorId_key" ON "social_comment_rule_hits"("ruleId", "authorId");
CREATE UNIQUE INDEX IF NOT EXISTS "social_comment_rule_hits_ruleId_commentId_key" ON "social_comment_rule_hits"("ruleId", "commentId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_comment_rules_tenantId_fkey') THEN
    ALTER TABLE "social_comment_rules" ADD CONSTRAINT "social_comment_rules_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_comment_rule_hits_ruleId_fkey') THEN
    ALTER TABLE "social_comment_rule_hits" ADD CONSTRAINT "social_comment_rule_hits_ruleId_fkey"
      FOREIGN KEY ("ruleId") REFERENCES "social_comment_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
