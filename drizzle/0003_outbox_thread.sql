ALTER TABLE "outbox" ADD COLUMN "thread_id" text;--> statement-breakpoint
CREATE INDEX "outbox_thread_pending_idx" ON "outbox" USING btree ("user_id","platform","thread_id","seq") WHERE "outbox"."sent_at" is null and "outbox"."failed_reason" is null;--> statement-breakpoint
-- Живые строки, стоящие в очереди в момент выката, получают диалог из JSON,
-- иначе они ничего не держали бы. Закрытые не трогаем: они не участвуют в захвате.
-- delivery_json всегда пишется JSON.stringify, поэтому приведение к jsonb безопасно
UPDATE "outbox" SET "thread_id" = ("delivery_json"::jsonb ->> 'threadId')
WHERE "sent_at" IS NULL AND "failed_reason" IS NULL;
