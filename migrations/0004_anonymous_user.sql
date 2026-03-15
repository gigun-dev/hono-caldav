-- Add isAnonymous column for better-auth anonymous plugin
ALTER TABLE "user" ADD COLUMN "isAnonymous" INTEGER DEFAULT 0;
