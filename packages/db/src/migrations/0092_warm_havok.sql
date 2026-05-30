CREATE TABLE "grand_plan_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"parent_id" uuid,
	"tier" text NOT NULL,
	"title" text NOT NULL,
	"document_id" uuid,
	"source_revision_id" uuid,
	"reconcile_state" text DEFAULT 'current' NOT NULL,
	"rollup_percent" integer DEFAULT 0 NOT NULL,
	"owner_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "grand_plan_node_id" uuid;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_parent_id_grand_plan_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."grand_plan_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_source_revision_id_document_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grand_plan_nodes_company_idx" ON "grand_plan_nodes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "grand_plan_nodes_parent_idx" ON "grand_plan_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "grand_plan_nodes_project_idx" ON "grand_plan_nodes" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_grand_plan_node_id_grand_plan_nodes_id_fk" FOREIGN KEY ("grand_plan_node_id") REFERENCES "public"."grand_plan_nodes"("id") ON DELETE set null ON UPDATE no action;
