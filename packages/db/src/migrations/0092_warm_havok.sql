CREATE TABLE "cloud_upstream_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_url" text NOT NULL,
	"source_instance_id" text NOT NULL,
	"source_instance_fingerprint" text NOT NULL,
	"source_public_key" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"token_status" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"authorized_global_user_id" text,
	"access_token" text,
	"token_id" text,
	"token_expires_at" timestamp with time zone,
	"target_stack_id" text NOT NULL,
	"target_stack_slug" text,
	"target_stack_display_name" text,
	"target_company_id" text NOT NULL,
	"target_origin" text NOT NULL,
	"target_primary_host" text NOT NULL,
	"target_product" text NOT NULL,
	"target_schema_major" integer NOT NULL,
	"target_max_chunk_bytes" integer NOT NULL,
	"pending_state" text,
	"pending_code_verifier" text,
	"pending_redirect_uri" text,
	"pending_token_url" text,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_upstream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_run_id" text,
	"status" text NOT NULL,
	"active_step" text NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"retry_of_run_id" uuid,
	"summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"target_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
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
ALTER TABLE "cloud_upstream_connections" ADD CONSTRAINT "cloud_upstream_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_connection_id_cloud_upstream_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_upstream_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_parent_id_grand_plan_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."grand_plan_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_source_revision_id_document_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grand_plan_nodes" ADD CONSTRAINT "grand_plan_nodes_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_upstream_connections_company_idx" ON "cloud_upstream_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "cloud_upstream_runs_company_created_idx" ON "cloud_upstream_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_upstream_runs_connection_idx" ON "cloud_upstream_runs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "grand_plan_nodes_company_idx" ON "grand_plan_nodes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "grand_plan_nodes_parent_idx" ON "grand_plan_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "grand_plan_nodes_project_idx" ON "grand_plan_nodes" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_grand_plan_node_id_grand_plan_nodes_id_fk" FOREIGN KEY ("grand_plan_node_id") REFERENCES "public"."grand_plan_nodes"("id") ON DELETE set null ON UPDATE no action;