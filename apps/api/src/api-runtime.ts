import { createDb, listOrganizationMemory } from "@mendpoint/db";
import { existsSync } from "node:fs";
import { openGraphLearnDb, type GraphLearnDb } from "@mendpoint/graph-learn";
import { resolveRenamedEnv } from "@mendpoint/shared";
import { TransformerCampaignService } from "./transformer-control-plane.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";
import { createChangeSourceRoutes } from "./change-sources.js";
import { createBillingEconomicsRoutes } from "./billing-economics.js";
import { createDesignPartnerApplicationRoutes } from "./design-partner-applications.js";
import { createPilotSuccessContractRoutes } from "./pilot-success-contracts.js";
import { createMigrationPrReviewRoutes } from "./review-routes.js";
import { createTenantMembershipRoutes } from "./tenant-memberships.js";
import { initializeApiDurableState } from "./production.js";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
} from "@mendpoint/transformer";
import { createAppDbTransformerMissionAuthority } from "./transformer-mission-authority.js";
import { createTransformerMissionRoutes } from "./transformer-mission-routes.js";
import { TransformerMissionService } from "./transformer-missions.js";

export function synchronousPipelineExecutionAllowed(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.MENDPOINT_PROCESS_ROLE?.trim() !== "transformer_coordinator";
}

function liveGraphIfPresent(
  env: Readonly<Record<string, string | undefined>>,
): GraphLearnDb | null {
  const path = env.GRAPH_LEARN_DB?.trim();
  if (!path || !existsSync(path)) return null;
  return openGraphLearnDb(path);
}

export function initializeApiRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return initializeApiDurableState(() => {
    const db = createDb();
    const transformerCampaigns = new TransformerCampaignService();
    const transformerExecutions = new TransformerPilotExecutionService();
    const transformerMissionAuthority = createAppDbTransformerMissionAuthority(db);
    const transformerMissions = new TransformerMissionService(
      transformerCampaigns,
      transformerExecutions,
      transformerMissionAuthority.repositories,
      transformerMissionAuthority.organizations,
      [
        NODE_RUNTIME_18_TO_20_RECIPE,
        NODE_RUNTIME_20_TO_22_RECIPE,
        AWS_SDK_JS_V2_TO_V3_RECIPE,
        STRIPE_NODE_V10_TO_V11_RECIPE,
        GOOGLEAPIS_V25_TO_V26_RECIPE,
        REACT_DOM_17_TO_18_RECIPE,
      ],
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ENVIRONMENT") ?? "",
      () => new Date().toISOString(),
      {
        graph: liveGraphIfPresent(env),
        organizationMemory: (tenantId) => listOrganizationMemory(db, { tenantId }),
      },
    );
    return {
      db,
      transformerCampaigns,
      transformerExecutions,
      transformerMissionRoutes: createTransformerMissionRoutes({
        service: transformerMissions,
        environment: resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ENVIRONMENT"),
      }),
      changeSourceRoutes: createChangeSourceRoutes(),
      billingRoutes: createBillingEconomicsRoutes({ db }),
      designPartnerRoutes: createDesignPartnerApplicationRoutes({ db, env }),
      pilotSuccessRoutes: createPilotSuccessContractRoutes({ db }),
      migrationPrRoutes: createMigrationPrReviewRoutes({ db }),
      tenantMembershipRoutes: createTenantMembershipRoutes({ db }),
    };
  }, env);
}
