import { createDb } from "@mendpoint/db";
import { TransformerCampaignService } from "./transformer-control-plane.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";
import { createChangeSourceRoutes } from "./change-sources.js";
import { createBillingEconomicsRoutes } from "./billing-economics.js";
import { createDesignPartnerApplicationRoutes } from "./design-partner-applications.js";
import { createPilotSuccessContractRoutes } from "./pilot-success-contracts.js";
import { createMigrationPrReviewRoutes } from "./review-routes.js";
import { createTenantMembershipRoutes } from "./tenant-memberships.js";
import { initializeApiDurableState } from "./production.js";

export function initializeApiRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return initializeApiDurableState(() => {
    const db = createDb();
    const transformerCampaigns = new TransformerCampaignService();
    const transformerExecutions = new TransformerPilotExecutionService();
    return {
      db,
      transformerCampaigns,
      transformerExecutions,
      changeSourceRoutes: createChangeSourceRoutes(),
      billingRoutes: createBillingEconomicsRoutes({ db }),
      designPartnerRoutes: createDesignPartnerApplicationRoutes({ db, env }),
      pilotSuccessRoutes: createPilotSuccessContractRoutes({ db }),
      migrationPrRoutes: createMigrationPrReviewRoutes({ db }),
      tenantMembershipRoutes: createTenantMembershipRoutes({ db }),
    };
  }, env);
}
