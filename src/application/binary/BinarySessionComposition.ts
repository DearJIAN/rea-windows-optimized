import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type { AnalysisProvider } from "../../ports/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";
import type { BundleResourceClientFactory } from "./BundleResourceSession.js";

/**
 * Compose one provider-neutral session from deep-provider selection and
 * disjoint auxiliary operation families.
 */
export const composeBinarySession = (
  registry: AnalysisProviderRegistry,
  auxiliaryProviders: readonly AnalysisProvider[] = [],
  bundleResourceFactory?: BundleResourceClientFactory,
  retainedTargetLimit: 2 | 3 | 4 | 5 = 2,
): BinarySession =>
  new BinarySession(
    SessionProviderRouter.selectable(registry, auxiliaryProviders),
    new InvestigationRecords(),
    bundleResourceFactory,
    retainedTargetLimit,
  );
